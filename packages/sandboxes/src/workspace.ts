import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { findEscapingSymlinks } from "./paths";

export interface Workspace {
  id: string;
  root: string; // realpath, mode 0700
  repoDir: string;
  homeDir: string;
  tmpDir: string;
}

export interface TeardownReport {
  removed: boolean;
  escapingSymlinks: string[];
  error?: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function createWorkspace(baseDir: string, jobId: string): Workspace {
  if (!SAFE_ID.test(jobId)) throw new Error(`unsafe workspace id: ${jobId}`);
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  chmodSync(baseDir, 0o700);
  const root = realpathSync(mkdtempSync(join(realpathSync(baseDir), `${jobId}-`)));
  chmodSync(root, 0o700);
  const ws: Workspace = { id: jobId, root, repoDir: join(root, "repo"), homeDir: join(root, "home"), tmpDir: join(root, "tmp") };
  for (const d of [ws.repoDir, ws.homeDir, ws.tmpDir]) mkdirSync(d, { mode: 0o700 });
  return ws;
}

/** Make everything writable then remove it. Refuses to delete anything that is not a direct child of baseDir. */
export function teardownWorkspace(baseDir: string, ws: Workspace): TeardownReport {
  const base = realpathSync(baseDir);
  const target = existsSync(ws.root) ? realpathSync(ws.root) : resolve(ws.root);
  if (!target.startsWith(base + sep) || resolve(target, "..") !== base) {
    return { removed: false, escapingSymlinks: [], error: "refusing to delete a path that is not a direct child of the workspace base" };
  }
  if (!existsSync(target)) return { removed: true, escapingSymlinks: [] };
  const escaping = findEscapingSymlinks(target);
  try {
    const open = (p: string) => {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return;
      chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
      if (st.isDirectory()) for (const n of readdirSync(p)) open(join(p, n));
    };
    open(target);
    rmSync(target, { recursive: true, force: true }); // unlinks symlinks, never follows them
    return { removed: !existsSync(target), escapingSymlinks: escaping };
  } catch (e) {
    return { removed: false, escapingSymlinks: escaping, error: String(e) };
  }
}

/** Remove leftover workspaces (crash recovery). Returns the removed directory names. */
export function sweepStaleWorkspaces(baseDir: string, olderThanMs: number, now = Date.now()): string[] {
  if (!existsSync(baseDir)) return [];
  const removed: string[] = [];
  baseDir = realpathSync(baseDir);
  for (const name of readdirSync(baseDir)) {
    const p = join(baseDir, name);
    const st = statSync(p);
    if (st.isDirectory() && now - st.mtimeMs >= olderThanMs) {
      const r = teardownWorkspace(baseDir, { id: name, root: p, repoDir: "", homeDir: "", tmpDir: "" });
      if (r.removed) removed.push(name);
    }
  }
  return removed;
}
