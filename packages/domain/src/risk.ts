export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const riskRank = (r: RiskLevel): number => RISK_LEVELS.indexOf(r);
export const maxRisk = (...rs: RiskLevel[]): RiskLevel =>
  rs.reduce<RiskLevel>((a, b) => (riskRank(b) > riskRank(a) ? b : a), "LOW");

/**
 * Deterministic classifiers set the floor; an LLM proposal can only raise it.
 * Unknown data resolves to the higher level (here: CRITICAL if nothing is known at all).
 */
export function effectiveRisk(deterministicMinimum: RiskLevel | undefined, proposed: RiskLevel | undefined): RiskLevel {
  if (deterministicMinimum === undefined && proposed === undefined) return "CRITICAL";
  if (deterministicMinimum === undefined) return maxRisk(proposed as RiskLevel, "HIGH");
  return proposed === undefined ? maxRisk(deterministicMinimum, "MEDIUM") : maxRisk(deterministicMinimum, proposed);
}

/** HIGH and CRITICAL changes are never eligible for unattended merge. */
export const requiresHumanApproval = (r: RiskLevel): boolean => riskRank(r) >= riskRank("HIGH");
