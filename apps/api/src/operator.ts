import { appendEvent, ConflictError, transitionJob, type Sql } from "@factory/db";
import { InvalidTransitionError, TERMINAL_STATES } from "@factory/domain";
import { revokeJobLeases, setWorkerStatus } from "@factory/scheduler";
import { digestOf, redactString } from "@factory/telemetry";
import type { Actor } from "./auth";
import { getJob } from "./jobs";
import { problems } from "./problem";

const reasonOf = (b: unknown): string => {
  const r = (b as { reason?: unknown })?.reason;
  if (typeof r !== "string" || r.length < 1 || r.length > 1000) throw problems.unprocessable("reason (1..1000 characters) is required");
  return redactString(r);
};
const versionOf = (b: unknown): number => {
  const v = (b as { expectedVersion?: unknown })?.expectedVersion;
  if (!Number.isInteger(v) || (v as number) < 1) throw problems.unprocessable("expectedVersion (integer >= 1) is required");
  return v as number;
};
const audit = (sql: Sql, actor: Actor, action: string, resource: string, reason: string, result = "ok") =>
  sql`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest) VALUES (${actor.orgId}, ${actor.userId}, ${action}, ${resource}, ${result}, ${reason.slice(0, 500)}, ${digestOf({ action, resource, actor: actor.userId, reason })})`;

/** Pause = stop NEW work (claims skip paused jobs; running leases finish at their safe boundary). Resumable, audited. */
export async function pauseJob(sql: Sql, actor: Actor, id: string, body: unknown) {
  const reason = reasonOf(body); const expected = versionOf(body);
  const { detail, version } = await getJob(sql, actor, id);
  if (version !== expected) throw problems.conflict("version-conflict", `job version is ${version}, expected ${expected}`);
  if ((TERMINAL_STATES as readonly string[]).includes(detail.state as string)) throw problems.conflict("terminal", "job is already finished");
  if (detail.pausedAt) return { status: 202, body: { paused: true, pausedAt: detail.pausedAt } };
  await sql.begin(async (tx) => {
    await tx`UPDATE jobs SET paused_at = now(), pause_reason = ${reason} WHERE id = ${id} AND paused_at IS NULL`;
    await appendEvent(tx, { jobId: id, type: "job.paused", source: "api", actorId: actor.userId, payload: { reason } });
    await audit(tx as unknown as Sql, actor, "job.pause", `job:${id}`, reason);
  });
  return { status: 202, body: { paused: true } };
}

export async function resumeJob(sql: Sql, actor: Actor, id: string, body: unknown) {
  const reason = reasonOf(body); const expected = versionOf(body);
  const { detail, version } = await getJob(sql, actor, id);
  if (version !== expected) throw problems.conflict("version-conflict", `job version is ${version}, expected ${expected}`);
  if (!detail.pausedAt) return { status: 202, body: { paused: false } };
  await sql.begin(async (tx) => {
    await tx`UPDATE jobs SET paused_at = NULL, pause_reason = NULL WHERE id = ${id}`;
    await appendEvent(tx, { jobId: id, type: "job.resumed", source: "api", actorId: actor.userId, payload: { reason } });
    await audit(tx as unknown as Sql, actor, "job.resume", `job:${id}`, reason);
  });
  return { status: 202, body: { paused: false } };
}

/** Incident response: capabilities are revoked FIRST, then the job moves to QUARANTINED (never auto-resumes; needs a security officer). */
export async function quarantineJob(sql: Sql, actor: Actor, id: string, body: unknown) {
  const reason = reasonOf(body); const expected = versionOf(body);
  await getJob(sql, actor, id);
  await revokeJobLeases(sql, id, `quarantined: ${reason}`);
  try {
    const r = await transitionJob(sql, { jobId: id, expectedVersion: expected, next: "QUARANTINED", actor: actor.userId, reason });
    await sql.begin(async (tx) => { await appendEvent(tx, { jobId: id, type: "security.quarantined", source: "api", actorId: actor.userId, payload: { reason } }); await audit(tx as unknown as Sql, actor, "job.quarantine", `job:${id}`, reason); });
    return { status: 202, body: { state: "QUARANTINED", version: r.version } };
  } catch (e) {
    if (e instanceof ConflictError) throw problems.conflict("version-conflict", `job version is ${e.actual}, expected ${e.expected}`);
    if (e instanceof InvalidTransitionError) throw problems.conflict("illegal-transition", e.message);
    throw e;
  }
}

/** Only a security officer/admin can release a quarantined job, and only to FAILED or CANCELLED (never straight back to work or to merge). */
export async function releaseQuarantine(sql: Sql, actor: Actor, id: string, body: unknown) {
  const reason = reasonOf(body); const expected = versionOf(body);
  const to = (body as { to?: unknown })?.to;
  if (to !== "FAILED" && to !== "CANCELLED") throw problems.unprocessable('"to" must be FAILED or CANCELLED');
  await getJob(sql, actor, id);
  try {
    const r = await transitionJob(sql, { jobId: id, expectedVersion: expected, next: to, actor: actor.userId, reason });
    await audit(sql, actor, "job.quarantine-release", `job:${id}`, `${to}: ${reason}`);
    return { status: 202, body: { state: to, version: r.version } };
  } catch (e) {
    if (e instanceof ConflictError) throw problems.conflict("version-conflict", `job version is ${e.actual}, expected ${e.expected}`);
    if (e instanceof InvalidTransitionError) throw problems.conflict("illegal-transition", e.message);
    throw e;
  }
}

export async function workerAction(sql: Sql, actor: Actor, workerId: string, action: string, body: unknown) {
  const map: Record<string, "draining" | "quarantined" | "active"> = { drain: "draining", quarantine: "quarantined", activate: "active" };
  const status = map[action];
  if (!status) throw problems.notFound("no such worker action");
  const reason = reasonOf(body);
  if (!/^[0-9a-f-]{36}$/i.test(workerId)) throw problems.notFound("worker not found");
  const [w] = await sql<{ id: string; status: string }[]>`SELECT id, status FROM workers WHERE id = ${workerId} AND organization_id = ${actor.orgId}`;
  if (!w) throw problems.notFound("worker not found");
  if (w.status === "quarantined" && status === "active" && actor.role !== "security_officer" && actor.role !== "admin") throw problems.forbidden("only a security officer or admin may re-activate a quarantined worker");
  await setWorkerStatus(sql, workerId, status);
  let revoked = 0;
  if (status === "quarantined") {
    // Make held leases expire immediately: the scheduler sweeper requeues them with a NEW fencing token, so this worker is fenced out.
    const rows = await sql`UPDATE tasks SET lease_expiry = now() - interval '1 second' WHERE lease_owner = ${workerId} AND status IN ('leased','running') RETURNING id`;
    revoked = rows.length;
  } // draining only stops NEW claims; running work finishes at its safe boundary
  await audit(sql, actor, `worker.${action}`, `worker:${workerId}`, reason);
  return { status: 202, body: { workerId, status, leasesRevoked: revoked } };
}
