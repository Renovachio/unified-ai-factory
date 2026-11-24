/** Everything an approval/evidence record is bound to (blueprint §5 approval cache key). */
export interface EvidenceBinding {
  repoId: string;
  headSha: string;
  baseSha: string;
  gateConfigDigest: string;
  policyDigest: string;
  reviewerSetDigest: string;
  artifactDigest: string;
  policyVersion: string;
}

export const BINDING_FIELDS = [
  "repoId", "headSha", "baseSha", "gateConfigDigest", "policyDigest", "reviewerSetDigest", "artifactDigest", "policyVersion",
] as const satisfies ReadonlyArray<keyof EvidenceBinding>;

const SHA1 = /^[a-f0-9]{40}$/;
export const isCommitSha = (v: unknown): v is string => typeof v === "string" && SHA1.test(v);

/** Fields that differ; empty array means the evidence is still valid for `current`. */
export function changedBindingFields(approved: EvidenceBinding, current: EvidenceBinding): Array<keyof EvidenceBinding> {
  return BINDING_FIELDS.filter((f) => approved[f] !== current[f]);
}

export const isApprovalStale = (approved: EvidenceBinding, current: EvidenceBinding): boolean =>
  changedBindingFields(approved, current).length > 0;
