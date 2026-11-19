import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf } from "@factory/telemetry";
import { z } from "zod";
import { isApprovalStale, type EvidenceBinding } from "./binding";
import { maxRisk, requiresHumanApproval, RISK_LEVELS, riskRank, type RiskLevel } from "./risk";

const Level = z.enum(RISK_LEVELS);

export const PolicyConfigSchema = z.strictObject({
  version: z.string().min(1),
  note: z.string().optional(),
  minimumRisk: z.strictObject({
    pathRules: z.array(z.strictObject({ glob: z.string().min(1).max(200), level: Level, reason: z.string().min(1).max(200) })).min(1).max(500),
    unmatchedPathLevel: Level,
    maxFilesForConfidentClassification: z.number().int().min(1).max(10_000),
  }),
  merge: z.strictObject({
    pilotHumanApproval: z.boolean(),
    autoMerge: z.strictObject({ enabled: z.boolean(), allowedRisks: z.array(Level), requireCalibration: z.boolean() }),
    humanApproval: z.strictObject({ requiredForRisks: z.array(Level), twoPersonForRisks: z.array(Level), approvalMaxAgeMinutes: z.number().int().min(1).max(7 * 24 * 60) }),
  }),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export class PolicyInvalid extends Error {
  constructor(message: string) { super(message); this.name = "PolicyInvalid"; }
}

/** Hard invariants that no configuration may violate (SECURITY.md / blueprint section 6): refused at load time. */
export function assertPolicyInvariants(p: PolicyConfig): void {
  for (const r of p.merge.autoMerge.allowedRisks) if (requiresHumanApproval(r)) throw new PolicyInvalid(`autoMerge.allowedRisks may never include ${r}`);
  for (const r of ["HIGH", "CRITICAL"] as const) {
    if (!p.merge.humanApproval.requiredForRisks.includes(r)) throw new PolicyInvalid(`humanApproval.requiredForRisks must include ${r}`);
  }
  if (!p.merge.humanApproval.twoPersonForRisks.every((r) => p.merge.humanApproval.requiredForRisks.includes(r))) throw new PolicyInvalid("twoPersonForRisks must be a subset of requiredForRisks");
  if (p.merge.pilotHumanApproval && p.merge.autoMerge.enabled) throw new PolicyInvalid("autoMerge cannot be enabled while pilotHumanApproval is true");
}

export const policyDigest = (p: PolicyConfig): string => digestOf(p);

export function loadPolicy(configDir: string): { policy: PolicyConfig; digest: string } {
  const policy = PolicyConfigSchema.parse(JSON.parse(readFileSync(join(configDir, "risk-policy.json"), "utf8")));
  assertPolicyInvariants(policy);
  return { policy, digest: policyDigest(policy) };
}

const rx = (glob: string) =>
  new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "<<S>>").replace(/\*\*/g, "<<A>>").replace(/\*/g, "[^/]*").replace(/<<S>>/g, "(?:.*/)?").replace(/<<A>>/g, ".*") + "$");

export interface PathClass { path: string; level: RiskLevel; reason: string; matched: boolean }

/** The strictest matching rule wins; unmatched paths get the policy's default (never LOW by omission). */
export function classifyPaths(paths: readonly string[], p: PolicyConfig): { floor: RiskLevel; classes: PathClass[] } {
  const rules = p.minimumRisk.pathRules.map((r) => ({ ...r, re: rx(r.glob) }));
  const classes: PathClass[] = paths.map((path) => {
    const hits = rules.filter((r) => r.re.test(path));
    if (hits.length === 0) return { path, level: p.minimumRisk.unmatchedPathLevel, reason: "no rule matched (default)", matched: false };
    const top = hits.reduce((a, b) => (riskRank(b.level) > riskRank(a.level) ? b : a));
    return { path, level: top.level, reason: top.reason, matched: true };
  });
  return { floor: classes.reduce<RiskLevel>((r, c) => maxRisk(r, c.level), "LOW"), classes };
}

export const UNCERTAINTY_SIGNALS = ["diff-unavailable", "diff-truncated", "binary-change", "mode-change", "symlink", "submodule", "rename-across-boundary", "intake-unclassified", "conflicting-signals"] as const;
export type UncertaintySignal = (typeof UNCERTAINTY_SIGNALS)[number];

export interface PolicyInput {
  policy: PolicyConfig;
  policyDigest: string;
  changedFiles: readonly string[] | null; // null = unknown
  /** Floors from other deterministic classifiers. */
  textFloor?: RiskLevel | undefined;
  specFloor?: RiskLevel | undefined;
  /** The job's current (ratcheted) risk, if any was classified before. */
  currentRisk?: RiskLevel | undefined;
  /** What a model proposed. It can only RAISE the result. */
  modelProposal?: RiskLevel | undefined;
  uncertainty?: readonly UncertaintySignal[];
  gate: { passed: boolean; boundToHead: boolean };
  reviews: { allRequiredPassed: boolean };
  calibrated?: boolean;
}

export interface PolicyDecision {
  risk: RiskLevel;
  uncertain: boolean;
  reasons: string[];
  requiresHumanApproval: boolean;
  twoPerson: boolean;
  /** Eligible for UNATTENDED merge. Always false for HIGH/CRITICAL, uncertain classifications, and while the pilot/auto-merge flags forbid it. */
  autoMergeEligible: boolean;
  blockers: string[];
  policyDigest: string;
  approvalMaxAgeMinutes: number;
}

