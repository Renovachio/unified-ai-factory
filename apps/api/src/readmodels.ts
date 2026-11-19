import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { Sql } from "@factory/db";
import { redact, stripBillingKeys } from "@factory/telemetry";
import type { Actor } from "./auth";
import { getJob } from "./jobs";
import { problems } from "./problem";

export interface TimelineEntry {
  ts: string;
  source: "transition" | "event" | "task" | "agent_run" | "artifact" | "candidate" | "gate" | "review" | "policy" | "approval" | "pull_request" | "merge" | "audit";
  id: string;
  kind: string;
  summary: string;
  data: Record<string, unknown>;
}

const RANK: Record<TimelineEntry["source"], number> = { transition: 0, event: 1, task: 2, agent_run: 3, artifact: 4, candidate: 5, gate: 6, review: 7, policy: 8, approval: 9, pull_request: 10, merge: 11, audit: 12 };
const iso = (d: Date) => d.toISOString();
/** Tie-break within the same millisecond: event sequence / transition version keep causal order. */
const orderKey = (e: TimelineEntry) => Number((e.data as { sequence?: number; version?: number }).sequence ?? (e.data as { version?: number }).version ?? 0);
const clean = <T>(v: T): T => stripBillingKeys(redact(v));

/**
 * Reconstructs a job's COMPLETE history from the durable rows (transitions, events, tasks, agent runs, artifacts, candidates, gate/review/policy
 * evidence, approvals, PRs, merges, audit). Everything is redacted again on the way out and no price/cost fields can appear.
 */
