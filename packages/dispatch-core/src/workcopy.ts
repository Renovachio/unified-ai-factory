import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { safeRelPath, withinWrites } from "./plan";

/** Names never copied into a work copy (and therefore never changed or applied back): VCS data, dependencies, secrets, caches. */
const SKIP_NAME = /^(\.git|node_modules|\.DS_Store|\.next|\.venv|__pycache__|\.cache|\.env|\.env\..*|\.npmrc|\.netrc|id_rsa.*|.*\.pem|.*\.key)$/;
export interface CopyLimits { maxFiles: number; maxBytes: number; maxFileBytes: number }
export const DEFAULT_COPY_LIMITS: CopyLimits = { maxFiles: 5000, maxBytes: 200 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024 };

/** relative path -> sha256 of contents. */
export type Manifest = Record<string, string>;
export interface Snapshot { manifest: Manifest; skipped: string[]; bytes: number }
export class WorkCopyError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "WorkCopyError"; } }

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Walk a tree: regular files only. Symlinks, sockets and skipped names are listed in `skipped` and are never followed. */
export function snapshotTree(root: string, limits: CopyLimits = DEFAULT_COPY_LIMITS): Snapshot {
  const base = realpathSync(root); const manifest: Manifest = {}; const skipped: string[] = []; let bytes = 0; let count = 0;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const r = rel ? `${rel}/${name}` : name; const p = join(dir, name);
      if (SKIP_NAME.test(name)) { skipped.push(r); continue; }
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) { skipped.push(r); continue; }
      if (st.isDirectory()) { walk(p, r); continue; }
      if (st.size > limits.maxFileBytes) { skipped.push(r); continue; }
      if (++count > limits.maxFiles) throw new WorkCopyError("too-many-files", `project has more than ${limits.maxFiles} files; point Dispatch at a smaller folder`);
      bytes += st.size; if (bytes > limits.maxBytes) throw new WorkCopyError("too-large", `project is larger than ${Math.round(limits.maxBytes / 1048576)} MB; point Dispatch at a smaller folder`);
      manifest[r] = sha(p);
    }
  };
  walk(base, "");
  return { manifest, skipped, bytes };
}

/** Copy the project into an empty destination. Returns the BASE snapshot (what the original looked like when copied). */
export function copyProject(src: string, dest: string, limits: CopyLimits = DEFAULT_COPY_LIMITS): Snapshot {
  const snap = snapshotTree(src, limits); const s = realpathSync(src);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (readdirSync(dest).length) throw new WorkCopyError("dest-not-empty", "work copy destination must be empty");
  for (const rel of Object.keys(snap.manifest)) {
    const to = join(dest, rel); mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(s, rel), to);
    if (sha(to) !== snap.manifest[rel]) throw new WorkCopyError("changed-while-copying", `${rel} changed while copying; try again`);
  }
  return snap;
}

