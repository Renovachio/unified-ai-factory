import type { AgentRunRequest, AgentRunResult, AgentRuntimeAdapter, EventSink } from "./types";

export type RouteOutcome =
  | { status: "completed"; adapterId: string; result: AgentRunResult; attempted: string[] }
  | { status: "paused"; reason: "no-eligible-runtime" | "quota-exhausted" | "all-failed"; attempted: string[]; detail: string };

export interface RouterOptions {
  /** Ordered, operator-approved runtimes. The router can ONLY ever pick from this list; there is no API/metered adapter anywhere. */
  candidates: AgentRuntimeAdapter[];
  /** Roles for which falling back from a failed/limited primary to the next candidate is permitted (quality gate). Default: none. */
  fallbackRoles?: ReadonlySet<string>;
  /** Never silently downgrade for these roles regardless of fallbackRoles (blueprint: high-risk builder/reviewer). */
  neverDowngradeRoles?: ReadonlySet<string>;
}

const wait = async (a: AgentRuntimeAdapter, runId: string) => { let s = await a.status(runId); while (s.exitStatus === "running") { await new Promise((r) => setTimeout(r, 5)); s = await a.status(runId); } return s as AgentRunResult; };

/**
 * Picks an eligible runtime and applies the fallback rules: unavailable or quota-exhausted primaries fall back ONLY to the next approved
 * candidate and ONLY for roles the operator allowed; otherwise the router reports `paused` so a human or a later retry decides.
 * Quota exhaustion never leads to credits, API keys or any metered endpoint.
 */
export async function routeRun(o: RouterOptions, request: AgentRunRequest, events: EventSink): Promise<RouteOutcome> {
  const attempted: string[] = [];
  const mayFallback = (o.fallbackRoles?.has(request.role) ?? false) && !(o.neverDowngradeRoles?.has(request.role) ?? false);
  let quota = false;
  let lastDetail = "no candidate was available";
  for (const [i, a] of o.candidates.entries()) {
    if (i > 0 && !mayFallback) break;
    const p = await a.probe();
    if (!p.available) { lastDetail = `${a.id}: ${p.reason} (${p.detail})`; attempted.push(`${a.id}:unavailable`); continue; }
    attempted.push(a.id);
    let result: AgentRunResult;
    try { result = await wait(a, await a.start(request, events)); } catch (e) { lastDetail = `${a.id}: ${e instanceof Error ? e.message : "error"}`; continue; }
    if (result.exitStatus === "succeeded") return { status: "completed", adapterId: a.id, result, attempted };
    if (result.failureCode === "rate-limited") { quota = true; lastDetail = `${a.id}: rate-limited`; continue; }
    lastDetail = `${a.id}: ${result.exitStatus}${result.failureCode ? ` (${result.failureCode})` : ""}`;
    if (!mayFallback) break;
  }
  return { status: "paused", reason: quota ? "quota-exhausted" : attempted.length === 0 || attempted.every((x) => x.endsWith(":unavailable")) ? "no-eligible-runtime" : "all-failed", attempted, detail: lastDetail };
}