export async function jobTimeline(sql: Sql, actor: Actor, jobId: string, q: URLSearchParams): Promise<{ job: Record<string, unknown>; entries: TimelineEntry[]; nextCursor: string | null; statePath: string[] }> {
  const { detail } = await getJob(sql, actor, jobId); // org-scoped existence + summary
  const limit = Number(q.get("limit") ?? 500);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw problems.badRequest("limit must be 1..2000");
  const all: TimelineEntry[] = [];
  const add = (e: TimelineEntry) => all.push(e);

  for (const r of await sql<{ id: string; from_state: string; to_state: string; version: number; actor_id: string; evidence_digest: string | null; created_at: Date }[]>`SELECT id, from_state, to_state, version, actor_id, evidence_digest, created_at FROM job_transitions WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "transition", id: r.id, kind: "job.transition", summary: `${r.from_state} -> ${r.to_state}`, data: { from: r.from_state, to: r.to_state, version: r.version, actor: r.actor_id, evidenceDigest: r.evidence_digest } });
  for (const r of await sql<{ id: string; sequence: string; type: string; source: string; actor_id: string | null; attempt: number; fencing_token: string; payload_redacted: Record<string, unknown>; created_at: Date }[]>`SELECT id, sequence, type, source, actor_id, attempt, fencing_token, payload_redacted, created_at FROM events WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "event", id: r.id, kind: r.type, summary: r.type, data: { sequence: Number(r.sequence), source: r.source, actor: r.actor_id, attempt: r.attempt, fencingToken: Number(r.fencing_token), payload: r.payload_redacted } });
  for (const r of await sql<{ id: string; stage: string; role: string; status: string; attempt: number; runtime_id: string | null; model_id: string | null; created_at: Date }[]>`SELECT id, stage, role, status, attempt, runtime_id, model_id, created_at FROM tasks WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "task", id: r.id, kind: "task", summary: `${r.stage} (${r.status})`, data: { stage: r.stage, role: r.role, status: r.status, attempt: r.attempt, runtime: r.runtime_id, model: r.model_id } });
  for (const r of await sql<{ id: string; runtime_id: string; model_id: string; status: string; auth_mode: string; inference_billing_mode: string; usage_source: string; token_input: string | null; token_output: string | null; compute_seconds: number | null; prompt_digest: string; context_digest: string; role: string; created_at: Date }[]>`
    SELECT ar.id, ar.runtime_id, ar.model_id, ar.status, ar.auth_mode, ar.inference_billing_mode, ar.usage_source, ar.token_input, ar.token_output, ar.compute_seconds, ar.prompt_digest, ar.context_digest, tk.role, ar.created_at
    FROM agent_runs ar JOIN tasks tk ON tk.id = ar.task_id WHERE tk.job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "agent_run", id: r.id, kind: "agent.run", summary: `${r.role} on ${r.runtime_id}/${r.model_id}: ${r.status}`, data: { role: r.role, runtime: r.runtime_id, model: r.model_id, status: r.status, authMode: r.auth_mode, inferenceBillingMode: r.inference_billing_mode, usageSource: r.usage_source, tokensIn: r.token_input === null ? null : Number(r.token_input), tokensOut: r.token_output === null ? null : Number(r.token_output), computeSeconds: r.compute_seconds, promptDigest: r.prompt_digest, contextDigest: r.context_digest } });
  for (const r of await sql<{ id: string; kind: string; digest: string; byte_length: string; redaction_status: string; created_at: Date }[]>`SELECT id, kind, digest, byte_length, redaction_status, created_at FROM artifacts WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "artifact", id: r.id, kind: "artifact", summary: r.kind, data: { kind: r.kind, digest: r.digest, bytes: Number(r.byte_length), redaction: r.redaction_status } });
  for (const r of await sql<{ id: string; round: number; role: string; parent_sha: string; head_sha: string; tree_sha: string; patch_digest: string; files_changed: number; created_at: Date }[]>`SELECT id, round, role, parent_sha, head_sha, tree_sha, patch_digest, files_changed, created_at FROM candidates WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "candidate", id: r.id, kind: "candidate", summary: `${r.role} round ${r.round}: ${r.head_sha.slice(0, 8)}`, data: { round: r.round, role: r.role, parentSha: r.parent_sha, headSha: r.head_sha, treeSha: r.tree_sha, patchDigest: r.patch_digest, files: r.files_changed } });
  for (const r of await sql<{ id: string; head_sha: string; base_sha: string; gate_config_digest: string; verdict: string; results_digest: string; created_at: Date }[]>`SELECT id, head_sha, base_sha, gate_config_digest, verdict, results_digest, created_at FROM gate_results WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "gate", id: r.id, kind: "gate.result", summary: `gates ${r.verdict} @ ${r.head_sha.slice(0, 8)}`, data: { verdict: r.verdict, headSha: r.head_sha, baseSha: r.base_sha, configDigest: r.gate_config_digest, resultsDigest: r.results_digest } });
  for (const r of await sql<{ id: string; head_sha: string; reviewer_role: string; reviewer_run_id: string | null; verdict: string; findings_digest: string; created_at: Date }[]>`SELECT id, head_sha, reviewer_role, reviewer_run_id, verdict, findings_digest, created_at FROM review_results WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "review", id: r.id, kind: "review.result", summary: `${r.reviewer_role} review ${r.verdict}`, data: { role: r.reviewer_role, verdict: r.verdict, headSha: r.head_sha, reviewerRunId: r.reviewer_run_id, findingsDigest: r.findings_digest } });
  for (const r of await sql<{ id: string; head_sha: string; policy_digest: string; risk: string; eligible: boolean; reasons: unknown; created_at: Date }[]>`SELECT id, head_sha, policy_digest, risk, eligible, reasons, created_at FROM policy_decisions WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "policy", id: r.id, kind: "policy.decision", summary: `risk ${r.risk}, auto-merge ${r.eligible ? "eligible" : "not eligible"}`, data: { risk: r.risk, eligible: r.eligible, reasons: r.reasons, headSha: r.head_sha, policyDigest: r.policy_digest } });
  for (const r of await sql<{ id: string; head_sha: string; base_sha: string; policy_digest: string; actor_id: string; decision: string; reason: string | null; created_at: Date }[]>`SELECT id, head_sha, base_sha, policy_digest, actor_id, decision, reason, created_at FROM approvals WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "approval", id: r.id, kind: "approval", summary: `${r.decision} by ${r.actor_id.slice(0, 8)}`, data: { decision: r.decision, actor: r.actor_id, headSha: r.head_sha, baseSha: r.base_sha, policyDigest: r.policy_digest, reason: r.reason } });
  for (const r of await sql<{ id: string; pr_number: number; html_url: string; head_ref: string; head_sha: string; draft: boolean; created_at: Date }[]>`SELECT id, pr_number, html_url, head_ref, head_sha, draft, created_at FROM pull_requests WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "pull_request", id: r.id, kind: "pull_request", summary: `PR #${r.pr_number}`, data: { number: r.pr_number, url: r.html_url, headRef: r.head_ref, headSha: r.head_sha, draft: r.draft } });
  for (const r of await sql<{ id: string; pr_number: number; head_sha: string; status: string; github_merge_sha: string | null; merge_method: string; reason: string | null; created_at: Date }[]>`SELECT id, pr_number, head_sha, status, github_merge_sha, merge_method, reason, created_at FROM merge_intents WHERE job_id = ${jobId}`)
    add({ ts: iso(r.created_at), source: "merge", id: r.id, kind: "merge.intent", summary: `merge ${r.status}`, data: { prNumber: r.pr_number, headSha: r.head_sha, status: r.status, mergeSha: r.github_merge_sha, method: r.merge_method, reason: r.reason } });
  for (const r of await sql<{ id: string; actor: string; action: string; result: string; reason: string | null; created_at: Date }[]>`SELECT id, actor, action, result, reason, created_at FROM audit_entries WHERE resource = ${`job:${jobId}`}`)
    add({ ts: iso(r.created_at), source: "audit", id: r.id, kind: `audit.${r.action}`, summary: `${r.action}: ${r.result}`, data: { actor: r.actor, action: r.action, result: r.result, reason: r.reason } });

  all.sort((a, b) => a.ts.localeCompare(b.ts) || RANK[a.source] - RANK[b.source] || (orderKey(a) - orderKey(b)) || a.id.localeCompare(b.id));
  const cursor = q.get("cursor");
  let start = 0;
  if (cursor) {
    try { const c = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { ts: string; id: string }; const i = all.findIndex((e) => e.ts === c.ts && e.id === c.id); if (i < 0) throw new Error("x"); start = i + 1; } catch { throw problems.badRequest("invalid cursor"); }
  }
  const page = all.slice(start, start + limit);
  const last = page.at(-1);
  const statePath = all.filter((e) => e.source === "transition").map((e) => (e.data as { to: string }).to);
  return { job: detail, entries: clean(page), nextCursor: start + limit < all.length && last ? Buffer.from(JSON.stringify({ ts: last.ts, id: last.id })).toString("base64url") : null, statePath };
}