export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  assertPolicyInvariants(i.policy);
  const reasons: string[] = [];
  const signals = [...(i.uncertainty ?? [])];
  let pathFloor: RiskLevel | undefined;
  if (i.changedFiles === null) signals.push("diff-unavailable");
  else {
    if (i.changedFiles.length === 0) signals.push("diff-unavailable");
    if (i.changedFiles.length > i.policy.minimumRisk.maxFilesForConfidentClassification) signals.push("diff-truncated");
    const c = classifyPaths(i.changedFiles, i.policy);
    pathFloor = c.floor;
    for (const k of c.classes.filter((x) => riskRank(x.level) >= riskRank("HIGH"))) reasons.push(`${k.level}: ${k.path} (${k.reason})`);
  }
  let risk = maxRisk(...([pathFloor, i.textFloor, i.specFloor, i.currentRisk, i.modelProposal].filter((x): x is RiskLevel => x !== undefined)));
  if (pathFloor === undefined && i.currentRisk === undefined && i.textFloor === undefined && i.specFloor === undefined) risk = "CRITICAL"; // nothing known at all
  if (i.modelProposal && riskRank(i.modelProposal) > riskRank(maxRisk(...([pathFloor, i.textFloor, i.specFloor, i.currentRisk].filter((x): x is RiskLevel => x !== undefined)), "LOW"))) reasons.push(`model proposal ${i.modelProposal} raised the floor`);
  const uncertain = signals.length > 0;
  if (uncertain) { risk = maxRisk(risk, "HIGH"); reasons.push(`HIGH: uncertain classification (${[...new Set(signals)].join(", ")}) escalates`); }

  const human = i.policy.merge.humanApproval.requiredForRisks.includes(risk) || requiresHumanApproval(risk);
  const twoPerson = i.policy.merge.humanApproval.twoPersonForRisks.includes(risk);
  const blockers: string[] = [];
  const auto = i.policy.merge.autoMerge;
  if (!auto.enabled) blockers.push("auto-merge is disabled by policy (pilot: every merge is manual)");
  if (i.policy.merge.pilotHumanApproval) blockers.push("pilot: human approval required for every merge");
  if (requiresHumanApproval(risk)) blockers.push(`${risk} risk always requires human approval`);
  if (uncertain) blockers.push("classification is uncertain");
  if (!auto.allowedRisks.includes(risk)) blockers.push(`risk ${risk} is not in the auto-merge allowlist`);
  if (!i.gate.passed || !i.gate.boundToHead) blockers.push("no passing gate evidence bound to the exact head");
  if (!i.reviews.allRequiredPassed) blockers.push("required reviews are not all passing for the exact head");
  if (auto.requireCalibration && !i.calibrated) blockers.push("auto-merge has not been calibrated");
  const autoMergeEligible = blockers.length === 0 && !human;
  return {
    risk, uncertain, reasons, requiresHumanApproval: human || !autoMergeEligible, twoPerson, autoMergeEligible, blockers,
    policyDigest: i.policyDigest, approvalMaxAgeMinutes: i.policy.merge.humanApproval.approvalMaxAgeMinutes,
  };
}

export interface MergeAssessmentInput {
  decision: Pick<PolicyDecision, "risk" | "requiresHumanApproval" | "twoPerson" | "approvalMaxAgeMinutes" | "policyDigest" | "autoMergeEligible">;
  /** Fresh authoritative binding computed at merge time. */
  current: EvidenceBinding;
  approvals: ReadonlyArray<{ actorId: string; decision: "approve" | "reject" | "rework"; binding: EvidenceBinding; approvedAtMs: number }>;
  prOpen: boolean;
  prDraft: boolean;
  nowMs: number;
  requestedBy?: string;
}

export interface MergeAssessment { allowed: boolean; blockers: string[]; validApprovers: string[] }

/** Server-side merge gate used at merge time with FRESH facts. Anything stale or missing blocks. */
export function assessMerge(i: MergeAssessmentInput): MergeAssessment {
  const blockers: string[] = [];
  if (!i.prOpen) blockers.push("pull request is not open");
  if (i.prDraft) blockers.push("pull request is still a draft");
  if (i.decision.policyDigest !== i.current.policyDigest) blockers.push("policy changed since the decision was made");
  const maxAge = i.decision.approvalMaxAgeMinutes * 60_000;
  const valid = i.approvals.filter((a) => a.decision === "approve" && !isApprovalStale(a.binding, i.current) && i.nowMs - a.approvedAtMs <= maxAge);
  if (i.approvals.some((a) => a.decision === "reject" && !isApprovalStale(a.binding, i.current))) blockers.push("a human rejected this exact candidate");
  const approvers = [...new Set(valid.map((a) => a.actorId))];
  if (i.decision.requiresHumanApproval) {
    if (approvers.length === 0) blockers.push(i.approvals.some((a) => a.decision === "approve") ? "approvals are stale or expired for the current head/base/policy/evidence" : "no human approval for this exact candidate");
    if (i.decision.twoPerson && approvers.filter((a) => a !== i.requestedBy).length < 2) blockers.push("two distinct approvers are required for this risk level");
  } else if (!i.decision.autoMergeEligible) blockers.push("merge is not eligible under policy");
  if (requiresHumanApproval(i.decision.risk) && approvers.length === 0) blockers.push(`${i.decision.risk} changes can only be merged with a valid human approval`);
  return { allowed: blockers.length === 0, blockers: [...new Set(blockers)], validApprovers: approvers };
}
