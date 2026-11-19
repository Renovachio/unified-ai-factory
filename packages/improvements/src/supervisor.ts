import type { Sql } from "@factory/db";
import { analyzeGaps, loadSignals, type GapReport, type StoredSignal } from "@factory/capabilities";
import type { ComparisonReport } from "@factory/evals";
import { digestOfJson } from "@factory/skills";
import type { CandidateDiff, ImprovementPlan } from "./engine";
import { advance, createProposal, ledger, type Proposal } from "./store";

/**
 * The supervisor has NO authority. It observes opted-in signals, creates proposals, asks AUTHORISED services to generate candidates and to
 * evaluate them independently, and prepares a package for a human. Everything it cannot do is denied by its database role
 * (`factory_supervisor`: no INSERT on approvals/decisions/benchmarks/comparisons/versions/registry/policies; proposal states approved/monitoring/accepted are
 * rejected by trigger) — not merely by this code. Its only registry write is the SECURITY DEFINER `registry_policy_disable`, which can turn a version OFF
 * under a pre-approved, human-created policy and can never enable anything.
 */
export interface ActiveTarget { versionId: string; slug: string; digest: string }
export interface SupervisorDeps {
  /** Connection authenticated as the supervisor role. */
  sql: Sql;
  organizationId: string;
  /** Authorised candidate generator (sandboxed service). Returns null when it cannot produce a bounded, valid candidate. */
  proposeCandidate: (gap: GapReport, target: ActiveTarget, signals: StoredSignal[]) => Promise<{ plan: ImprovementPlan; candidate: CandidateDiff } | null>;
  /** Independent evaluator service. It records the comparison itself (the supervisor cannot write comparisons). */
  evaluate: (i: { target: ActiveTarget; candidate: CandidateDiff; plan: ImprovementPlan; proposalId: string }) => Promise<{ comparisonId: string; report: ComparisonReport; evaluatorId: string }>;
  maxPerRun?: number;
  workspaceId?: string;
}
export interface ApprovalPackage {
  proposalId: string; target: ActiveTarget; candidateDigest: string; diff: string;
  confidence: { meanImprovement: number; ciLow: number; ciHigh: number; sampleSize: number; status: string };
  limitations: string; security: { ok: boolean; errors: string[] }; license: { declared: string | null; review: string | null };
  grantedScopes: { tools: string[]; network: string[]; writeScopes: string[]; dataClasses: string[] } | null;
  rollbackRules: string; comparisonId: string; evaluator: string; approvalRequired: true; digest: string;
}
export interface SupervisorRun { observed: number; proposals: Array<{ id: string; state: string; created: boolean }>; packages: ApprovalPackage[]; skipped: string[] }

const sevW: Record<GapReport["risk"], number> = { low: 1, medium: 0.8, high: 0.5 };
const costW: Record<GapReport["cost"], number> = { low: 1, medium: 1.5, high: 2.5 };
export const rankGap = (g: GapReport): number => Number((((g.distinctEvidence / (g.distinctEvidence + 5)) * g.confidence * sevW[g.risk]) / costW[g.cost]).toFixed(4));

export async function activeTargets(sql: Sql, org: string, workspace = "default"): Promise<ActiveTarget[]> {
  return (await sql`SELECT v.id, v.slug, v.digest FROM registry_active a JOIN skill_versions v ON v.id = a.active_version_id WHERE a.organization_id = ${org} AND a.workspace_id = ${workspace} AND v.state = 'approved'`).map((r) => ({ versionId: r.id as string, slug: r.slug as string, digest: r.digest as string }));
}

