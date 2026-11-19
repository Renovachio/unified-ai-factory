import { appendEvent, type Sql } from "@factory/db";
import { digestOf } from "@factory/telemetry";

export const LEASE_TTL_MS = 45_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const MAX_ATTEMPTS = 3;
export const DEFAULT_WORKER_CAPACITY = 1;

const INACTIVE_JOB_STATES = ["DONE", "REJECTED", "CANCELLED", "FAILED", "QUARANTINED"] as const;

export class StaleLeaseError extends Error {
  constructor(readonly taskId: string, readonly reason: string) {
    super(`stale or invalid lease for task ${taskId}: ${reason}`);
    this.name = "StaleLeaseError";
  }
}

export interface TaskLease {
  taskId: string;
  jobId: string;
  stage: string;
  role: string;
  attempt: number;
  /** Monotonic fencing token; doubles as the lease token presented by the worker. */
  leaseToken: number;
  expiresAt: Date;
}

export interface EnqueueInput {
  jobId: string;
  stage: string;
  role: string;
  attempt?: number;
  notBefore?: Date;
}

/**
 * Idempotent per (job, stage, role) regardless of the current attempt number: the scheduler bumps `attempt` in place on
 * retry, so keying on attempt would create a duplicate task after a retry.
 */
export async function enqueueTask(sql: Sql, input: EnqueueInput): Promise<string> {
  const find = async () => (await sql<{ id: string }[]>`SELECT id FROM tasks WHERE job_id = ${input.jobId} AND stage = ${input.stage} AND role = ${input.role} ORDER BY created_at LIMIT 1`)[0]?.id;
  const existing = await find();
  if (existing) return existing;
  await sql`INSERT INTO tasks (job_id, stage, role, attempt, not_before)
    SELECT ${input.jobId}, ${input.stage}, ${input.role}, ${input.attempt ?? 1}, ${input.notBefore ?? new Date()}
    WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE job_id = ${input.jobId} AND stage = ${input.stage} AND role = ${input.role})
    ON CONFLICT DO NOTHING`;
  const id = await find();
  if (!id) throw new Error("enqueueTask: no row");
  return id;
}