export async function listArtifacts(sql: Sql, actor: Actor, jobId: string, q: URLSearchParams) {
  await getJob(sql, actor, jobId);
  const limit = Number(q.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw problems.badRequest("limit must be 1..100");
  const kind = q.get("kind");
  const after = q.get("cursor") ? Number(q.get("cursor")) : 0;
  if (!Number.isInteger(after) || after < 0) throw problems.badRequest("invalid cursor");
  const rows = await sql<{ id: string; kind: string; digest: string; byte_length: string; redaction_status: string; created_at: Date }[]>`
    SELECT id, kind, digest, byte_length, redaction_status, created_at FROM artifacts WHERE job_id = ${jobId} ${kind ? sql`AND kind = ${kind}` : sql``} ORDER BY created_at, id OFFSET ${after} LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  return { items: page.map((r) => ({ id: r.id, kind: r.kind, digest: r.digest, bytes: Number(r.byte_length), redaction: r.redaction_status, createdAt: iso(r.created_at) })), nextCursor: rows.length > limit ? String(after + limit) : null };
}

export async function policyView(sql: Sql, actor: Actor, jobId: string) {
  const { detail } = await getJob(sql, actor, jobId);
  const [d] = await sql<{ risk: string; eligible: boolean; reasons: string[]; policy_digest: string; head_sha: string; created_at: Date }[]>`SELECT risk, eligible, reasons, policy_digest, head_sha, created_at FROM policy_decisions WHERE job_id = ${jobId} ORDER BY created_at DESC LIMIT 1`;
  const [routed] = await sql<{ payload_redacted: { roles?: string[]; reasons?: string[] } }[]>`SELECT payload_redacted FROM events WHERE job_id = ${jobId} AND type = 'review.routed' ORDER BY sequence DESC LIMIT 1`;
  const gates = await sql<{ verdict: string; head_sha: string; gate_config_digest: string; created_at: Date }[]>`SELECT verdict, head_sha, gate_config_digest, created_at FROM gate_results WHERE job_id = ${jobId} ORDER BY created_at DESC LIMIT 5`;
  return clean({
    risk: d?.risk ?? (detail.risk as string),
    reviewers: { required: routed?.payload_redacted.roles ?? [], reasons: routed?.payload_redacted.reasons ?? [] },
    gates: gates.map((g) => ({ verdict: g.verdict, headSha: g.head_sha, configDigest: g.gate_config_digest, at: iso(g.created_at) })),
    mergeEligibility: { autoMergeEligible: d?.eligible ?? false, requiresHuman: true, reasons: d?.reasons ?? [], policyDigest: d?.policy_digest ?? null, headSha: d?.head_sha ?? null },
  });
}

export async function listAudit(sql: Sql, actor: Actor, q: URLSearchParams) {
  const limit = Number(q.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw problems.badRequest("limit must be 1..200");
  let cursor: { t: string; id: string } | null = null;
  if (q.get("cursor")) { try { cursor = JSON.parse(Buffer.from(q.get("cursor") as string, "base64url").toString()); } catch { throw problems.badRequest("invalid cursor"); } }
  const rows = await sql<{ id: string; actor: string; action: string; resource: string; result: string; reason: string | null; digest: string; created_at: Date }[]>`
    SELECT id, actor, action, resource, result, reason, digest, created_at FROM audit_entries WHERE organization_id = ${actor.orgId}
    ${cursor ? sql`AND (created_at, id) < (${new Date(cursor.t)}, ${cursor.id})` : sql``} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return clean({ items: page.map((r) => ({ id: r.id, actor: r.actor, action: r.action, resource: r.resource, result: r.result, reason: r.reason, digest: r.digest, at: iso(r.created_at) })), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ t: iso(last.created_at), id: last.id })).toString("base64url") : null });
}

