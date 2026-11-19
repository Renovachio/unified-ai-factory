import type { Sql } from "@factory/db";
import { sha, type Benchmark, benchmarkDigests, type ComparisonReport } from "@factory/evals";

export type ProposalState = "observed" | "triaged" | "planned" | "candidate_ready" | "evaluating" | "rejected" | "awaiting_approval" | "approved" | "monitoring" | "accepted" | "rolled_back" | "blocked";
export type RequestedAction = "create_skill" | "revise_skill" | "create_agent" | "revise_agent" | "revise_workflow" | "no_action";
export interface Proposal { id: string; dedupeKey: string; targetDigest: string; signalIds: string[]; problem: string; hypothesis: string; requestedAction: RequestedAction; risk: "low" | "medium" | "high" | "critical"; state: ProposalState; candidateDigest: string | null; comparisonId: string | null; rollbackRule: string | null; rankScore: number }

const map = (r: Record<string, unknown>): Proposal => ({ id: r.id as string, dedupeKey: r.dedupe_key as string, targetDigest: r.target_digest as string, signalIds: r.signal_ids as string[], problem: r.problem as string, hypothesis: r.hypothesis as string, requestedAction: r.requested_action as RequestedAction, risk: r.risk as Proposal["risk"], state: r.state as ProposalState, candidateDigest: (r.candidate_digest as string | null) ?? null, comparisonId: (r.comparison_id as string | null) ?? null, rollbackRule: (r.rollback_rule as string | null) ?? null, rankScore: r.rank_score as number });

/** Idempotent per (org, dedupe key): a repeated observation never creates a second backlog item. */
export async function createProposal(sql: Sql, i: { organizationId: string; targetDigest: string; intentKey: string; action: RequestedAction; signalIds: string[]; problem: string; hypothesis: string; risk: Proposal["risk"]; rankScore: number }): Promise<{ proposal: Proposal; created: boolean }> {
  const dedupeKey = sha({ t: i.targetDigest, i: i.intentKey, a: i.action });
  const ins = await sql`INSERT INTO improvement_proposals (organization_id, dedupe_key, target_digest, signal_ids, problem, hypothesis, requested_action, risk, rank_score)
    VALUES (${i.organizationId}, ${dedupeKey}, ${i.targetDigest}, ${i.signalIds}::uuid[], ${i.problem}, ${i.hypothesis}, ${i.action}, ${i.risk}, ${i.rankScore}) ON CONFLICT (organization_id, dedupe_key) DO NOTHING RETURNING *`;
  if (ins[0]) return { proposal: map(ins[0]), created: true };
  const [ex] = await sql`SELECT * FROM improvement_proposals WHERE organization_id = ${i.organizationId} AND dedupe_key = ${dedupeKey}`;
  return { proposal: map(ex as Record<string, unknown>), created: false };
}
export async function getProposal(sql: Sql, id: string): Promise<Proposal> { const [r] = await sql`SELECT * FROM improvement_proposals WHERE id = ${id}`; if (!r) throw new Error("no such proposal"); return map(r); }
export async function listProposals(sql: Sql, org: string): Promise<Proposal[]> { return (await sql`SELECT * FROM improvement_proposals WHERE organization_id = ${org} ORDER BY rank_score DESC, created_at`).map(map); }
export async function advance(sql: Sql, id: string, to: ProposalState, extra: { candidateDigest?: string; comparisonId?: string; rollbackRule?: string } = {}): Promise<Proposal> {
  const [r] = await sql`UPDATE improvement_proposals SET state = ${to}, candidate_digest = COALESCE(${extra.candidateDigest ?? null}, candidate_digest), comparison_id = COALESCE(${extra.comparisonId ?? null}, comparison_id), rollback_rule = COALESCE(${extra.rollbackRule ?? null}, rollback_rule) WHERE id = ${id} RETURNING *`;
  if (!r) throw new Error("no such proposal"); return map(r);
}
export async function ledger(sql: Sql, i: { organizationId: string; proposalId: string; event: string; benchmarkDigest?: string; evaluator?: string; detail?: Record<string, unknown> }): Promise<void> {
  await sql`INSERT INTO experiment_ledger (organization_id, proposal_id, event, benchmark_digest, evaluator, detail) VALUES (${i.organizationId}, ${i.proposalId}, ${i.event}, ${i.benchmarkDigest ?? null}, ${i.evaluator ?? null}, ${sql.json((i.detail ?? {}) as never)})`;
}
export async function ledgerFor(sql: Sql, proposalId: string): Promise<Array<{ event: string; evaluator: string | null; benchmarkDigest: string | null; detail: Record<string, unknown> }>> {
  return (await sql`SELECT event, evaluator, benchmark_digest, detail FROM experiment_ledger WHERE proposal_id = ${proposalId} ORDER BY id`).map((r) => ({ event: r.event as string, evaluator: (r.evaluator as string | null) ?? null, benchmarkDigest: (r.benchmark_digest as string | null) ?? null, detail: r.detail as Record<string, unknown> }));
}
/** Benchmarks are locked by the control plane; digests in the row are what comparisons must match. */
export async function lockBenchmark(sql: Sql, i: { organizationId: string; benchmark: Benchmark; createdBy: string }): Promise<{ id: string; digests: ReturnType<typeof benchmarkDigests> }> {
  const d = benchmarkDigests(i.benchmark);
  const [r] = await sql`INSERT INTO benchmarks (organization_id, name, version, role, digest, holdout_digest, grader_digest, min_samples, created_by) VALUES (${i.organizationId}, ${i.benchmark.name}, ${i.benchmark.version}, ${i.benchmark.role}, ${d.benchmark}, ${d.holdout}, ${d.grader}, ${i.benchmark.minSamples}, ${i.createdBy}) RETURNING id`;
  return { id: (r as { id: string }).id, digests: d };
}
export async function recordComparison(sql: Sql, i: { organizationId: string; benchmarkId: string; report: ComparisonReport; evaluator: string }): Promise<string> {
  const rp = i.report;
  const [r] = await sql`INSERT INTO eval_comparisons (organization_id, benchmark_id, candidate_digest, baseline_digest, benchmark_digest, policy_digest, status, report, evaluator) VALUES (${i.organizationId}, ${i.benchmarkId}, ${rp.candidateDigest}, ${rp.baselineDigest}, ${rp.benchmarkDigest}, ${rp.policyDigest}, ${rp.status}, ${sql.json(rp as never)}, ${i.evaluator}) RETURNING id`;
  return (r as { id: string }).id;
}