export async function registerWorker(sql: Sql, input: { organizationId: string; mode: "local" | "cloud"; capabilities?: Record<string, unknown> }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO workers (organization_id, mode, capability_json, heartbeat_at) VALUES (${input.organizationId}, ${input.mode}, ${sql.json((input.capabilities ?? {}) as never)}, now())
    RETURNING id`;
  if (!row) throw new Error("registerWorker: no row");
  return row.id;
}

export async function setWorkerStatus(sql: Sql, workerId: string, status: "active" | "draining" | "quarantined" | "lost"): Promise<void> {
  await sql`UPDATE workers SET status = ${status} WHERE id = ${workerId}`;
}

/** Expire overdue leases: requeue with a new attempt, or fail when the retry budget is spent. */
export async function expireLeases(sql: Sql, opts: { now?: Date; maxAttempts?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const max = opts.maxAttempts ?? MAX_ATTEMPTS;
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; job_id: string; attempt: number; lease_owner: string; fencing_token: string }[]>`
      SELECT id, job_id, attempt, lease_owner, fencing_token FROM tasks
      WHERE status IN ('leased','running') AND lease_expiry < ${now}
      ORDER BY lease_expiry FOR UPDATE SKIP LOCKED`;
    for (const t of rows) {
      const exhausted = t.attempt >= max;
      if (exhausted) {
        await tx`UPDATE tasks SET status = 'failed', lease_owner = NULL, lease_expiry = NULL, updated_at = ${now} WHERE id = ${t.id}`;
      } else {
        await tx`UPDATE tasks SET status = 'pending', attempt = attempt + 1, lease_owner = NULL, lease_expiry = NULL,
          not_before = ${new Date(now.getTime() + 2 ** t.attempt * 1000)}, updated_at = ${now} WHERE id = ${t.id}`;
      }
      await tx`UPDATE workers SET status = 'lost' WHERE id = ${t.lease_owner} AND (heartbeat_at IS NULL OR heartbeat_at < ${new Date(now.getTime() - 2 * LEASE_TTL_MS)})`;
      await appendEvent(tx, {
        jobId: t.job_id, type: "task.expired", source: "scheduler", attempt: t.attempt, fencingToken: Number(t.fencing_token),
        payload: { task_id: t.id, outcome: exhausted ? "failed_budget_exhausted" : "requeued" },
      });
    }
    return rows.length;
  });
}

export interface ClaimOptions {
  workerId: string;
  roles?: string[];
  ttlMs?: number;
  now?: Date;
  capacity?: number;
}

/**
 * Claim at most one runnable task. Safe under concurrency: FOR UPDATE SKIP LOCKED plus a fencing token
 * drawn from a database sequence (strictly monotonic) so every lease has a unique, increasing token.
 */
export async function claimTask(sql: Sql, opts: ClaimOptions): Promise<TaskLease | null> {
  const now = opts.now ?? new Date();
  const ttl = opts.ttlMs ?? LEASE_TTL_MS;
  await expireLeases(sql, { now });
  return sql.begin(async (tx) => {
    // Serialise claims per worker so the capacity check cannot race with itself.
    const [worker] = await tx<{ status: string }[]>`SELECT status FROM workers WHERE id = ${opts.workerId} FOR UPDATE`;
    if (!worker || worker.status !== "active") return null;
    const [active] = await tx<{ c: number }[]>`SELECT count(*)::int AS c FROM tasks WHERE lease_owner = ${opts.workerId} AND status IN ('leased','running') AND lease_expiry >= ${now}`;
    if ((active?.c ?? 0) >= (opts.capacity ?? DEFAULT_WORKER_CAPACITY)) return null;
    const roles = opts.roles && opts.roles.length > 0 ? opts.roles : null;
    const [t] = await tx<{ id: string; job_id: string; stage: string; role: string; attempt: number }[]>`
      SELECT t.id, t.job_id, t.stage, t.role, t.attempt
      FROM tasks t JOIN jobs j ON j.id = t.job_id
      WHERE t.status = 'pending' AND t.not_before <= ${now}
        AND j.paused_at IS NULL AND j.state NOT IN ${tx([...INACTIVE_JOB_STATES])}
        AND (${roles}::text[] IS NULL OR t.role = ANY(${roles}::text[]))
        AND NOT (t.role = 'builder' AND EXISTS (
          SELECT 1 FROM tasks b WHERE b.job_id = t.job_id AND b.role = 'builder' AND b.id <> t.id AND b.status IN ('leased','running') AND b.lease_expiry >= ${now}))
      ORDER BY CASE j.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.created_at
      LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
    if (!t) return null;
    const expiresAt = new Date(now.getTime() + ttl);
    const [tok] = await tx<{ n: string }[]>`SELECT nextval('fencing_token_seq')::text AS n`;
    const token = Number(tok?.n);
    await tx`UPDATE tasks SET status = 'leased', lease_owner = ${opts.workerId}, assigned_worker_id = ${opts.workerId}, lease_expiry = ${expiresAt},
      fencing_token = ${token}, updated_at = ${now} WHERE id = ${t.id}`;
    await tx`UPDATE workers SET heartbeat_at = ${now} WHERE id = ${opts.workerId}`;
    await appendEvent(tx, {
      jobId: t.job_id, type: "task.claimed", source: "scheduler", actorId: opts.workerId, attempt: t.attempt, fencingToken: token,
      payload: { task_id: t.id, stage: t.stage, role: t.role },
    });
    return { taskId: t.id, jobId: t.job_id, stage: t.stage, role: t.role, attempt: t.attempt, leaseToken: token, expiresAt };
  });
}

interface Fence { taskId: string; workerId: string; leaseToken: number; now?: Date }

