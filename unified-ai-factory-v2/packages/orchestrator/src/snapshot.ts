import type { Q } from "@factory/db";
import type { Sql } from "@factory/db";
import type { EvidenceBinding, JobSnapshot, JobState, RiskLevel } from "@factory/domain";
import { digestOf } from "@factory/telemetry";
import type { ReviewPort } from "./ports";

interface JobRow {
  id: string; repository_id: string; state: JobState; version: number; risk: RiskLevel; head_sha: string | null; base_sha: string | null;
  current_round: number; max_rounds: number; paused_at: Date | null; policy_digest: string | null; spec_digest: string | null; created_by: string | null;
}

/**
 * The CURRENT evidence binding of a job, rebuilt from durable rows: head/base from the job, gate config digest from the latest PASSING gate,
 * policy digest, reviewer-set digest from the (current) routing, spec digest. Any difference from an approval's stored binding makes it stale.
 */
export async function currentEvidenceBinding(q: Q, review: Pick<ReviewPort, "requiredRoles">, jobId: string): Promise<{ binding: EvidenceBinding | undefined; roles: string[]; job: JobRow }> {
  const sql = q as Sql;
  const [job] = await sql<JobRow[]>`SELECT id, repository_id, state, version, risk, head_sha, base_sha, current_round, max_rounds, paused_at, policy_digest, spec_digest, created_by FROM jobs WHERE id = ${jobId}`;
  if (!job) throw new Error(`unknown job ${jobId}`);
  const roles = [...(await review.requiredRoles({ id: job.id, repositoryId: job.repository_id, state: job.state, version: job.version, risk: job.risk, headSha: job.head_sha, baseSha: job.base_sha, round: job.current_round, maxRounds: job.max_rounds, prNumber: null }))].sort();
  const [gate] = await sql<{ gate_config_digest: string }[]>`SELECT gate_config_digest FROM gate_results WHERE job_id = ${jobId} AND head_sha = ${job.head_sha} AND verdict = 'pass' ORDER BY created_at DESC LIMIT 1`;
  const binding = job.head_sha && job.base_sha && gate ? {
    repoId: job.repository_id, headSha: job.head_sha, baseSha: job.base_sha, gateConfigDigest: gate.gate_config_digest,
    policyDigest: job.policy_digest ?? "none", reviewerSetDigest: digestOf(roles), artifactDigest: job.spec_digest ?? "none", policyVersion: "1",
  } : undefined;
  return { binding, roles, job };
}

/** Snapshot for the domain transition guards (gate/review/approval evidence bound to the exact candidate). */
export async function loadJobSnapshot(q: Q, review: Pick<ReviewPort, "requiredRoles">, jobId: string): Promise<JobSnapshot> {
  const sql = q as Sql;
  const { binding: current, roles, job } = await currentEvidenceBinding(q, review, jobId);
  const common = { repoId: job.repository_id, policyDigest: job.policy_digest ?? "none", reviewerSetDigest: digestOf(roles), artifactDigest: job.spec_digest ?? "none", policyVersion: "1" };
  const [gate] = await sql<{ head_sha: string; base_sha: string; gate_config_digest: string }[]>`
    SELECT head_sha, base_sha, gate_config_digest FROM gate_results WHERE job_id = ${jobId} AND verdict = 'pass' ORDER BY created_at DESC LIMIT 1`;
  const gateB: EvidenceBinding | undefined = gate ? { ...common, headSha: gate.head_sha, baseSha: gate.base_sha, gateConfigDigest: gate.gate_config_digest } : undefined;
  const revs = job.head_sha ? await sql<{ reviewer_role: string; head_sha: string }[]>`SELECT DISTINCT reviewer_role, head_sha FROM review_results WHERE job_id = ${jobId} AND verdict = 'pass' AND head_sha = ${job.head_sha}` : [];
  const [ap] = await sql<{ binding: EvidenceBinding }[]>`SELECT binding FROM approvals WHERE job_id = ${jobId} AND decision = 'approve' ORDER BY created_at DESC LIMIT 1`;
  const [pd] = job.head_sha ? await sql<{ eligible: boolean }[]>`SELECT eligible FROM policy_decisions WHERE job_id = ${jobId} AND head_sha = ${job.head_sha} ORDER BY created_at DESC LIMIT 1` : [];
  return {
    state: job.state, version: job.version, risk: job.risk, headSha: job.head_sha ?? undefined, gate: gateB, current,
    reviews: current ? revs.map((r) => ({ role: r.reviewer_role, binding: { ...current, headSha: r.head_sha } })) : [],
    requiredReviewers: roles, ...(ap && Object.keys(ap.binding ?? {}).length ? { approval: ap.binding } : {}), autoMergeEligible: pd?.eligible === true,
    round: job.current_round, maxRounds: job.max_rounds, pausedAt: job.paused_at?.toISOString(),
  };
}
