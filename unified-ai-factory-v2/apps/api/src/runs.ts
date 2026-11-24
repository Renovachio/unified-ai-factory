// Dispatch v2.3: work runs. A run is one model-driven attempt at a LOCAL-folder job, done on a COPY of the project. Claude (identity `dispatch-local-agent`, role
// editor) may start a run, report progress and finish it. Only a human with `job:decide` can approve, and only the exact diff they were shown (digest-bound).
// Everything the model reports is untrusted: Dispatch recomputes the changes itself from the copy and refuses anything outside the plan's write scopes.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { applyChanges, changesDigest, bumpWave, clearScope, copyProject, diffManifests, outOfScope, renderDiff, snapshotFrom, snapshotTree, takeSnapshot, undoSince, validateLocalFolder, validatePlan, writeScope, WorkCopyError, type Change, type Manifest } from "@factory/dispatch-core";
import type { Sql } from "@factory/db";
import { require_, type Actor } from "./auth";
import { readJson } from "./body";
import { problems } from "./problem";
import type { Handler } from "./registry";

const localOnly = () => { if (!process.env.DISPATCH_LOCAL_TOKEN_FILE) throw problems.notFound("no such route"); };
const workDir = (): string => { const home = process.env.DISPATCH_HOME; if (!home) throw problems.notFound("no such route"); const d = join(home, "work"); mkdirSync(d, { recursive: true, mode: 0o700 }); return realpathSync(d); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clean = (s: string, max: number) => Array.from(s, (c) => { const n = c.charCodeAt(0); return n < 32 && c !== "\n" || n === 127 ? " " : c; }).join("").slice(0, max);
const audit = (sql: Sql, actor: Actor, action: string, runId: string, result: string, digest?: string) =>
  sql`INSERT INTO audit_entries (organization_id, actor, action, resource, result, digest) VALUES (${actor.orgId}, ${actor.userId}, ${action}, ${`run:${runId}`}, ${result}, ${digest ?? createHash("sha256").update(`${action}:${runId}`).digest("hex")})`;
/** Remove a run's work copy. The path is rebuilt from the validated run id under the work dir; nothing else is ever deleted. */
export function removeWorkCopy(runId: string): void { if (!UUID.test(runId)) return; const base = workDir(); const d = resolve(base, runId); if (d.startsWith(base + sep) && existsSync(d)) rmSync(d, { recursive: true, force: true }); }

interface RunRow { id: string; job_id: string; status: string; plan: { summary: string; tasks: Array<{ id: string; model: string; writes: string[]; goal: string }> }; workspace_path: string; mode: string; snapshot_dir: string | null; base_manifest: Manifest; changes: Change[] | null; changes_digest: string | null; summary: string | null; failure: string | null; log: Array<{ at: string; note: string }>; created_at: Date; updated_at: Date; local_path: string; project_name: string; organization_id: string }
async function loadRun(sql: Sql, actor: Actor, id: string): Promise<RunRow> {
  if (!UUID.test(id)) throw problems.notFound("no such run");
  const [r] = await sql<RunRow[]>`SELECT w.id, w.job_id, w.status, w.plan, w.workspace_path, w.mode, w.snapshot_dir, w.base_manifest, w.changes, w.changes_digest, w.summary, w.failure, w.log, w.created_at, w.updated_at, w.organization_id, r.local_path, r.name AS project_name
    FROM work_runs w JOIN jobs j ON j.id = w.job_id JOIN repositories r ON r.id = j.repository_id WHERE w.id = ${id} AND w.organization_id = ${actor.orgId}`;
  if (!r) throw problems.notFound("no such run");
  return r;
}

/** The oldest queued local-folder job with no live or applied run: what an agent should pick up next. */
export async function nextWork(sql: Sql, actor: Actor, projectPath?: string) {
  localOnly(); require_(actor, "job:read");
  let only: string | null = null; if (projectPath) { try { only = realpathSync(projectPath); } catch { only = projectPath; } }
  const [j] = await sql<{ id: string; title: string; description: string; repo_id: string; name: string; local_path: string; attempts: number }[]>`
    SELECT j.id, q.title, q.description, r.id AS repo_id, r.name, r.local_path,
           (SELECT count(*)::int FROM work_runs w WHERE w.job_id = j.id) AS attempts
    FROM jobs j JOIN requests q ON q.id = j.request_id JOIN repositories r ON r.id = j.repository_id
    WHERE r.provider = 'local' AND j.state = 'QUEUED' AND r.organization_id = ${actor.orgId} AND (${only}::text IS NULL OR r.local_path = ${only})
      AND NOT EXISTS (SELECT 1 FROM work_runs w WHERE w.job_id = j.id AND w.status IN ('running', 'awaiting_approval', 'applied'))
    ORDER BY j.created_at ASC LIMIT 1`;
  return j ? { job: { id: j.id, title: j.title, request: j.description, attempts: j.attempts }, project: { id: j.repo_id, name: j.name, path: j.local_path } } : { job: null };
}

export async function startRun(sql: Sql, actor: Actor, jobId: string, planRaw: unknown, inPlace = false) {
  localOnly(); require_(actor, "job:create");
  if (!UUID.test(jobId)) throw problems.unprocessable("jobId is malformed");
  const checked = validatePlan(planRaw);
  if (!checked.ok) throw problems.unprocessable("the plan was refused", checked.errors);
  const [job] = await sql<{ id: string; state: string; local_path: string | null; provider: string }[]>`SELECT j.id, j.state, r.local_path, r.provider FROM jobs j JOIN repositories r ON r.id = j.repository_id WHERE j.id = ${jobId} AND r.organization_id = ${actor.orgId}`;
  if (!job) throw problems.notFound("no such job");
  if (job.provider !== "local" || !job.local_path) throw problems.unprocessable("only jobs on local-folder projects can be worked this way");
  if (job.state !== "QUEUED") throw problems.conflict("job-not-queued", `the job is ${job.state}, not QUEUED`);
  const f = validateLocalFolder(job.local_path, { ...(process.env.DISPATCH_HOME ? { dispatchHome: process.env.DISPATCH_HOME } : {}) }); // the folder may have moved or become unsafe since it was added
  if (!f.ok) throw problems.unprocessable(`the project folder is no longer usable: ${f.reason}`);
  const id = randomUUID(); const base = workDir(); const dir = join(base, id); let repo = join(dir, "repo");
  const writes = [...new Set(checked.plan.tasks.flatMap((t) => t.writes))];
  let snap; let snapshotDir: string | null = null; let home = "";
  if (inPlace) {
    home = process.env.DISPATCH_HOME ?? ""; if (writes.length === 0) throw problems.unprocessable("an in-place plan must declare the paths its tasks write");
    const busy = await sql`SELECT 1 FROM work_runs w JOIN jobs j ON j.id = w.job_id WHERE w.mode = 'in_place' AND w.status = 'running' AND j.repository_id = (SELECT repository_id FROM jobs WHERE id = ${jobId}) LIMIT 1`;
    if (busy.length) throw problems.conflict("folder-busy", "another in-place run is already working in this folder");
    try { const s = takeSnapshot(f.path, home); snap = { manifest: s.manifest, skipped: [] as string[] }; snapshotDir = s.dir; repo = s.project; }
    catch (e) { if (e instanceof WorkCopyError) throw problems.unprocessable(e.message); throw e; }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { snap = copyProject(f.path, repo); } catch (e) { removeWorkCopy(id); if (e instanceof WorkCopyError) throw problems.unprocessable(e.message); throw e; }
  }
  const planDigest = `sha256:${createHash("sha256").update(JSON.stringify(checked.plan)).digest("hex")}`;
  try {
    await sql`INSERT INTO work_runs (id, organization_id, job_id, status, plan, plan_digest, workspace_path, mode, snapshot_dir, base_manifest, created_by)
      VALUES (${id}, ${actor.orgId}, ${jobId}, 'running', ${sql.json(checked.plan as never)}, ${planDigest}, ${repo}, ${inPlace ? "in_place" : "copy"}, ${snapshotDir}, ${sql.json(snap.manifest as never)}, ${actor.userId})`;
    if (inPlace) writeScope(home, { runId: id, project: repo, writes });
  } catch (e) {
    removeWorkCopy(id);
    if ((e as { code?: string }).code === "23505") throw problems.conflict("run-already-live", "this job already has a run in progress or awaiting approval");
    throw e;
  }
  await audit(sql, actor, "run.start", id, "ok", planDigest);
  return { status: 201, body: { runId: id, workspace: repo, mode: inPlace ? "in_place" : "copy", ...(inPlace ? { note: "You are editing the REAL folder. Writes outside the plan are blocked. Nothing is applied by you; a human keeps or undoes the result." } : {}), waves: checked.waves, cost: checked.cost, byModel: checked.byModel, files: Object.keys(snap.manifest).length, skipped: snap.skipped.length } };
}

export async function progress(sql: Sql, actor: Actor, runId: string, note: string) {
  localOnly(); require_(actor, "job:create"); const run = await loadRun(sql, actor, runId);
  if (run.status !== "running") throw problems.conflict("run-not-running", `the run is ${run.status}`);
  if (run.mode === "in_place") bumpWave(process.env.DISPATCH_HOME ?? "", run.local_path, runId); // a progress report marks the end of a wave
  const entry = [{ at: new Date().toISOString(), note: clean(note, 500) }];
  // keep at most the newest 200 entries
  await sql`UPDATE work_runs SET log = (SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM (SELECT e, n FROM jsonb_array_elements(log || ${sql.json(entry as never)}) WITH ORDINALITY AS t(e, n) ORDER BY n DESC LIMIT 200) s), updated_at = now() WHERE id = ${runId} AND status = 'running'`;
  return { status: 200, body: { ok: true } };
}

/** The model says it is done. Dispatch measures what actually changed in the copy, enforces the plan's write scopes, and queues the result for a human. */
export async function finishRun(sql: Sql, actor: Actor, runId: string, summaryRaw: string) {
  localOnly(); require_(actor, "job:create"); const run = await loadRun(sql, actor, runId);
  if (run.status !== "running") throw problems.conflict("run-not-running", `the run is ${run.status}`);
  const summary = clean(summaryRaw, 4000);
  let changes: Change[]; let failure: string | null = null;
  const inPlace = run.mode === "in_place";
  try { changes = diffManifests(run.base_manifest, snapshotTree(run.workspace_path).manifest); } catch (e) { changes = []; failure = e instanceof WorkCopyError ? e.message : "the work copy could not be read"; }
  if (!failure) {
    const allowed = run.plan.tasks.flatMap((t) => t.writes);
    const bad = outOfScope(changes, allowed);
    if (bad.length) failure = `changes outside the plan's write scopes were refused: ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? ", …" : ""}`;
    else if (changes.length === 0) failure = "no changes were made";
  }
  if (failure) {
    if (inPlace) failure += " Your folder was already edited: run `dispatch undo` there to restore the snapshot.";
    await sql`UPDATE work_runs SET status = 'failed', failure = ${failure}, summary = ${summary}, updated_at = now() WHERE id = ${runId} AND status = 'running'`;
    removeWorkCopy(runId); if (inPlace) clearScope(process.env.DISPATCH_HOME ?? "", run.local_path, runId); await audit(sql, actor, "run.finish", runId, "failed");
    return { status: 200, body: { status: "failed", failure } };
  }
  // Backstop: the agent must only write inside the copy. If the REAL folder changed during the run, either you edited it or something wrote outside the copy; say so.
  let originalChanged: string[] = [];
  if (!inPlace) try { originalChanged = diffManifests(run.base_manifest, snapshotTree(run.local_path).manifest).map((c) => c.path); } catch { /* unreadable: the apply step re-checks every file anyway */ }
  if (originalChanged.length) {
    const note = [{ at: new Date().toISOString(), note: clean(`WARNING: ${originalChanged.length} file(s) in your project folder changed while this run was in progress (${originalChanged.slice(0, 5).join(", ")}). Either you edited them or something wrote outside the work copy. Approval will refuse to overwrite them.`, 500) }];
    await sql`UPDATE work_runs SET log = log || ${sql.json(note as never)} WHERE id = ${runId}`;
  }
  const digest = changesDigest(changes);
  await sql`UPDATE work_runs SET status = 'awaiting_approval', changes = ${sql.json(changes as never)}, changes_digest = ${digest}, summary = ${summary}, updated_at = now() WHERE id = ${runId} AND status = 'running'`;
  if (inPlace) clearScope(process.env.DISPATCH_HOME ?? "", run.local_path, runId);
  await audit(sql, actor, "run.finish", runId, "ok", digest);
  return { status: 200, body: { status: "awaiting_approval", changes: changes.length, digest, ...(originalChanged.length ? { originalChanged: originalChanged.slice(0, 20) } : {}) } };
}

const view = (r: RunRow, diff?: string) => ({
  id: r.id, jobId: r.job_id, status: r.status, mode: r.mode, project: r.project_name, summary: r.summary, failure: r.failure,
  plan: { summary: r.plan.summary, tasks: r.plan.tasks.map((t) => ({ id: t.id, model: t.model, goal: t.goal, writes: t.writes })) },
  changes: r.changes ?? [], digest: r.changes_digest, log: r.log.slice(-20), createdAt: r.created_at, updatedAt: r.updated_at, ...(diff !== undefined ? { diff } : {}),
});
export async function listRuns(sql: Sql, actor: Actor, status?: string) {
  localOnly(); require_(actor, "job:read");
  const rows = await sql<RunRow[]>`SELECT w.id, w.job_id, w.status, w.plan, w.workspace_path, w.mode, w.snapshot_dir, w.base_manifest, w.changes, w.changes_digest, w.summary, w.failure, w.log, w.created_at, w.updated_at, w.organization_id, r.local_path, r.name AS project_name
    FROM work_runs w JOIN jobs j ON j.id = w.job_id JOIN repositories r ON r.id = j.repository_id
    WHERE w.organization_id = ${actor.orgId} AND (${status ?? null}::text IS NULL OR w.status = ${status ?? null}) ORDER BY w.created_at DESC LIMIT 50`;
  return { items: rows.map((r) => view(r)) };
}
export async function getRun(sql: Sql, actor: Actor, id: string) {
  localOnly(); require_(actor, "job:read"); const r = await loadRun(sql, actor, id);
  const inPlace = r.mode === "in_place";
  const diff = r.status !== "awaiting_approval" || !r.changes ? undefined
    : inPlace ? (r.snapshot_dir && existsSync(r.snapshot_dir) ? renderDiff(r.snapshot_dir, r.local_path, r.changes, 200_000, r.snapshot_dir) : undefined)
    : existsSync(r.workspace_path) ? renderDiff(r.local_path, r.workspace_path, r.changes) : undefined;
  return view(r, diff);
}

/** Human decision. Approval is bound to the digest of the changes they saw; the real folder is touched only here, and never over newer edits of yours. */
export async function decideRun(sql: Sql, actor: Actor, id: string, decision: string, digest: string) {
  localOnly(); require_(actor, "job:decide");
  if (decision !== "approve" && decision !== "reject") throw problems.unprocessable("decision must be approve or reject");
  const r = await loadRun(sql, actor, id);
  if (r.status !== "awaiting_approval" || !r.changes || !r.changes_digest) throw problems.conflict("run-not-awaiting-approval", `the run is ${r.status}`);
  if (decision === "approve" && digest !== r.changes_digest) throw problems.conflict("changes-differ", "the changes are not the ones you reviewed; review the current diff and approve again");
  if (r.mode === "in_place") { // the files are already changed: approve = keep them, reject = restore the snapshot (only if nothing moved since the review)
    const f = validateLocalFolder(r.local_path, { ...(process.env.DISPATCH_HOME ? { dispatchHome: process.env.DISPATCH_HOME } : {}) });
    if (!f.ok) throw problems.unprocessable(`the project folder is no longer usable: ${f.reason}`);
    let now: Change[]; try { now = diffManifests(r.base_manifest, snapshotTree(f.path).manifest); } catch (e) { throw problems.conflict("apply-refused", e instanceof WorkCopyError ? e.message : "the folder could not be read"); }
    if (changesDigest(now) !== r.changes_digest) throw problems.conflict("changes-differ", "the folder changed after the review; review the current diff and decide again");
    if (decision === "reject") {
      if (!r.snapshot_dir || !existsSync(r.snapshot_dir)) throw problems.conflict("snapshot-missing", "the snapshot for this run is gone, so it cannot be restored");
      const u = undoSince(snapshotFrom(f.path, r.snapshot_dir, r.base_manifest));
      if (!u.ok) throw problems.conflict("apply-conflict", `nothing was restored: ${u.conflicts.map((c) => `${c.path} ${c.reason}`).slice(0, 10).join("; ")}`);
    }
  } else if (decision === "approve") {
    const f = validateLocalFolder(r.local_path, { ...(process.env.DISPATCH_HOME ? { dispatchHome: process.env.DISPATCH_HOME } : {}) });
    if (!f.ok) throw problems.unprocessable(`the project folder is no longer usable: ${f.reason}`);
    let res; try { res = applyChanges(f.path, r.workspace_path, r.changes); } catch (e) { if (e instanceof WorkCopyError) throw problems.conflict("apply-refused", e.message); throw e; }
    if (!res.ok) throw problems.conflict("apply-conflict", `nothing was applied: ${res.conflicts.map((c) => `${c.path} ${c.reason}`).slice(0, 10).join("; ")}`);
  }
  const status = decision === "approve" ? "applied" : "rejected";
  const [u] = await sql<{ id: string }[]>`UPDATE work_runs SET status = ${status}, decided_by = ${actor.userId}, decided_at = now(), updated_at = now() WHERE id = ${id} AND status = 'awaiting_approval' RETURNING id`;
  if (!u) throw problems.conflict("run-not-awaiting-approval", "the run changed while you were deciding");
  removeWorkCopy(id); await audit(sql, actor, `run.${decision}`, id, "ok", r.changes_digest);
  return { status: 200, body: { id, status, mode: r.mode, applied: decision === "approve" ? r.changes.length : 0 } };
}

const seg = (req: Request): string[] => new URL(req.url).pathname.split("/").filter(Boolean); // [api, v2, dispatch, runs, <id>, <verb>]
const obj = async (req: Request, max: number): Promise<Record<string, unknown>> => { const { value } = await readJson(req, max); if (!value || typeof value !== "object" || Array.isArray(value)) throw problems.unprocessable("body must be a JSON object"); return value as Record<string, unknown>; };
const text = (b: Record<string, unknown>, k: string): string => { const v = b[k]; if (typeof v !== "string" || v.length === 0) throw problems.unprocessable(`${k} must be a non-empty string`); return v; };

export const runRoutes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  { method: "GET", pattern: /^\/dispatch\/work\/next$/, handler: async ({ req, sql, actor }) => ({ status: 200, body: await nextWork(sql, actor, new URL(req.url).searchParams.get("projectPath") ?? undefined) }) },
  { method: "POST", pattern: /^\/dispatch\/runs$/, handler: async ({ req, sql, actor, mutating, key, maxBody }) => { mutating(); key(); const b = await obj(req, maxBody); return startRun(sql, actor, text(b, "jobId"), b.plan, b.inPlace === true); } },
  { method: "GET", pattern: /^\/dispatch\/runs$/, handler: async ({ req, sql, actor }) => ({ status: 200, body: await listRuns(sql, actor, new URL(req.url).searchParams.get("status") ?? undefined) }) },
  { method: "GET", pattern: /^\/dispatch\/runs\/[^/]+$/, handler: async ({ req, sql, actor }) => ({ status: 200, body: await getRun(sql, actor, seg(req)[4] ?? "") }) },
  { method: "POST", pattern: /^\/dispatch\/runs\/[^/]+\/progress$/, handler: async ({ req, sql, actor, mutating, maxBody }) => { mutating(); return progress(sql, actor, seg(req)[4] ?? "", text(await obj(req, maxBody), "note")); } },
  { method: "POST", pattern: /^\/dispatch\/runs\/[^/]+\/finish$/, handler: async ({ req, sql, actor, mutating, key, maxBody }) => { mutating(); key(); return finishRun(sql, actor, seg(req)[4] ?? "", text(await obj(req, maxBody), "summary")); } },
  { method: "POST", pattern: /^\/dispatch\/runs\/[^/]+\/decision$/, handler: async ({ req, sql, actor, mutating, key, maxBody }) => { mutating(); key(); const b = await obj(req, maxBody); return decideRun(sql, actor, seg(req)[4] ?? "", text(b, "decision"), typeof b.digest === "string" ? b.digest : ""); } },
];