/** Lock the task row and verify the presented lease; throws StaleLeaseError otherwise (the rejection is audited by withFence). */
async function assertFence(tx: Parameters<Parameters<Sql["begin"]>[1]>[0], f: Fence) {
  const now = f.now ?? new Date();
  const [t] = await tx<{ id: string; job_id: string; status: string; lease_owner: string | null; lease_expiry: Date | null; fencing_token: string; attempt: number }[]>`
    SELECT id, job_id, status, lease_owner, lease_expiry, fencing_token, attempt FROM tasks WHERE id = ${f.taskId} FOR UPDATE`;
  let reason: string | undefined;
  if (!t) reason = "unknown task";
  else if (t.status !== "leased" && t.status !== "running") reason = `task is ${t.status}`;
  else if (t.lease_owner !== f.workerId) reason = "lease held by another worker";
  else if (Number(t.fencing_token) !== f.leaseToken) reason = "fencing token superseded";
  else if (!t.lease_expiry || t.lease_expiry < now) reason = "lease expired";
  if (reason || !t) throw new StaleLeaseError(f.taskId, reason ?? "unknown");
  return t;
}

/** Runs `fn` after verifying the fence; the rejection audit row is persisted outside the rolled-back transaction. */
async function withFence<T>(sql: Sql, f: Fence, fn: (tx: Parameters<Parameters<Sql["begin"]>[1]>[0], t: Awaited<ReturnType<typeof assertFence>>) => Promise<T>): Promise<T> {
  try {
    return await sql.begin(async (tx) => fn(tx, await assertFence(tx, f)));
  } catch (e) {
    if (e instanceof StaleLeaseError) {
      await sql`INSERT INTO audit_entries (actor, action, resource, result, reason, digest)
        VALUES (${f.workerId}, 'fencing.rejected', ${`task:${f.taskId}`}, 'denied', ${e.reason}, ${digestOf({ task: f.taskId, worker: f.workerId, token: f.leaseToken, reason: e.reason, at: (f.now ?? new Date()).toISOString() })})`;
    }
    throw e;
  }
}

export async function heartbeatTask(sql: Sql, f: Fence & { ttlMs?: number }): Promise<Date> {
  const now = f.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (f.ttlMs ?? LEASE_TTL_MS));
  return withFence(sql, f, async (tx, t) => {
    await tx`UPDATE tasks SET lease_expiry = ${expiresAt}, status = 'running', updated_at = ${now} WHERE id = ${t.id}`;
    await tx`UPDATE workers SET heartbeat_at = ${now} WHERE id = ${f.workerId}`;
    return expiresAt;
  });
}

export async function reportTaskEvent(sql: Sql, f: Fence & { type: string; payload?: Record<string, unknown> }): Promise<{ sequence: number }> {
  return withFence(sql, f, async (tx, t) => {
    const e = await appendEvent(tx, { jobId: t.job_id, type: f.type, source: "worker", actorId: f.workerId, attempt: t.attempt, fencingToken: f.leaseToken, payload: { task_id: t.id, ...(f.payload ?? {}) } });
    return { sequence: e.sequence };
  });
}

export async function completeTask(sql: Sql, f: Fence & { outcome: "succeeded" | "failed"; payload?: Record<string, unknown> }): Promise<void> {
  await withFence(sql, f, async (tx, t) => {
    await tx`UPDATE tasks SET status = ${f.outcome}, lease_owner = NULL, lease_expiry = NULL, updated_at = ${f.now ?? new Date()} WHERE id = ${t.id}`;
    await appendEvent(tx, {
      jobId: t.job_id, type: f.outcome === "succeeded" ? "agent.completed" : "task.failed", source: "worker", actorId: f.workerId,
      attempt: t.attempt, fencingToken: f.leaseToken, payload: { task_id: t.id, ...(f.payload ?? {}) },
    });
  });
}

/** Revoke execution capability for every active task of a job (cancellation / quarantine). Idempotent. */
export async function revokeJobLeases(sql: Sql, jobId: string, reason: string, now: Date = new Date()): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; fencing_token: string; attempt: number }[]>`
      UPDATE tasks SET status = 'cancelled', lease_owner = NULL, lease_expiry = NULL, updated_at = ${now}
      WHERE job_id = ${jobId} AND status IN ('pending','leased','running') RETURNING id, fencing_token, attempt`;
    for (const r of rows) await appendEvent(tx, { jobId, type: "task.revoked", source: "scheduler", attempt: r.attempt, fencingToken: Number(r.fencing_token), payload: { task_id: r.id, reason } });
    return rows.length;
  });
}
