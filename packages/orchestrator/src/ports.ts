import type { JobState, RiskLevel } from "@factory/domain";

export interface JobCtx {
  id: string;
  repositoryId: string;
  state: JobState;
  version: number;
  risk: RiskLevel;
  headSha: string | null;
  baseSha: string | null;
  round: number;
  maxRounds: number;
  prNumber: number | null;
}

/** Source-control effects. Every method MUST be idempotent (the orchestrator may repeat it after a crash). */
export interface ScmPort {
  prepare(job: JobCtx): Promise<{ baseSha: string }>;
  commitCandidate(job: JobCtx, round: number): Promise<{ headSha: string }>;
  ensureDraftPr(job: JobCtx, headSha: string): Promise<{ prNumber: number; url: string }>;
}
export interface GatePort {
  run(job: JobCtx, headSha: string, baseSha: string): Promise<{ verdict: "pass" | "fail" | "error"; configDigest: string; resultsDigest: string }>;
}
export interface ReviewPort {
  requiredRoles(job: JobCtx): string[];
  run(job: JobCtx, role: string, headSha: string): Promise<{ verdict: "pass" | "changes_requested" | "blocked"; findingsDigest: string }>;
}
export interface PolicyPort {
  evaluate(job: JobCtx, headSha: string): Promise<{ risk: RiskLevel; eligible: boolean; reasons: string[]; policyDigest: string }>;
}
export interface Ports { scm: ScmPort; gate: GatePort; review: ReviewPort; policy: PolicyPort }

export interface IntakeResult {
  next: "SPECIFYING" | "NEEDS_INFO" | "REJECTED";
  risk: RiskLevel;
  /** Extra durable events recorded atomically with the transition. */
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}
/** Trusted intake decision logic (see @factory/intake). `pre` may short-circuit before any model time is spent. */
export interface IntakeHandler {
  pre(job: JobCtx): Promise<IntakeResult | null>;
  decide(job: JobCtx): Promise<IntakeResult>;
}