export interface Change { path: string; kind: "add" | "modify" | "delete"; baseHash?: string; newHash?: string }
export function diffManifests(base: Manifest, now: Manifest): Change[] {
  const out: Change[] = [];
  for (const [p, h] of Object.entries(now)) { const b = base[p]; if (b === undefined) out.push({ path: p, kind: "add", newHash: h }); else if (b !== h) out.push({ path: p, kind: "modify", baseHash: b, newHash: h }); }
  for (const [p, h] of Object.entries(base)) if (now[p] === undefined) out.push({ path: p, kind: "delete", baseHash: h });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Changes that fall outside the declared write scopes (an agent did something the plan did not allow) or touch unsafe paths. */
export function outOfScope(changes: Change[], allowedWrites: string[]): string[] {
  return changes.filter((c) => !safeRelPath(c.path) || !withinWrites(c.path, allowedWrites)).map((c) => c.path);
}

/** Digest of exactly what a human is asked to approve (paths, kinds and content hashes): an approval is bound to this value. */
export const changesDigest = (changes: Change[]): string => `sha256:${createHash("sha256").update(JSON.stringify(changes.map((c) => [c.path, c.kind, c.baseHash ?? null, c.newHash ?? null]))).digest("hex")}`;

export type ApplyResult = { ok: true; applied: number } | { ok: false; conflicts: Array<{ path: string; reason: string }> };

/**
 * Apply approved changes to the REAL folder. All-or-nothing preflight: every path must be safe, must not traverse a symlink, and the real file must still
 * match what the copy started from (modify/delete) or be absent (add). Any mismatch applies NOTHING, so the human's newer edits are never overwritten.
 * New contents are read from the work copy and verified against the approved hash immediately before writing.
 */
export function applyChanges(realDir: string, copyDir: string, changes: Change[]): ApplyResult {
  const real = realpathSync(realDir); const copy = realpathSync(copyDir); const conflicts: Array<{ path: string; reason: string }> = [];
  const target = (rel: string): string => {
    if (!safeRelPath(rel)) throw new WorkCopyError("unsafe-path", `unsafe path ${rel}`);
    const full = resolve(real, rel); if (!full.startsWith(real + sep)) throw new WorkCopyError("unsafe-path", `path escapes the project: ${rel}`);
    // no symlink anywhere along the path inside the project
    let cur = real; for (const seg of rel.split("/")) { cur = join(cur, seg); if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) throw new WorkCopyError("symlink", `${rel} goes through a symlink`); }
    return full;
  };
  for (const c of changes) {
    try {
      const full = target(c.path); const exists = existsSync(full);
      if (c.kind === "add") { if (exists) conflicts.push({ path: c.path, reason: "now exists in your folder" }); }
      else if (!exists) conflicts.push({ path: c.path, reason: "no longer exists in your folder" });
      else if (!statSync(full).isFile()) conflicts.push({ path: c.path, reason: "is not a regular file" });
      else if (sha(full) !== c.baseHash) conflicts.push({ path: c.path, reason: "was changed in your folder after the work copy was made" });
      if (c.kind !== "delete") {
        const src = join(copy, c.path);
        if (!existsSync(src) || lstatSync(src).isSymbolicLink() || sha(src) !== c.newHash) conflicts.push({ path: c.path, reason: "work copy no longer matches what was approved" });
      }
    } catch (e) { conflicts.push({ path: c.path, reason: e instanceof WorkCopyError ? e.message : "cannot be checked" }); }
  }
  if (conflicts.length) return { ok: false, conflicts };
  for (const c of changes) {
    const full = target(c.path);
    if (c.kind === "delete") { unlinkSync(full); continue; }
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.dispatch-${randomBytes(4).toString("hex")}`; const data = readFileSync(join(copy, c.path));
    const fd = openSync(tmp, "wx", 0o644); try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(full)) { try { chmodSync(tmp, statSync(full).mode & 0o777); } catch { /* keep default */ } }
    try { renameSync(tmp, full); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  }
  return { ok: true, applied: changes.length };
}

const looksBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);
/**
 * Human-readable unified diff of the changes, for the approval screen. Original text comes from the real folder (only when it still matches the
 * work copy's base hash, otherwise the file is flagged as changed since), new text from the work copy. Size-capped; binary files are summarised.
 */
export function renderDiff(realDir: string, copyDir: string, changes: Change[], maxBytes = 200_000, scratchDir?: string): string {
  const real = realpathSync(realDir); const copy = realpathSync(copyDir); let out = ""; let truncated = false;
  for (const c of changes) {
    if (out.length >= maxBytes) { truncated = true; break; }
    const a = join(real, c.path); const b = join(copy, c.path);
    const before = c.kind === "add" ? null : existsSync(a) && !lstatSync(a).isSymbolicLink() ? readFileSync(a) : null;
    const after = c.kind === "delete" ? null : existsSync(b) && !lstatSync(b).isSymbolicLink() ? readFileSync(b) : null;
    if (before && createHash("sha256").update(before).digest("hex") !== c.baseHash) { out += `~ ${c.path}: changed in your folder since the work copy was made (diff not shown)\n`; continue; }
    if ((before && looksBinary(before)) || (after && looksBinary(after))) { out += `${c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~"} ${c.path}: binary file (${c.kind})\n`; continue; }
    const tmp = join(scratchDir ? realpathSync(scratchDir) : copy, `.diff-${randomBytes(4).toString("hex")}`); // scratch files live in a Dispatch-owned folder, never in the project
    try {
      const fa = `${tmp}.a`; const fb = `${tmp}.b`;
      writeFileSync(fa, before ?? ""); writeFileSync(fb, after ?? "");
      const r = spawnSync("/usr/bin/diff", ["-u", "--label", c.kind === "add" ? "/dev/null" : `a/${c.path}`, "--label", c.kind === "delete" ? "/dev/null" : `b/${c.path}`, fa, fb], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      out += `${r.stdout}\n`;
    } finally { rmSync(`${tmp}.a`, { force: true }); rmSync(`${tmp}.b`, { force: true }); }
  }
  return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n[diff truncated]\n` : truncated ? `${out}\n[diff truncated]\n` : out;
}
