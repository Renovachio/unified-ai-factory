import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyChanges, copyProject, diffManifests, renderDiff, snapshotTree, type ApplyResult, type Change, type CopyLimits, type Manifest, DEFAULT_COPY_LIMITS } from "./workcopy";

/**
 * In-place work safety net. When an agent works directly in your folder there is no approval step, so Dispatch first records the folder's state
 * (a snapshot copy under its own data folder, same exclusions and limits as a work copy: no .git, .env, keys or symlinks). Afterwards you can see
 * exactly what changed since then, and undo it, without overwriting anything you changed after the agents did.
 */
export interface SnapshotInfo { id: string; project: string; createdAt: string; dir: string; manifest: Manifest }
const KEEP = 3;
export const projectKey = (project: string) => createHash("sha256").update(realpathSync(project)).digest("hex").slice(0, 16);
const root = (home: string, project: string) => join(home, "snapshots", projectKey(project));

export function takeSnapshot(project: string, home: string, limits: CopyLimits = DEFAULT_COPY_LIMITS): SnapshotInfo {
  const base = root(home, project); mkdirSync(base, { recursive: true, mode: 0o700 });
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`; const dir = join(base, id, "files");
  const snap = copyProject(project, dir, limits);
  const info: SnapshotInfo = { id, project: realpathSync(project), createdAt: new Date().toISOString(), dir, manifest: snap.manifest };
  writeFileSync(join(base, id, "meta.json"), JSON.stringify({ id, project: info.project, createdAt: info.createdAt, manifest: info.manifest }), { mode: 0o600 });
  for (const old of readdirSync(base).sort().slice(0, -KEEP)) rmSync(join(base, old), { recursive: true, force: true }); // keep the newest few
  return info;
}
export function latestSnapshot(project: string, home: string): SnapshotInfo | null {
  const base = root(home, project); if (!existsSync(base)) return null;
  const ids = readdirSync(base).sort(); const id = ids[ids.length - 1]; if (!id) return null;
  try { const m = JSON.parse(readFileSync(join(base, id, "meta.json"), "utf8")) as { id: string; project: string; createdAt: string; manifest: Manifest }; return { ...m, dir: join(base, id, "files") }; } catch { return null; }
}
/** Rebuild a snapshot handle from what a run recorded (the baseline manifest and where the pre-run copy lives). */
export const snapshotFrom = (project: string, dir: string, manifest: Manifest): SnapshotInfo => ({ id: "run", project: realpathSync(project), createdAt: "", dir, manifest });
export const changesSince = (s: SnapshotInfo): Change[] => diffManifests(s.manifest, snapshotTree(s.project).manifest);
/** Unified diff of what changed since the snapshot (before = snapshot, after = your folder now). */
export const renderChangesSince = (s: SnapshotInfo, changes: Change[]): string => renderDiff(s.dir, s.project, changes, 200_000, s.dir);
/** Restore the snapshot: apply the REVERSE diff. Refuses (and changes nothing) if a file differs from what the diff just measured. */
export function undoSince(s: SnapshotInfo): ApplyResult & { reverted?: number } {
  const reverse = diffManifests(snapshotTree(s.project).manifest, s.manifest);
  if (reverse.length === 0) return { ok: true, applied: 0, reverted: 0 };
  const r = applyChanges(s.project, s.dir, reverse); return r.ok ? { ...r, reverted: r.applied } : r;
}

/** The plan's write scope for an in-place run. The API writes it when the plan is accepted and removes it when the run ends; the write guard reads it. */
export interface ActiveScope { runId: string; project: string; writes: string[] }
export const scopeFile = (home: string, project: string): string => join(home, "active", `${projectKey(project)}.json`);
export function writeScope(home: string, scope: ActiveScope): string {
  const f = scopeFile(home, scope.project); mkdirSync(join(home, "active"), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify(scope), { mode: 0o600 }); return f;
}
export function clearScope(home: string, project: string, runId?: string): void {
  const f = scopeFile(home, project); try { if (runId) { const cur = JSON.parse(readFileSync(f, "utf8")) as ActiveScope; if (cur.runId !== runId) return; } rmSync(f, { force: true }); } catch { /* none */ }
}
