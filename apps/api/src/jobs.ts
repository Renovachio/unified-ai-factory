import { createHash } from "node:crypto";
import { appendEvent, ConflictError, readEvents, toEnvelope, transitionJob, type Sql } from "@factory/db";
import { validateCreateJob, validateJobResponse, type CreateJobRequest } from "@factory/contracts";
import { InvalidTransitionError, TERMINAL_STATES } from "@factory/domain";
import { revokeJobLeases } from "@factory/scheduler";
import { canonicalJson, digestOf } from "@factory/telemetry";
import type { Actor } from "./auth";
import { ApiProblem, problems } from "./problem";

export const MAX_DESCRIPTION_BYTES = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JsonResult { status: number; body?: unknown; headers?: Record<string, string> }

export const requireIdempotencyKey = (req: Request): string => {
  const k = req.headers.get("idempotency-key");
  if (!k || k.length > 255 || !/^[\x21-\x7e]+$/.test(k)) throw problems.badRequest("Idempotency-Key header is required (1-255 printable ASCII characters)");
  return k;
};

/**
 * POST /jobs. Exactly-once per (actor, route, Idempotency-Key): the key row and the job are created in ONE transaction, so a
 * concurrent duplicate blocks on the unique key and then replays the stored response.
 */
export async function createJob(sql: Sql, actor: Actor, key: string, body: unknown): Promise<JsonResult> {
  const v = validateCreateJob(body);
  if (!v.ok || !v.value) throw problems.unprocessable("request does not match CreateJobRequest", v.errors);
  const input: CreateJobRequest = v.value;
  if (Buffer.byteLength(input.request.description) > MAX_DESCRIPTION_BYTES) throw problems.tooLarge(MAX_DESCRIPTION_BYTES);
  if (!UUID.test(input.repositoryId)) throw problems.notFound("repository not found");
  const requestHash = createHash("sha256").update(canonicalJson(input)).digest("hex");
  const route = "POST /jobs";

  return sql.begin(async (tx) => {
    const [fresh] = await tx<{ id: string }[]>`
      INSERT INTO idempotency_keys (actor_id, route, idempotency_key, request_hash) VALUES (${actor.userId}, ${route}, ${key}, ${requestHash})
      ON CONFLICT (actor_id, route, idempotency_key) DO NOTHING RETURNING id`;
    if (!fresh) {
      const [prior] = await tx<{ request_hash: string; response_status: number | null; response_body: unknown }[]>`
        SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE actor_id = ${actor.userId} AND route = ${route} AND idempotency_key = ${key}`;
      if (!prior || prior.request_hash !== requestHash) throw problems.conflict("idempotency-key-reuse", "Idempotency-Key was already used with a different request body");
      if (prior.response_status === null) throw problems.conflict("idempotency-in-flight", "a request with this Idempotency-Key is still being processed");
      return { status: prior.response_status, body: prior.response_body, headers: { "idempotency-replayed": "true" } };
    }
    // Repository must exist AND belong to the actor's organisation (404, never 403: do not reveal other tenants' resources).
    const [repo] = await tx<{ id: string }[]>`SELECT id FROM repositories WHERE id = ${input.repositoryId} AND organization_id = ${actor.orgId}`;
    if (!repo) throw problems.notFound("repository not found");
    let requestId: string;
    try {
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO requests (repository_id, source, source_external_id, payload_digest, state, requester_id, type, title, description)
        VALUES (${repo.id}, 'api', ${input.request.sourceId ?? null}, ${digestOf(input)}, 'ACCEPTED', ${actor.userId}, ${input.request.type}, ${input.request.title}, ${input.request.description})
        RETURNING id`;
      requestId = (r as { id: string }).id;
    } catch (e) {
      if (String(e).includes("duplicate key")) throw problems.conflict("duplicate-source", "a request with this sourceId already exists for the repository");
      throw e;
    }
    const [job] = await tx<{ id: string; state: string; version: number }[]>`
      INSERT INTO jobs (request_id, repository_id, priority, created_by) VALUES (${requestId}, ${repo.id}, ${input.priority ?? "normal"}, ${actor.userId})
      RETURNING id, state, version`;
    const j = job as { id: string; state: string; version: number };
    await appendEvent(tx, { jobId: j.id, type: "request.received", source: "api", actorId: actor.userId, payload: { request_id: requestId, type: input.request.type } });
    await appendEvent(tx, { jobId: j.id, type: "job.accepted", source: "api", actorId: actor.userId, payload: { priority: input.priority ?? "normal" } });
    await tx`INSERT INTO audit_entries (organization_id, actor, action, resource, result, digest)
      VALUES (${actor.orgId}, ${actor.userId}, 'job.create', ${`job:${j.id}`}, 'ok', ${digestOf({ job: j.id, key })})`;
    const response = { jobId: j.id, state: j.state, version: j.version };
    if (!validateJobResponse(response).ok) throw new Error("response violates job-response.schema.json");
    await tx`UPDATE idempotency_keys SET response_status = 202, response_body = ${tx.json(response as never)}, job_id = ${j.id} WHERE id = ${fresh.id}`;
    return { status: 202, body: response, headers: { location: `/api/v1/jobs/${j.id}`, etag: `"${j.version}"` } };
  });
}

interface JobRow {
  id: string; repository_id: string; state: string; version: number; risk: string; priority: string; head_sha: string | null; base_sha: string | null;
  pr_number: number | null; current_round: number; max_rounds: number; paused_at: Date | null; pause_reason: string | null; created_at: Date; updated_at: Date;
  type?: string; title?: string; description?: string;
}
const summary = (r: JobRow) => ({
  id: r.id, repositoryId: r.repository_id, state: r.state, version: r.version, risk: r.risk, priority: r.priority, prNumber: r.pr_number,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

export async function getJob(sql: Sql, actor: Actor, id: string): Promise<{ detail: Record<string, unknown>; version: number }> {
  if (!UUID.test(id)) throw problems.notFound();
  const [r] = await sql<JobRow[]>`
    SELECT j.id, j.repository_id, j.state, j.version, j.risk, j.priority, j.head_sha, j.base_sha, j.pr_number, j.current_round, j.max_rounds, j.paused_at, j.pause_reason,
           j.created_at, j.updated_at, q.type, q.title, q.description
    FROM jobs j JOIN repositories rp ON rp.id = j.repository_id JOIN requests q ON q.id = j.request_id
    WHERE j.id = ${id} AND rp.organization_id = ${actor.orgId}`;
  if (!r) throw problems.notFound("job not found");
  return {
    version: r.version,
    detail: {
      ...summary(r), headSha: r.head_sha, baseSha: r.base_sha, round: r.current_round, maxRounds: r.max_rounds,
      pausedAt: r.paused_at?.toISOString() ?? null, pauseReason: r.pause_reason,
      // Requester-supplied text is returned as DATA with an explicit marker; it is never policy.
      request: { type: r.type, title: r.title, description: r.description, trust: "untrusted" },
    },
  };
}

const encodeCursor = (c: { t: string; id: string }) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(s: string): { t: string; id: string } {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString()) as { t?: unknown; id?: unknown };
    if (typeof c.t === "string" && typeof c.id === "string" && UUID.test(c.id) && !Number.isNaN(Date.parse(c.t))) return { t: c.t, id: c.id };
  } catch { /* fallthrough */ }
  throw problems.badRequest("invalid cursor");
}

export async function listJobs(sql: Sql, actor: Actor, q: URLSearchParams): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const limitRaw = q.get("limit");
  const limit = limitRaw === null ? 25 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw problems.badRequest("limit must be an integer between 1 and 100");
  const state = q.get("state");
  const repo = q.get("repositoryId");
  if (repo && !UUID.test(repo)) throw problems.badRequest("invalid repositoryId");
  const cursor = q.get("cursor") ? decodeCursor(q.get("cursor") as string) : null;
  const rows = await sql<JobRow[]>`
    SELECT j.id, j.repository_id, j.state, j.version, j.risk, j.priority, j.pr_number, j.created_at, j.updated_at, j.current_round, j.max_rounds, j.head_sha, j.base_sha, j.paused_at, j.pause_reason
    FROM jobs j JOIN repositories rp ON rp.id = j.repository_id
    WHERE rp.organization_id = ${actor.orgId}
      ${state ? sql`AND j.state = ${state}` : sql``}
      ${repo ? sql`AND j.repository_id = ${repo}` : sql``}
      ${cursor ? sql`AND (j.created_at, j.id) < (${new Date(cursor.t)}, ${cursor.id})` : sql``}
    ORDER BY j.created_at DESC, j.id DESC LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(summary), nextCursor: rows.length > limit && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
}

export async function listEvents(sql: Sql, actor: Actor, id: string, q: URLSearchParams) {
  await getJob(sql, actor, id); // org-scoped existence check
  const after = Number(q.get("afterSequence") ?? 0);
  const limit = Number(q.get("limit") ?? 100);
  if (!Number.isInteger(after) || after < 0) throw problems.badRequest("afterSequence must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw problems.badRequest("limit must be 1..1000");
  const events = (await readEvents(sql, id, after, limit)).map(toEnvelope);
  return { events, nextSequence: events.at(-1)?.sequence ?? after };
}

/** POST /jobs/:id/cancel — optimistic concurrency via expectedVersion; idempotent via Idempotency-Key semantics of the state machine. */
export async function cancelJob(sql: Sql, actor: Actor, id: string, body: unknown): Promise<JsonResult> {
  const b = body as { reason?: unknown; expectedVersion?: unknown };
  if (typeof b?.reason !== "string" || b.reason.length < 1 || b.reason.length > 1000 || !Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 1)
    throw problems.unprocessable("body must be {reason: string (1..1000), expectedVersion: integer >= 1}");
  const { detail } = await getJob(sql, actor, id);
  if ((TERMINAL_STATES as readonly string[]).includes(detail.state as string) && detail.state === "CANCELLED") return { status: 202, body: { state: "CANCELLED", version: detail.version } };
  await revokeJobLeases(sql, id, `cancelled by ${actor.userId}`); // revoke capability first
  try {
    const r = await transitionJob(sql, { jobId: id, expectedVersion: b.expectedVersion as number, next: "CANCELLED", actor: actor.userId, reason: b.reason });
    return { status: 202, body: { state: "CANCELLED", version: r.version }, headers: { etag: `"${r.version}"` } };
  } catch (e) {
    if (e instanceof ConflictError) throw problems.conflict("version-conflict", `job version is ${e.actual}, expected ${e.expected}`);
    if (e instanceof InvalidTransitionError) throw problems.conflict("illegal-transition", e.message);
    if (e instanceof ApiProblem) throw e;
    throw e;
  }
}
