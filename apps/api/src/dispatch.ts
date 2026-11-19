// Dispatch v2.3 interaction layer, API side. Additive: every route sits under /api/v2/dispatch, uses the existing authentication, RBAC and tenant scoping,
// and reads or calls the existing job/approval services. Nothing here is a second orchestrator.
import type { Sql } from "@factory/db";
import { require_, type Actor } from "./auth";
import { problems } from "./problem";
import type { Handler } from "./registry";

/** Job states in which work is in flight and a factory shutdown would interrupt it (versus waiting for a human, or finished). */
export const IN_FLIGHT_STATES = ["QUEUED", "INTAKE", "SPECIFYING", "READY", "PROVISIONING", "BUILDING", "GATING", "REVIEWING", "REWORK", "PREMERGE", "MERGING", "MERGED", "POSTMERGE_MONITOR"] as const;
export const WAITING_STATES = ["NEEDS_INFO", "AWAITING_HUMAN"] as const;

export async function factorySummary(sql: Sql, actor: Actor) {
  const [j] = await sql<{ inflight: string; waiting: string; total: string }[]>`
    SELECT count(*) FILTER (WHERE j.state = ANY(${[...IN_FLIGHT_STATES]})) AS inflight, count(*) FILTER (WHERE j.state = ANY(${[...WAITING_STATES]})) AS waiting, count(*) AS total
    FROM jobs j JOIN repositories r ON r.id = j.repository_id WHERE r.organization_id = ${actor.orgId}`;
  const [ap] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM approval_requests a WHERE a.organization_id = ${actor.orgId} AND a.expires_at > now() AND NOT EXISTS (SELECT 1 FROM approval_decisions d WHERE d.request_id = a.id)`;
  const [pr] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM repositories WHERE organization_id = ${actor.orgId}`;
  const [w] = await sql<{ active: string }[]>`
    SELECT count(*) FILTER (WHERE status = 'active' AND heartbeat_at > now() - interval '2 minutes') AS active FROM workers WHERE organization_id = ${actor.orgId}`;
  const n = (x: string | undefined) => Number(x ?? 0);
  return {
    jobs: { inFlight: n(j?.inflight), waitingOnHuman: n(j?.waiting), total: n(j?.total) },
    approvals: { pending: n(j?.waiting) + n(ap?.n), jobDecisions: n(j?.waiting), capabilityApprovals: n(ap?.n) },
    projects: n(pr?.n), workers: { active: n(w?.active) },
  };
}

// ---- shared state: snapshot + durable event feed (DSP-05) ----
/** The global sequence is allocated at INSERT, so commits across different jobs can become visible slightly out of order. The feed therefore re-reads a window behind the
 *  cursor on every call; clients dedupe by event id. (Per-job `sequence` is contiguous and commit-ordered: clients detect per-job gaps and reconcile with a snapshot.) */
export const FEED_LOOKBACK = 100;
export const FEED_MAX_LIMIT = 500;
export interface FeedEvent { eventId: string; globalSeq: number; jobId: string; sequence: number; type: string; at: string; payload: Record<string, unknown> }

export async function readFeed(sql: Sql, actor: Actor, cursor: number, limit: number): Promise<{ events: FeedEvent[]; cursor: number }> {
  const from = Math.max(0, cursor - FEED_LOOKBACK);
  const rows = await sql<{ id: string; global_seq: string; job_id: string; sequence: string; type: string; created_at: Date; payload_redacted: Record<string, unknown> }[]>`
    SELECT e.id, e.global_seq, e.job_id, e.sequence, e.type, e.created_at, e.payload_redacted FROM events e
    JOIN jobs j ON j.id = e.job_id JOIN repositories r ON r.id = j.repository_id
    WHERE r.organization_id = ${actor.orgId} AND e.global_seq > ${from} ORDER BY e.global_seq ASC LIMIT ${Math.min(Math.max(limit, 1), FEED_MAX_LIMIT)}`;
  const events = rows.map((r) => ({ eventId: r.id, globalSeq: Number(r.global_seq), jobId: r.job_id, sequence: Number(r.sequence), type: r.type, at: r.created_at.toISOString(), payload: r.payload_redacted }));
  return { events, cursor: Math.max(cursor, ...events.map((e) => e.globalSeq)) };
}

