// Dispatch v2.3 interaction layer, API side. Additive: every route sits under /api/v2/dispatch, uses the existing authentication, RBAC and tenant scoping,
// and reads or calls the existing job/approval services. Nothing here is a second orchestrator.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateLocalFolder } from "@factory/dispatch-core";
import type { Sql } from "@factory/db";
import { require_, type Actor } from "./auth";
import { readJson } from "./body";
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

// ---- read views for projects, approvals, capabilities and model readiness (DSP-06/07/08) ----
const configDir = () => process.env.DISPATCH_CONFIG_DIR ?? join(process.cwd(), "config");
function readConfig(name: string): Record<string, unknown> | null { try { const f = join(configDir(), name); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : null; } catch { return null; } }

export async function listProjects(sql: Sql, actor: Actor) {
  const rows = await sql<{ id: string; provider: string; owner: string; name: string; local_path: string | null; total: string; active: string; waiting: string }[]>`
    SELECT r.id, r.provider, r.owner, r.name, r.local_path, count(j.id) AS total, count(j.id) FILTER (WHERE j.state = ANY(${[...IN_FLIGHT_STATES]})) AS active, count(j.id) FILTER (WHERE j.state = ANY(${[...WAITING_STATES]})) AS waiting
    FROM repositories r LEFT JOIN jobs j ON j.repository_id = r.id WHERE r.organization_id = ${actor.orgId} GROUP BY r.id ORDER BY r.owner, r.name LIMIT 200`;
  return rows.map((r) => ({ id: r.id, name: r.provider === "local" ? r.name : `${r.owner}/${r.name}`, provider: r.provider, ...(r.local_path ? { path: r.local_path } : {}), jobs: { total: Number(r.total), active: Number(r.active), waitingOnHuman: Number(r.waiting) } }));
}

/** Register a folder on this machine as a project. Only in Dispatch local mode (single-user, loopback): a server-side path means nothing, and is dangerous, in a hosted deployment. */
export async function addLocalProject(sql: Sql, actor: Actor, path: string, dispatchHome?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!process.env.DISPATCH_LOCAL_TOKEN_FILE) throw problems.notFound("no such route");
  const f = validateLocalFolder(path, dispatchHome ? { dispatchHome } : {});
  if (!f.ok) throw problems.unprocessable(f.reason);
  const [existing] = await sql<{ id: string; name: string }[]>`SELECT id, name FROM repositories WHERE provider = 'local' AND external_id = ${f.id} AND organization_id = ${actor.orgId}`;
  if (existing) return { status: 200, body: { id: existing.id, name: existing.name, path: f.path, created: false, isGit: f.isGit } };
  const [row] = await sql<{ id: string }[]>`INSERT INTO repositories (organization_id, provider, external_id, owner, name, local_path) VALUES (${actor.orgId}, 'local', ${f.id}, 'local', ${f.name}, ${f.path})
    ON CONFLICT (provider, external_id) DO NOTHING RETURNING id`;
  if (!row) throw problems.conflict("duplicate-project", "that folder is already registered by another organisation");
  await sql`INSERT INTO audit_entries (organization_id, actor, action, resource, result, digest) VALUES (${actor.orgId}, ${actor.userId}, 'project.add_local', ${`project:${row.id}`}, 'ok', ${f.id})`;
  return { status: 201, body: { id: row.id, name: f.name, path: f.path, created: true, isGit: f.isGit } };
}

export async function approvalsInbox(sql: Sql, actor: Actor) {
  const jobs = await sql<{ id: string; repo: string; version: number; title: string; updated_at: Date }[]>`
    SELECT j.id, r.owner || '/' || r.name AS repo, j.version, q.title, j.updated_at FROM jobs j JOIN repositories r ON r.id = j.repository_id JOIN requests q ON q.id = j.request_id
    WHERE r.organization_id = ${actor.orgId} AND j.state = ANY(${[...WAITING_STATES]}) ORDER BY j.updated_at DESC LIMIT 100`;
  const caps = await sql<{ id: string; operation: string; kind: string; slug: string; version: string; target_digest: string; permission_digest: string; expires_at: Date }[]>`
    SELECT a.id, a.operation, v.kind, v.slug, v.version, a.target_digest, a.permission_digest, a.expires_at FROM approval_requests a JOIN skill_versions v ON v.id = a.version_id
    WHERE a.organization_id = ${actor.orgId} AND a.expires_at > now() AND NOT EXISTS (SELECT 1 FROM approval_decisions d WHERE d.request_id = a.id) ORDER BY a.created_at DESC LIMIT 100`;
  return {
    items: [
      ...jobs.map((j) => ({ id: j.id, type: "job-decision" as const, project: j.repo, revision: j.version, title: { text: j.title, trust: "untrusted" as const }, at: j.updated_at.toISOString() })),
      ...caps.map((c) => ({ id: c.id, type: "capability-approval" as const, operation: c.operation, capability: `${c.kind}:${c.slug}@${c.version}`, digest: c.target_digest, permissionDigest: c.permission_digest, expiresAt: c.expires_at.toISOString() })),
    ],
  };
}

