// Dispatch v2.3 interaction layer, API side. Additive: every route sits under /api/v2/dispatch, uses the existing authentication, RBAC and tenant scoping,
// and reads or calls the existing job/approval services. Nothing here is a second orchestrator.
import type { Sql } from "@factory/db";
import { require_, type Actor } from "./auth";
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

export const dispatchRoutes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  { method: "GET", pattern: /^\/dispatch\/summary$/, handler: async ({ sql, actor }) => { require_(actor, "job:read"); return { status: 200, body: await factorySummary(sql, actor) }; } },
];