export async function superviseOnce(d: SupervisorDeps): Promise<SupervisorRun> {
  const run: SupervisorRun = { observed: 0, proposals: [], packages: [], skipped: [] };
  const targets = await activeTargets(d.sql, d.organizationId, d.workspaceId);
  const byId = new Map(targets.map((t) => [t.versionId, t]));
  const all = await loadSignals(d.sql, d.organizationId, d.workspaceId);
  // Only signals mapped to the exact CURRENTLY ACTIVE approved version count; stale-version signals are ignored (they describe code that is no longer running).
  const signals = all.filter((s) => s.targetVersionId && byId.has(s.targetVersionId));
  run.observed = signals.length;
  const gaps = analyzeGaps(signals).filter((g) => g.recommendation === "revise_skill" && g.targetVersionId);
  gaps.sort((a, b) => rankGap(b) - rankGap(a));
  let budget = d.maxPerRun ?? 3;
  for (const gap of gaps) {
    const target = byId.get(gap.targetVersionId as string) as ActiveTarget;
    const sigs = signals.filter((s) => s.intentKey === gap.intentKey && s.targetVersionId === gap.targetVersionId);
    const { proposal, created } = await createProposal(d.sql, { organizationId: d.organizationId, targetDigest: target.digest, intentKey: gap.intentKey, action: "revise_skill", signalIds: sigs.map((s) => s.id), problem: `${gap.distinctEvidence} distinct quality events on ${target.slug}@${target.digest.slice(0, 15)}: ${gap.rationale}`, hypothesis: `A single bounded revision of ${target.slug} will reduce repeated "${gap.intentKey}" failures`, risk: gap.risk === "high" ? "high" : "low", rankScore: rankGap(gap) });
    run.proposals.push({ id: proposal.id, state: proposal.state, created });
    if (!created && proposal.state !== "observed") { run.skipped.push(`${proposal.id}: already ${proposal.state}`); continue; } // dedupe: never re-run work that is in flight or finished
    if (budget <= 0) { run.skipped.push(`${proposal.id}: over run budget`); continue; }
    budget--;
    await advance(d.sql, proposal.id, "triaged");
    await ledger(d.sql, { organizationId: d.organizationId, proposalId: proposal.id, event: "triaged", detail: { rank: rankGap(gap), evidence: gap.representativeEvidence } });
    await advance(d.sql, proposal.id, "planned");
    const made = await d.proposeCandidate(gap, target, sigs);
    if (!made) { await advance(d.sql, proposal.id, "blocked"); await ledger(d.sql, { organizationId: d.organizationId, proposalId: proposal.id, event: "blocked", detail: { reason: "no valid bounded candidate" } }); run.skipped.push(`${proposal.id}: blocked`); continue; }
    if (!made.candidate.report.ok) { await advance(d.sql, proposal.id, "blocked"); await ledger(d.sql, { organizationId: d.organizationId, proposalId: proposal.id, event: "blocked", detail: { reason: "candidate failed static validation", codes: made.candidate.report.findings.filter((f) => f.severity === "error").map((f) => f.code) } }); run.skipped.push(`${proposal.id}: invalid candidate`); continue; }
    await advance(d.sql, proposal.id, "candidate_ready", { candidateDigest: made.candidate.candidateDigest });
    await advance(d.sql, proposal.id, "evaluating");
    const ev = await d.evaluate({ target, candidate: made.candidate, plan: made.plan, proposalId: proposal.id });
    await ledger(d.sql, { organizationId: d.organizationId, proposalId: proposal.id, event: "evaluated", benchmarkDigest: ev.report.benchmarkDigest, evaluator: ev.evaluatorId, detail: { comparisonId: ev.comparisonId, status: ev.report.status, metrics: ev.report.metrics, criticalRegressions: ev.report.criticalRegressions, sampleSize: ev.report.sampleSize } });
    if (ev.report.status !== "passed" || ev.report.recommendation !== "recommend_approval") {
      await advance(d.sql, proposal.id, "rejected", { comparisonId: ev.comparisonId });  // non-improving candidates are rejected; their evidence stays
      run.skipped.push(`${proposal.id}: rejected (${ev.report.status})`); continue;
    }
    await advance(d.sql, proposal.id, "awaiting_approval", { comparisonId: ev.comparisonId, rollbackRule: made.plan.rollbackCriteria });
    const pkg = buildApprovalPackage({ proposal, target, made, ev });
    await ledger(d.sql, { organizationId: d.organizationId, proposalId: proposal.id, event: "approval_package", benchmarkDigest: ev.report.benchmarkDigest, evaluator: ev.evaluatorId, detail: { package: pkg as unknown as Record<string, unknown> } });
    run.packages.push(pkg);
  }
  return run;
}

