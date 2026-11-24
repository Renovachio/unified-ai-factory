import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Metrics } from "./score";

export const ThresholdsSchema = z.strictObject({
  version: z.string(),
  note: z.string().optional(),
  minimums: z.strictObject({ reviewRecall: z.number(), securityReviewRecall: z.number(), builderAcceptancePassRate: z.number(), negativeControlEscalationRate: z.number() }),
  maximums: z.strictObject({ reviewFalsePositiveRate: z.number(), riskUnderClassificationRate: z.number(), highRiskAutoMergeAuthorizations: z.number(), p95SecondsPerTask: z.number() }),
  regressionTolerance: z.record(z.string(), z.number()),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const loadThresholds = (configDir: string): Thresholds => ThresholdsSchema.parse(JSON.parse(readFileSync(join(configDir, "eval-thresholds.json"), "utf8")));

export interface ThresholdVerdict { pass: boolean; failures: Array<{ metric: string; value: number; limit: number; kind: "min" | "max" }> }

/** Absolute quality gate for a role/model route. */
export function evaluateThresholds(m: Metrics, t: Thresholds): ThresholdVerdict {
  const failures: ThresholdVerdict["failures"] = [];
  for (const [k, limit] of Object.entries(t.minimums)) { const v = m[k as keyof Metrics]; if (v < limit) failures.push({ metric: k, value: v, limit, kind: "min" }); }
  for (const [k, limit] of Object.entries(t.maximums)) { const v = m[k as keyof Metrics]; if (v > limit) failures.push({ metric: k, value: v, limit, kind: "max" }); }
  return { pass: failures.length === 0, failures };
}

/** Relative regression gate: a candidate may not materially worsen any tracked metric versus the recorded baseline. */
export function compareToBaseline(baseline: Metrics, candidate: Metrics, t: Thresholds): { pass: boolean; regressions: Array<{ metric: string; baseline: number; candidate: number; tolerance: number }> } {
  const higherIsBetter = new Set(["reviewRecall", "securityReviewRecall", "builderAcceptancePassRate", "negativeControlEscalationRate"]);
  const regressions: Array<{ metric: string; baseline: number; candidate: number; tolerance: number }> = [];
  for (const [k, tol] of Object.entries(t.regressionTolerance)) {
    const b = baseline[k as keyof Metrics]; const c = candidate[k as keyof Metrics];
    if (typeof b !== "number" || typeof c !== "number") continue;
    const worse = higherIsBetter.has(k) ? b - c : c - b;
    if (worse > tol + 1e-9) regressions.push({ metric: k, baseline: b, candidate: c, tolerance: tol });
  }
  return { pass: regressions.length === 0, regressions };
}