export async function listWorkers(sql: Sql, actor: Actor) {
  const rows = await sql<{ id: string; mode: string; status: string; heartbeat_at: Date | null; capability_json: Record<string, unknown>; active: number }[]>`
    SELECT w.id, w.mode, w.status, w.heartbeat_at, w.capability_json, (SELECT count(*)::int FROM tasks t WHERE t.lease_owner = w.id AND t.status IN ('leased','running')) AS active
    FROM workers w WHERE w.organization_id = ${actor.orgId} ORDER BY w.created_at DESC LIMIT 200`;
  return clean({ items: rows.map((w) => ({ id: w.id, mode: w.mode, status: w.status, heartbeatAt: w.heartbeat_at ? iso(w.heartbeat_at) : null, capabilities: w.capability_json, activeLeases: w.active })) });
}

/** Subscription/local runtime usage and capacity. COUNTS and SECONDS only: there are no money, price or per-token-cost fields, by construction. */
export async function usageReport(sql: Sql, actor: Actor, q: URLSearchParams) {
  const since = q.get("since") ? new Date(q.get("since") as string) : new Date(Date.now() - 7 * 86_400_000);
  if (Number.isNaN(since.getTime())) throw problems.badRequest("invalid since");
  const org = actor.orgId;
  const states = await sql<{ state: string; c: number }[]>`SELECT j.state, count(*)::int AS c FROM jobs j JOIN repositories r ON r.id = j.repository_id WHERE r.organization_id = ${org} AND j.created_at >= ${since} GROUP BY j.state`;
  const runtimes = await sql<{ runtime_id: string; model_id: string; auth_mode: string; usage_source: string; runs: number; ok: number; failed: number; seconds: number | null; tin: string | null; tout: string | null }[]>`
    SELECT ar.runtime_id, ar.model_id, ar.auth_mode, ar.usage_source, count(*)::int AS runs, count(*) FILTER (WHERE ar.status = 'succeeded')::int AS ok, count(*) FILTER (WHERE ar.status <> 'succeeded')::int AS failed,
           sum(ar.compute_seconds) AS seconds, sum(ar.token_input) AS tin, sum(ar.token_output) AS tout
    FROM agent_runs ar JOIN tasks t ON t.id = ar.task_id JOIN jobs j ON j.id = t.job_id JOIN repositories r ON r.id = j.repository_id
    WHERE r.organization_id = ${org} AND ar.created_at >= ${since} GROUP BY 1,2,3,4 ORDER BY runs DESC`;
  const roles = await sql<{ role: string; runs: number; secs: number | null }[]>`
    SELECT t.role, count(*)::int AS runs, avg(ar.compute_seconds) AS secs FROM agent_runs ar JOIN tasks t ON t.id = ar.task_id JOIN jobs j ON j.id = t.job_id JOIN repositories r ON r.id = j.repository_id
    WHERE r.organization_id = ${org} AND ar.created_at >= ${since} GROUP BY t.role ORDER BY runs DESC`;
  const [signals] = await sql<{ rate_limited: number; expired: number; invalid_reviews: number; rework: number; gate_failures: number }[]>`
    SELECT count(*) FILTER (WHERE e.type = 'agent.rate_limited')::int AS rate_limited, count(*) FILTER (WHERE e.type = 'task.expired')::int AS expired,
           count(*) FILTER (WHERE e.type = 'review.invalid')::int AS invalid_reviews, count(*) FILTER (WHERE e.type = 'human.changes_requested' OR e.type = 'review.changes_requested')::int AS rework,
           count(*) FILTER (WHERE e.type = 'gate.failed')::int AS gate_failures
    FROM events e JOIN jobs j ON j.id = e.job_id JOIN repositories r ON r.id = j.repository_id WHERE r.organization_id = ${org} AND e.created_at >= ${since}`;
  const workers = await sql<{ status: string; c: number }[]>`SELECT status, count(*)::int AS c FROM workers WHERE organization_id = ${org} GROUP BY status`;
  const [running] = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM tasks t JOIN jobs j ON j.id = t.job_id JOIN repositories r ON r.id = j.repository_id WHERE r.organization_id = ${org} AND t.status IN ('leased','running')`;
  return clean({
    window: { since: iso(since), until: iso(new Date()) },
    jobs: { byState: Object.fromEntries(states.map((s) => [s.state, s.c])) },
    runtimes: runtimes.map((r) => ({ runtimeId: r.runtime_id, modelId: r.model_id, authMode: r.auth_mode, usageSource: r.usage_source, runs: r.runs, succeeded: r.ok, failed: r.failed, computeSeconds: r.seconds === null ? null : Number(r.seconds), tokensIn: r.tin === null ? null : Number(r.tin), tokensOut: r.tout === null ? null : Number(r.tout) })),
    roles: roles.map((r) => ({ role: r.role, runs: r.runs, avgComputeSeconds: r.secs === null ? null : Number(r.secs) })),
    pressure: { rateLimitEvents: signals?.rate_limited ?? 0, expiredLeases: signals?.expired ?? 0, invalidReviewReports: signals?.invalid_reviews ?? 0, reworkRequests: signals?.rework ?? 0, gateFailures: signals?.gate_failures ?? 0 },
    capacity: {
      runningTasks: running?.c ?? 0, workers: Object.fromEntries(workers.map((w) => [w.status, w.c])), localMaxRunningJobs: 1,
      host: { cpuCount: cpus().length, loadAvg1m: Number(loadavg()[0]?.toFixed(2) ?? 0), memTotalMb: Math.round(totalmem() / 1048576), memFreeMb: Math.round(freemem() / 1048576) },
    },
    note: "Counts and compute seconds only. Token counts, where a runtime reports them, are for capacity analysis. No monetary, price or per-token-cost metrics are collected.",
  });
}
