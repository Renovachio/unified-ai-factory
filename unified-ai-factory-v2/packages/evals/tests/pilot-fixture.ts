import { FIXTURE_DIGEST, type PilotReport } from "../src/index";

export const goodPilot = (): PilotReport => ({
  evalRunDigest: "sha256:" + "e".repeat(64), fixtureDigest: FIXTURE_DIGEST, route: { subject: "reviewer-route", model: "approved-model" },
  metrics: { reviewRecall: 0.95, securityReviewRecall: 0.97, reviewFalsePositiveRate: 0.1, builderAcceptancePassRate: 0.93, builderAcPassFraction: 0.9, riskUnderClassificationRate: 0, highRiskAutoMergeAuthorizations: 0, negativeControlEscalationRate: 1, p50SecondsPerTask: 10, p95SecondsPerTask: 60, tokensIn: 0, tokensOut: 0, rateLimitEvents: 0, failedRuns: 0 },
  pilot: { tasks: 30, repositories: 3, seededDefects: 10, negativeControls: 5, manualMerges: 12, escapedDefects: 0, unauthorizedAutoMerges: 0 },
  signedOffBy: "operator@example.test", signedOffOn: "2026-12-01", rollbackPlan: "Engage the global kill switch; revert merged PRs through the normal PR process; return the repository to manual merging.",
});
