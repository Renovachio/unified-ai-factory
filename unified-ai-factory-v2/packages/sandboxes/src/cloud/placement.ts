export type Placement = "LOCAL" | "CLOUD" | "BLOCK";
export interface PlacementInput {
  cloudEnabled: boolean;
  /** Operator allowed this repository to be processed remotely (confidentiality / data-residency). */
  repoAllowedRemote: boolean;
  /** The adapter the job needs. Subscription CLIs can never run remotely (credentials may not leave the operator machine). */
  adapterAuthMode: "subscription_cli" | "local_model";
  localHasCapacity: boolean;
  localIsolationStrong: boolean;
  cloudQuotaAvailable: boolean;
  explicitRemoteRequest?: boolean;
  repoTrusted?: boolean;
}
export interface PlacementDecision { placement: Placement; reasons: string[] }

/** Quality, security and reliability come first; cost is not a criterion for model use. BLOCK when neither environment qualifies. */
export function decidePlacement(i: PlacementInput): PlacementDecision {
  const reasons: string[] = [];
  const localOk = i.localIsolationStrong || i.repoTrusted === true;
  if (!i.localIsolationStrong && i.repoTrusted !== true) reasons.push("local: no strong isolation and repository is not marked trusted");
  const cloudAllowed = i.cloudEnabled && i.repoAllowedRemote && i.adapterAuthMode === "local_model";
  if (!i.cloudEnabled) reasons.push("cloud: disabled by default");
  else if (!i.repoAllowedRemote) reasons.push("cloud: repository not approved for remote processing");
  if (i.adapterAuthMode === "subscription_cli") reasons.push("cloud: subscription CLI credentials may not leave the operator machine");
  if (localOk && i.localHasCapacity && !(i.explicitRemoteRequest && cloudAllowed && i.cloudQuotaAvailable)) return { placement: "LOCAL", reasons: [...reasons, "local: strong isolation and capacity available"] };
  if (cloudAllowed && i.cloudQuotaAvailable) return { placement: "CLOUD", reasons: [...reasons, i.explicitRemoteRequest ? "cloud: explicitly requested" : "cloud: local unavailable"] };
  if (cloudAllowed && !i.cloudQuotaAvailable) reasons.push("cloud: infrastructure quota exhausted");
  if (localOk && !i.localHasCapacity) reasons.push("local: no capacity (stay queued)");
  return { placement: "BLOCK", reasons };
}
