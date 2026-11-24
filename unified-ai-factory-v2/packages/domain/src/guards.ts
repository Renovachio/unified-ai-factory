import { isApprovalStale, isCommitSha, type EvidenceBinding } from "./binding";
import { requiresHumanApproval, type RiskLevel } from "./risk";
import { assertAllowedTransition, type JobState } from "./states";

export class GuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GuardError";
  }
}

export interface JobSnapshot {
  state: JobState;
  version: number;
  risk: RiskLevel;
  headSha?: string | undefined;
  /** Binding of the latest passing gate result. */
  gate?: EvidenceBinding | undefined;
  /** Bindings of review results that passed, one per required reviewer role. */
  reviews?: ReadonlyArray<{ role: string; binding: EvidenceBinding }> | undefined;
  requiredReviewers?: readonly string[] | undefined;
  /** Human approval bound to a specific candidate. */
  approval?: EvidenceBinding | undefined;
  /** The latest policy decision for this exact head marked the change eligible for UNATTENDED merge (never true for HIGH/CRITICAL). */
  autoMergeEligible?: boolean | undefined;
  /** Current authoritative binding (freshly computed from head/base/policy/etc.). */
  current?: EvidenceBinding | undefined;
  round: number;
  maxRounds: number;
  pausedAt?: string | undefined;
  hasActiveLease?: boolean | undefined;
}

const fail = (code: string, msg: string): never => {
  throw new GuardError(code, msg);
};

/** Throws unless moving `job` to `next` is legal and all invariant guards hold. */
export function assertTransition(job: JobSnapshot, next: JobState): void {
  assertAllowedTransition(job.state, next);

  if (job.pausedAt && next !== "CANCELLED") fail("paused", "paused jobs may only be cancelled until resumed");

  switch (next) {
    case "GATING":
      if (!isCommitSha(job.headSha)) fail("no-candidate", "GATING requires a candidate head SHA");
      break;
    case "REVIEWING": {
      const cur = job.current;
      if (!cur || !job.gate) return fail("no-gate", "REVIEWING requires a passing gate result");
      if (isApprovalStale(job.gate, cur)) fail("stale-gate", "gate result is stale for the current head/base/policy");
      break;
    }
    case "PREMERGE": {
      const cur = job.current;
      if (job.state === "AWAITING_HUMAN") break; // returning after human decision; re-validated below at MERGING
      if (!cur || !job.gate || isApprovalStale(job.gate, cur)) return fail("stale-gate", "fresh gate evidence required");
      for (const role of job.requiredReviewers ?? []) {
        const r = job.reviews?.find((x) => x.role === role);
        if (!r) fail("missing-review", `required reviewer ${role} has not reported`);
        else if (r.binding.headSha !== cur.headSha || isApprovalStale(r.binding, cur))
          fail("stale-review", `review ${role} is not bound to the current candidate`);
      }
      break;
    }
    case "MERGING": {
      const cur = job.current;
      if (!cur) return fail("no-approval", "MERGING requires current evidence for the exact candidate");
      if (!job.approval) {
        // Only an explicit, policy-recorded auto-merge eligibility can stand in for a human, and never above MEDIUM risk.
        if (!(job.autoMergeEligible === true && !requiresHumanApproval(job.risk))) return fail("no-approval", "MERGING requires a human approval bound to the exact candidate");
      } else if (isApprovalStale(job.approval, cur)) fail("stale-approval", "approval no longer matches head/base/policy/evidence");
      if (!job.gate || isApprovalStale(job.gate, cur)) fail("stale-gate", "gate evidence stale at merge time");
      break;
    }
    case "BUILDING":
      // Entering REWORK is a decision point and always allowed; leaving it for another build round is what the budget bounds.
      if (job.state === "REWORK" && job.round > job.maxRounds) fail("rework-budget", "rework budget exhausted; escalate to a human");
      break;
    default:
      break;
  }

  if (job.risk && requiresHumanApproval(job.risk) && next === "MERGING" && !job.approval)
    fail("human-approval-required", "HIGH/CRITICAL changes always require human approval");
}

/**
 * A new head SHA invalidates gate/review/approval evidence and always returns the job to GATING
 * (or BUILDING when the builder is still producing it).
 */
export function onHeadShaChange(job: JobSnapshot, newHeadSha: string): { state: JobState; invalidate: Array<"gate" | "reviews" | "approval"> } {
  if (!isCommitSha(newHeadSha)) fail("bad-sha", "head SHA must be a 40-hex commit id");
  if (job.headSha === newHeadSha) return { state: job.state, invalidate: [] };
  const post: JobState[] = ["GATING", "REVIEWING", "PREMERGE", "AWAITING_HUMAN", "MERGING"];
  return { state: post.includes(job.state) ? "GATING" : job.state, invalidate: ["gate", "reviews", "approval"] };
}

/** Invariant: a paused job holds no lease and keeps its underlying resumable state. */
export function assertPauseInvariant(job: JobSnapshot): void {
  if (job.pausedAt && job.hasActiveLease) fail("paused-with-lease", "a paused job must not hold an active lease");
}