/** Authoritative state for (re)synchronisation. The cursor is read BEFORE the rows so events committed meanwhile are replayed, never missed. */
export async function snapshot(sql: Sql, actor: Actor) {
  const [c] = await sql<{ m: string | null }[]>`SELECT max(global_seq) AS m FROM events`;
  const jobs = await sql<{ id: string; repository_id: string; repo: string; state: string; version: number; risk: string; pr_number: number | null; title: string; updated_at: Date; paused_at: Date | null }[]>`
    SELECT j.id, j.repository_id, r.owner || '/' || r.name AS repo, j.state, j.version, j.risk, j.pr_number, q.title, j.updated_at, j.paused_at
    FROM jobs j JOIN repositories r ON r.id = j.repository_id JOIN requests q ON q.id = j.request_id
    WHERE r.organization_id = ${actor.orgId} AND (j.state NOT IN ('DONE','CANCELLED','REJECTED') OR j.updated_at > now() - interval '24 hours')
    ORDER BY j.updated_at DESC LIMIT 200`;
  return {
    cursor: Number(c?.m ?? 0), generatedAt: new Date().toISOString(),
    jobs: jobs.map((j) => ({ id: j.id, projectId: j.repository_id, project: j.repo, state: j.state, revision: j.version, risk: j.risk, prNumber: j.pr_number, title: { text: j.title, trust: "untrusted" as const }, paused: j.paused_at !== null, updatedAt: j.updated_at.toISOString() })),
    summary: await factorySummary(sql, actor),
  };
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });

async function* feedStream(sql: Sql, actor: Actor, start: number, signal: AbortSignal, pollMs = 500): AsyncGenerator<string> {
  let cursor = start; const sent = new Set<string>(); let lastSent = Date.now();
  while (!signal.aborted) {
    const { events, cursor: next } = await readFeed(sql, actor, cursor, FEED_MAX_LIMIT);
    let any = false;
    for (const e of events) {
      if (sent.has(e.eventId)) continue;
      sent.add(e.eventId); if (sent.size > 5000) sent.delete(sent.values().next().value as string);
      yield `id: ${e.globalSeq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`; any = true; lastSent = Date.now();
    }
    cursor = next;
    if (!any) { if (Date.now() - lastSent >= 15_000) { yield ": keep-alive\n\n"; lastSent = Date.now(); } await sleep(pollMs, signal); }
  }
}
const parseCursor = (v: string | null): number => { if (v === null || v === "") return 0; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw problems.badRequest("cursor must be a non-negative integer"); return n; };

export const dispatchRoutes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  { method: "GET", pattern: /^\/dispatch\/snapshot$/, handler: async ({ sql, actor }) => { require_(actor, "job:read"); return { status: 200, body: await snapshot(sql, actor) }; } },
  { method: "GET", pattern: /^\/dispatch\/events$/, handler: async ({ req, sql, actor }) => {
    require_(actor, "job:read"); const q = new URL(req.url).searchParams;
    const limit = q.get("limit") === null ? 200 : Number(q.get("limit")); if (!Number.isInteger(limit) || limit < 1) throw problems.badRequest("limit must be a positive integer");
    return { status: 200, body: await readFeed(sql, actor, parseCursor(q.get("cursor")), limit) };
  } },
  { method: "GET", pattern: /^\/dispatch\/events\/stream$/, handler: async ({ req, sql, actor }) => {
    require_(actor, "job:read"); const q = new URL(req.url).searchParams;
    const start = parseCursor(req.headers.get("last-event-id") ?? q.get("cursor")); const it = feedStream(sql, actor, start, req.signal); const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ async pull(c) { try { const { value, done } = await it.next(); if (done) c.close(); else c.enqueue(enc.encode(value)); } catch (e) { c.error(e); } }, async cancel() { await it.return(undefined); } });
    return { status: 200, raw: new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } }) };
  } },
  { method: "GET", pattern: /^\/dispatch\/summary$/, handler: async ({ sql, actor }) => { require_(actor, "job:read"); return { status: 200, body: await factorySummary(sql, actor) }; } },
];
