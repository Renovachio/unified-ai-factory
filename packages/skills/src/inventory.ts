import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { DEFAULT_LIMITS, extractZip, type ArchiveLimits } from "./archive";
import { listTree, treeDigest, type TreeEntry } from "./digest";
import { parseSkillMd } from "./frontmatter";

/** Roots the user has explicitly approved for scanning. Nothing outside these (and nothing hidden-private) is ever read. */
export interface ApprovedRoot { id: string; path: string; scope: "user" | "project" | "upload"; approvedBy: string; revokedAt?: string }
export class InventoryError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "InventoryError"; } }

/** Directories that hold credentials or other users' data: refused even if someone approves a parent or the root itself. */
const PRIVATE_NAMES = new Set([".ssh", ".aws", ".gnupg", ".config", ".netrc", ".git-credentials", ".docker", ".kube", ".npmrc", ".pypirc", ".gcloud", "Library", "Keychains"]);
export function isPrivatePath(p: string, home = homedir()): boolean {
  const abs = resolve(p);
  const rel = relative(home, abs);
  if (!rel.startsWith("..")) { const parts = rel.split(sep); if (parts.some((x) => PRIVATE_NAMES.has(x))) return true; }
  return /^\/(etc|proc|sys|dev|private\/etc|var\/db|root)(\/|$)/.test(abs);
}

export interface SkillPreview {
  rootId: string;
  /** Path relative to the approved root (never an absolute path: other users' filesystem locations are not exposed). */
  relPath: string;
  name: string | null;
  description: string | null;
  license: string | null;
  declaredTools: string[];
  declaredRuntimes: string[];
  declaredNetwork: string[];
  references: string[];
  scripts: string[];
  hooks: string[];
  files: number;
  bytes: number;
  digest: string;
  problems: string[];
}
const HOOKS = [/^\.claude\/settings(\.local)?\.json$/, /^\.mcp\.json$/, /(^|\/)\.git\/hooks\//, /^\.husky\//];
const SCRIPT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|php)$/i;
const asList = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : v.split(",").map((x) => x.trim()).filter(Boolean));

/** Pure read: parses metadata and hashes files. Executes nothing, follows no symlink, reads only inside the approved root. */
export function previewSkillDir(root: ApprovedRoot, dir: string, lim: ArchiveLimits = DEFAULT_LIMITS): SkillPreview {
  if (root.revokedAt) throw new InventoryError("ROOT_REVOKED", "this inventory source was revoked");
  const rootReal = guardRoot(root);
  const real = realpathSync(dir);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new InventoryError("OUTSIDE_ROOT", "directory is outside the approved root");
  const { entries, symlinks } = listTree(real);
  const problems: string[] = symlinks.map((s) => `symlink not followed: ${s}`);
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (entries.length > lim.maxFiles) problems.push(`too many files (${entries.length})`);
  if (total > lim.maxTotalBytes) problems.push(`package too large (${total} bytes)`);
  let fm: ReturnType<typeof parseSkillMd> | null = null;
  const sm = entries.find((e) => e.path === "SKILL.md");
  if (!sm) problems.push("SKILL.md missing");
  else if (sm.size > 200_000) problems.push("SKILL.md too large");
  else { try { fm = parseSkillMd(readFileSync(join(real, "SKILL.md"), "utf8")); } catch (e) { problems.push(`frontmatter: ${(e as Error).message}`); } }
  const refs: string[] = [];
  if (fm) for (const m of fm.body.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) { const r = m[1] as string; if (!/^[a-z][a-z0-9+.-]*:/i.test(r) && !r.startsWith("#")) refs.push(r); }
  const d = fm?.data ?? {};
  return {
    rootId: root.id, relPath: relative(rootReal, real).split(sep).join("/") || ".", name: typeof d.name === "string" ? d.name : null, description: typeof d.description === "string" ? d.description : null, license: typeof d.license === "string" ? d.license : null,
    declaredTools: asList(d["allowed-tools"] ?? d.tools), declaredRuntimes: asList(d.runtimes), declaredNetwork: asList(d.network), references: [...new Set(refs)],
    scripts: entries.filter((e) => SCRIPT.test(e.path)).map((e) => e.path), hooks: entries.filter((e) => HOOKS.some((r) => r.test(e.path))).map((e) => e.path),
    files: entries.length, bytes: total, digest: treeDigest(entries), problems,
  };
}
function guardRoot(root: ApprovedRoot): string {
  if (isPrivatePath(root.path)) throw new InventoryError("PRIVATE_ROOT", "refusing to read a credential or system directory");
  const real = realpathSync(root.path);
  if (isPrivatePath(real)) throw new InventoryError("PRIVATE_ROOT", "root resolves into a credential or system directory");
  return real;
}

