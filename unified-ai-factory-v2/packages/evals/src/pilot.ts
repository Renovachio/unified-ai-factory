import { digestOf } from "@factory/telemetry";
import { z } from "zod";
import { FIXTURE_DIGEST } from "./fixtures";
import { evaluateThresholds, type Thresholds } from "./thresholds";
import type { Metrics } from "./score";

export const PilotReportSchema = z.strictObject({
  evalRunDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  fixtureDigest: z.string(),
  route: z.strictObject({ subject: z.string().min(1), model: z.string().min(1) }),
  metrics: z.strictObject({
    reviewRecall: z.number(), securityReviewRecall: z.number(), reviewFalsePositiveRate: z.number(), builderAcceptancePassRate: z.number(), builderAcPassFraction: z.number(),
    riskUnderClassificationRate: z.number(), highRiskAutoMergeAuthorizations: z.number(), negativeControlEscalationRate: z.number(), p50SecondsPerTask: z.number(), p95SecondsPerTask: z.number(),
    tokensIn: z.number(), tokensOut: z.number(), rateLimitEvents: z.number(), failedRuns: z.number(),
  }),
  pilot: z.strictObject({ tasks: z.number().int(), repositories: z.number().int(), seededDefects: z.number().int(), negativeControls: z.number().int(), manualMerges: z.number().int(), escapedDefects: z.number().int(), unauthorizedAutoMerges: z.number().int() }),
  signedOffBy: z.string().min(1),
  signedOffOn: z.string().min(1),
  rollbackPlan: z.string().min(20),
});
export type PilotReport = z.infer<typeof PilotReportSchema>;

/** Blueprint section 17 calibration gate: >= 30 varied tasks over 3 repositories, >= 10 seeded defects, >= 5 high-risk controls, zero escapes, signed. */
export const MIN_PILOT = { tasks: 30, repositories: 3, seededDefects: 10, negativeControls: 5, manualMerges: 10 } as const;

export function validatePilotReport(input: unknown, thresholds: Thresholds, currentFixtureDigest: string = FIXTURE_DIGEST): { ok: boolean; reasons: string[]; digest?: string } {
  const p = PilotReportSchema.safeParse(input);
  if (!p.success) return { ok: false, reasons: p.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "/"}: ${i.message}`) };
  const r = p.data;
  const reasons: string[] = [];
  if (r.fixtureDigest !== currentFixtureDigest) reasons.push("pilot report was produced against a different benchmark fixture set than the current one");
  const v = evaluateThresholds(r.metrics as Metrics, thresholds);
  for (const f of v.failures) reasons.push(`route misses threshold ${f.metric} (${f.value} ${f.kind === "min" ? "<" : ">"} ${f.limit})`);
  for (const [k, min] of Object.entries(MIN_PILOT)) { const have = (r.pilot as Record<string, number>)[k] ?? 0; if (have < min) reasons.push(`pilot ${k} ${have} is below the required ${min}`); }
  if (r.pilot.escapedDefects !== 0) reasons.push("pilot had escaped defects");
  if (r.pilot.unauthorizedAutoMerges !== 0) reasons.push("pilot had unauthorised automatic merges");
  return reasons.length ? { ok: false, reasons } : { ok: true, reasons: [], digest: digestOf(r) };
}