export function buildApprovalPackage(i: { proposal: Proposal; target: ActiveTarget; made: { plan: ImprovementPlan; candidate: CandidateDiff }; ev: { comparisonId: string; report: ComparisonReport; evaluatorId: string } }): ApprovalPackage {
  const m = i.made.candidate.report.manifest; const r = i.ev.report;
  const body = { proposalId: i.proposal.id, target: i.target, candidateDigest: i.made.candidate.candidateDigest, diff: i.made.candidate.diff,
    confidence: { meanImprovement: r.metrics.meanImprovement ?? 0, ciLow: r.metrics.ciLow ?? 0, ciHigh: r.metrics.ciHigh ?? 0, sampleSize: r.sampleSize, status: r.status },
    limitations: r.uncertaintyNotes, security: { ok: i.made.candidate.report.ok, errors: i.made.candidate.report.findings.filter((f) => f.severity === "error").map((f) => f.code) },
    license: { declared: m?.origin.license ?? null, review: m?.origin.licenseReview ?? null }, grantedScopes: m?.permissions ?? null,
    rollbackRules: i.made.plan.rollbackCriteria, comparisonId: i.ev.comparisonId, evaluator: i.ev.evaluatorId, approvalRequired: true as const };
  return { ...body, digest: digestOfJson(body) };
}

export interface Observation { policyId: string; metric: string; value: number; samples: number }
/**
 * Post-release monitor. Only a PRE-APPROVED rollback policy (created by humans) can act, and only in the safe direction (turn OFF; nothing new is enabled).
 * The decision lives in the database function, so a compromised supervisor cannot widen it.
 */
export async function monitorOnce(d: { sql: Sql; organizationId: string }, obs: readonly Observation[]): Promise<Array<{ policyId: string; action: "disabled" | "none"; reason: string; revision?: number }>> {
  const out: Array<{ policyId: string; action: "disabled" | "none"; reason: string; revision?: number }> = [];
  for (const o of obs) {
    const key = `policy-${o.policyId}-${digestOfJson({ m: o.metric, v: o.value, n: o.samples }).slice(7, 23)}`;
    const [r] = await d.sql`SELECT registry_policy_disable(${o.policyId}, ${o.value}, ${o.samples}, ${key}) AS res`;
    const res = (r as { res: { action: string; reason?: string; revision?: number } }).res;
    if (res.action !== "disabled") { out.push({ policyId: o.policyId, action: "none", reason: res.reason ?? "no action" }); continue; }
    const [pol] = await d.sql`SELECT v.digest FROM rollback_policies p JOIN skill_versions v ON v.id = p.version_id WHERE p.id = ${o.policyId}`;
    const [prop] = await d.sql`SELECT id FROM improvement_proposals WHERE organization_id = ${d.organizationId} AND candidate_digest = ${(pol as { digest: string }).digest} AND state = 'monitoring'`;
    if (prop) { await advance(d.sql, prop.id as string, "rolled_back"); await ledger(d.sql, { organizationId: d.organizationId, proposalId: prop.id as string, event: "policy_disable", detail: { metric: o.metric, value: o.value, samples: o.samples, policyId: o.policyId } }); }
    out.push({ policyId: o.policyId, action: "disabled", reason: `metric ${o.metric}=${o.value} over ${o.samples} samples breached the approved policy`, ...(res.revision !== undefined ? { revision: res.revision } : {}) });
  }
  return out;
}
