import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Roles that require a current qualification record before any model may serve them. */
export const CRITICAL_ROLES = ["builder", "review_code", "review_security", "spec"] as const;

const Target = z.strictObject({ metric: z.string().min(1), minRate: z.number().min(0).max(1), minSamples: z.number().int().positive() });
const Record_ = z.strictObject({
  adapterId: z.string().min(1),
  modelId: z.string().min(1),
  role: z.string().min(1),
  promptVersion: z.string().min(1),
  /** Digest of the tool schemas/loop configuration that was benchmarked: a different tool config is a different candidate. */
  toolsetDigest: z.string().min(1),
  harnessVersion: z.string().min(1),
  datasetVersion: z.string().min(1),
  datasetDigest: z.string().min(1),
  samples: z.number().int().positive(),
  passes: z.number().int().min(0),
  criticalMisses: z.number().int().min(0),
  criticalPolicyViolations: z.number().int().min(0),
  falsePositives: z.number().int().min(0).optional(),
  usedRealToolLoop: z.boolean(),
  resultsPath: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedOn: z.string().min(1),
  expiresOn: z.string().min(1),
  revokedOn: z.string().optional(),
});
export const QualificationRegistrySchema = z.strictObject({
  version: z.string(), note: z.string().optional(),
  roleTargets: z.record(z.string(), Target),
  maxValidityDays: z.number().int().positive(),
  qualifications: z.array(Record_),
});
export type QualificationRegistry = z.infer<typeof QualificationRegistrySchema>;
export type QualificationRecord = z.infer<typeof Record_>;

export const loadQualificationRegistry = (configDir: string): QualificationRegistry =>
  QualificationRegistrySchema.parse(JSON.parse(readFileSync(join(configDir, "model-qualification.json"), "utf8")));

/** Wilson score lower bound (95%): honest uncertainty for small samples. */
export function wilsonLower(passes: number, n: number, z95 = 1.96): number {
  if (n === 0) return 0;
  const p = passes / n; const z2 = z95 * z95;
  return (p + z2 / (2 * n) - z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

export interface Candidate { adapterId: string; modelId: string; role: string; promptVersion: string; toolsetDigest: string }
export type Qualified = { ok: true; record: QualificationRecord } | { ok: false; reasons: string[] };

/** Why (or whether) this exact candidate may serve a role. Non-critical roles need no record. Never partially matches. */
export function checkQualification(reg: QualificationRegistry, c: Candidate, now = new Date()): Qualified {
  if (!(CRITICAL_ROLES as readonly string[]).includes(c.role)) return { ok: false, reasons: [`role ${c.role} has no qualification target`] };
  const target = reg.roleTargets[c.role];
  if (!target) return { ok: false, reasons: [`no target configured for role ${c.role}`] };
  const mine = reg.qualifications.filter((q) => q.adapterId === c.adapterId && q.modelId === c.modelId && q.role === c.role && q.promptVersion === c.promptVersion && q.toolsetDigest === c.toolsetDigest);
  if (mine.length === 0) return { ok: false, reasons: [`no qualification record for ${c.adapterId}/${c.modelId} as ${c.role} with this prompt version and tool configuration`] };
  const reasons: string[] = [];
  for (const q of mine) {
    const r: string[] = [];
    if (q.revokedOn) r.push(`revoked on ${q.revokedOn}`);
    if (Date.parse(q.expiresOn) <= now.getTime()) r.push(`expired ${q.expiresOn}`);
    if (Date.parse(q.expiresOn) - Date.parse(q.approvedOn) > reg.maxValidityDays * 86_400_000) r.push(`validity exceeds ${reg.maxValidityDays} days`);
    if (q.samples < target.minSamples) r.push(`only ${q.samples} samples (< ${target.minSamples})`);
    if (q.passes > q.samples) r.push("passes exceed samples");
    const rate = q.samples ? q.passes / q.samples : 0;
    if (rate < target.minRate) r.push(`${target.metric} ${rate.toFixed(3)} < ${target.minRate}`);
    if (wilsonLower(q.passes, q.samples) < target.minRate - 0.15) r.push(`95% lower bound ${wilsonLower(q.passes, q.samples).toFixed(3)} too uncertain for target ${target.minRate}`);
    if (q.criticalMisses > 0) r.push(`${q.criticalMisses} critical misses`);
    if (q.criticalPolicyViolations > 0) r.push(`${q.criticalPolicyViolations} critical policy violations`);
    if (c.role === "builder" && !q.usedRealToolLoop) r.push("builder qualification must use the real tool loop");
    if (r.length === 0) return { ok: true, record: q };
    reasons.push(...r);
  }
  return { ok: false, reasons };
}