/** Skills and agents. Only versions that are ACTIVE are "approved capabilities"; everything else is a labelled proposal/candidate and can never be activated without an exact-digest approval. */
export async function listCapabilities(sql: Sql, actor: Actor, category: "skills" | "agents") {
  const kind = category === "skills" ? "skill" : "agent";
  const rows = await sql<{ id: string; slug: string; version: string; digest: string; state: string; active: boolean; manifest: Record<string, unknown> }[]>`
    SELECT v.id, v.slug, v.version, v.digest, v.state, (a.active_version_id = v.id) AS active, v.manifest FROM skill_versions v
    LEFT JOIN registry_active a ON a.organization_id = v.organization_id AND a.workspace_id = v.workspace_id AND a.kind = v.kind AND a.slug = v.slug
    WHERE v.organization_id = ${actor.orgId} AND v.kind = ${kind} ORDER BY v.created_at DESC LIMIT 200`;
  const roles = (m: Record<string, unknown>) => (Array.isArray(m.roles) ? (m.roles as unknown[]).filter((x) => typeof x === "string") : []);
  return { items: rows.map((r) => ({ id: r.id, slug: r.slug, version: r.version, digest: r.digest, state: r.state, status: r.active ? "approved-active" : "proposal", ...(kind === "agent" ? { roles: roles(r.manifest) } : {}) })) };
}

/** Model/runtime readiness. Three DISTINCT facts, never conflated: available (a runtime is configured), qualified (an approved, unexpired role qualification exists), authorized (provider terms approved / local-only policy). */
export function modelReadiness() {
  const allow = readConfig("runtime-allowlist.json"); const quals = readConfig("model-qualification.json"); const terms = readConfig("provider-terms.json"); const pol = readConfig("inference-policy.json");
  const execs = Array.isArray(allow?.executables) ? (allow.executables as Array<Record<string, unknown>>) : []; const q = Array.isArray(quals?.qualifications) ? (quals.qualifications as Array<Record<string, unknown>>) : [];
  const approvals = Array.isArray(terms?.approvals) ? (terms.approvals as Array<Record<string, unknown>>) : [];
  return {
    configLoaded: allow !== null && quals !== null && terms !== null && pol !== null,
    policy: { allowedInferenceModes: pol?.allowedInferenceModes ?? [], modelApiBillingEnabled: pol?.modelApiBillingEnabled ?? false },
    available: execs.map((e) => ({ id: String(e.id ?? e.path ?? "runtime"), path: String(e.path ?? "") })),
    qualified: q.map((x) => ({ role: String(x.role ?? ""), model: String(x.modelId ?? x.model ?? ""), runtime: String(x.runtime ?? ""), expiresAt: x.expiresAt ?? null })),
    authorizedProviders: approvals.map((a) => String(a.provider ?? a.runtime ?? "")),
    summary: { available: execs.length, qualified: q.length, authorized: approvals.length },
    note: execs.length === 0 ? "No runtime is configured: nothing can run model work." : q.length === 0 ? "No model is qualified for any critical role." : undefined,
  };
}

export const dispatchRoutes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  { method: "GET", pattern: /^\/dispatch\/projects$/, handler: async ({ sql, actor }) => { require_(actor, "job:read"); return { status: 200, body: { items: await listProjects(sql, actor) } }; } },
  { method: "POST", pattern: /^\/dispatch\/projects$/, handler: async ({ req, sql, actor, mutating, key, maxBody }) => {
    require_(actor, "job:create"); mutating(); key();
    const { value } = await readJson(req, maxBody);
    const path = (value as { path?: unknown } | null)?.path; if (typeof path !== "string") throw problems.unprocessable("body must be {path: string}");
    return addLocalProject(sql, actor, path, process.env.DISPATCH_HOME);
  } },
  { method: "GET", pattern: /^\/dispatch\/approvals$/, handler: async ({ sql, actor }) => { require_(actor, "job:read"); return { status: 200, body: await approvalsInbox(sql, actor) }; } },
  { method: "GET", pattern: /^\/dispatch\/capabilities$/, handler: async ({ req, sql, actor }) => {
    require_(actor, "skill:read"); const c = new URL(req.url).searchParams.get("category");
    if (c === "models") return { status: 200, body: modelReadiness() };
    if (c !== "skills" && c !== "agents") throw problems.badRequest("category must be skills, agents or models");
    return { status: 200, body: await listCapabilities(sql, actor, c) };
  } },
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