/** Lists candidate skill directories (those containing SKILL.md) up to a bounded depth, inside an approved root only. */
export function enumerateSkills(root: ApprovedRoot, maxDepth = 4, maxDirs = 2000): SkillPreview[] {
  if (root.revokedAt) throw new InventoryError("ROOT_REVOKED", "this inventory source was revoked");
  const rootReal = guardRoot(root);
  const found: SkillPreview[] = []; let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || ++visited > maxDirs) return;
    let names: string[]; try { names = readdirSync(dir); } catch { return; }
    if (names.includes("SKILL.md") && lstatSync(join(dir, "SKILL.md")).isFile()) { found.push(previewSkillDir(root, dir)); return; }
    for (const n of names.sort()) {
      if (n.startsWith(".") && n !== ".claude") continue;
      const p = join(dir, n); let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p, depth + 1);
    }
  };
  walk(rootReal, 0);
  return found;
}

export interface ImportResult { digest: string; quarantineDir: string; files: TreeEntry[]; duplicateOf?: string; preview: SkillPreview }
/**
 * Copies an approved-root skill into a read-only quarantine directory named by its digest. Re-importing the same digest never rewrites
 * the existing copy, so approved bytes cannot be replaced by a later import.
 */
export function importToQuarantine(root: ApprovedRoot, dir: string, quarantineBase: string, known: ReadonlySet<string> = new Set()): ImportResult {
  const preview = previewSkillDir(root, dir);
  if (preview.problems.some((p) => !p.startsWith("symlink not followed"))) throw new InventoryError("INVALID_PACKAGE", preview.problems.join("; "));
  if (preview.problems.length) throw new InventoryError("SYMLINK", "package contains symbolic links");
  const dest = join(quarantineBase, preview.digest.replace(":", "-"));
  const files = listTree(realpathSync(dir)).entries;
  if (known.has(preview.digest) || existsSync(dest)) return { digest: preview.digest, quarantineDir: dest, files, duplicateOf: preview.digest, preview };
  mkdirSync(quarantineBase, { recursive: true, mode: 0o700 });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    cpSync(realpathSync(dir), tmp, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true });
    const copied = listTree(tmp);
    if (treeDigest(copied.entries) !== preview.digest) throw new InventoryError("CHANGED_DURING_COPY", "source changed while copying");
    sealTree(tmp, copied.entries);
    renameSync(tmp, dest);
  } catch (e) { try { makeWritable(tmp); rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } throw e; }
  return { digest: preview.digest, quarantineDir: dest, files, preview };
}
function sealTree(root: string, entries: readonly TreeEntry[]) {
  for (const e of entries) chmodSync(join(root, e.path), 0o400);
  const dirs = new Set<string>(); for (const e of entries) { let d = join(root, e.path, ".."); while (d.length >= root.length) { dirs.add(resolve(d)); if (resolve(d) === resolve(root)) break; d = join(d, ".."); } }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) chmodSync(d, 0o500);
}
export function makeWritable(root: string) {
  if (!existsSync(root)) return;
  chmodSync(root, 0o700);
  for (const n of readdirSync(root)) { const p = join(root, n); const st = lstatSync(p); if (st.isDirectory()) makeWritable(p); else if (!st.isSymbolicLink()) chmodSync(p, 0o600); }
}

/** Imports a user-uploaded ZIP into quarantine via the hardened extractor; the archive is never trusted until bounds + path checks pass. */
export function importArchive(zip: Uint8Array, quarantineBase: string, scratchBase: string, uploader: string, known: ReadonlySet<string> = new Set()): ImportResult {
  const scratch = join(scratchBase, `up-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    extractZip(zip, scratch);
    const top = readdirSync(scratch);
    const dir = top.length === 1 && lstatSync(join(scratch, top[0] as string)).isDirectory() && !existsSync(join(scratch, "SKILL.md")) ? join(scratch, top[0] as string) : scratch;
    return importToQuarantine({ id: `upload-${basename(scratch)}`, path: scratch, scope: "upload", approvedBy: uploader }, dir, quarantineBase, known);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
