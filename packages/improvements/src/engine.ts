import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { GapReport } from "@factory/capabilities";
import { listTree, treeDigest, validateSkillTree, type TreeEntry, type ValidationPolicy, type ValidationReport } from "@factory/skills";

/** One bounded, text-level change. The engine only ever edits a COPY of an approved version in a scratch directory. */
export interface BoundedChange { path: string; find: string; replace: string }
export interface Hypothesis {
  statement: string;
  /** Observable acceptance metric the evaluation will measure. */
  metric: string; baseline: number; target: number; direction: "increase" | "decrease";
  falsifiedIf: string;
}
export interface EvaluationPlan { benchmarkName: string; benchmarkVersion: string; minSamples: number; metric: string; threshold: number; independentEvaluator: true }
export interface ImprovementPlan {
  problem: string; hypothesis: Hypothesis; change: BoundedChange; expectedBenefit: string; risk: "low" | "medium" | "high" | "critical";
  rollbackCriteria: string; evaluationPlan: EvaluationPlan; signalIds: string[];
}
export class EngineError extends Error { constructor(readonly code: "NOT_FALSIFIABLE" | "NOT_BOUNDED" | "NO_ACTION" | "CHANGE_DOES_NOT_APPLY" | "OUTSIDE_COPY", m: string) { super(m); this.name = "EngineError"; } }

export const MAX_CHANGE_LINES = 40;
export function checkFalsifiable(h: Hypothesis): void {
  const ok = h.statement.length >= 20 && h.metric.length > 0 && Number.isFinite(h.baseline) && Number.isFinite(h.target) && h.falsifiedIf.length >= 10
    && (h.direction === "increase" ? h.target > h.baseline : h.target < h.baseline);
  if (!ok) throw new EngineError("NOT_FALSIFIABLE", "hypothesis needs a statement, a metric with baseline and a better target, and an explicit falsification condition");
}
export function checkBounded(c: BoundedChange): void {
  const lines = Math.max(c.find.split("\n").length, c.replace.split("\n").length);
  if (c.find.length === 0 || lines > MAX_CHANGE_LINES || c.replace === c.find) throw new EngineError("NOT_BOUNDED", `exactly one non-empty change of at most ${MAX_CHANGE_LINES} lines is allowed`);
  if (c.path.startsWith("/") || c.path.includes("..") || /^(scripts\/|\.|tests\/)/.test(c.path)) throw new EngineError("NOT_BOUNDED", "changes may only touch SKILL.md or references/, never scripts, hidden files or tests");
}

/** Turns a recurring-omission gap into a plan with a falsifiable hypothesis, a single change, expected benefit, risk and rollback criteria. */
export function planImprovement(gap: GapReport, i: { skillSlug: string; benchmarkName: string; benchmarkVersion: string; minSamples: number; metric: string; baseline: number; target: number; change: BoundedChange; omission: string }): ImprovementPlan {
  if (gap.recommendation !== "revise_skill") throw new EngineError("NO_ACTION", `gap recommends ${gap.recommendation}, not a revision`);
  const hypothesis: Hypothesis = { statement: `Adding an explicit instruction to ${i.skillSlug} about "${i.omission}" will remove the recurring omission`, metric: i.metric, baseline: i.baseline, target: i.target, direction: "increase", falsifiedIf: `the paired evaluation shows no improvement on ${i.metric} (95% CI includes 0) or any new critical failure` };
  checkFalsifiable(hypothesis); checkBounded(i.change);
  return { problem: `${gap.distinctEvidence} distinct events show "${i.omission}" is repeatedly missing (cause ${gap.cause})`, hypothesis, change: i.change, expectedBenefit: `${i.metric} ${i.baseline} → ≥ ${i.target} on benchmark ${i.benchmarkName}@${i.benchmarkVersion}`, risk: gap.risk === "high" ? "high" : "low",
    rollbackCriteria: `roll back or disable if ${i.metric} falls below ${i.baseline} over a monitoring window, or any critical failure appears`, evaluationPlan: { benchmarkName: i.benchmarkName, benchmarkVersion: i.benchmarkVersion, minSamples: i.minSamples, metric: i.metric, threshold: i.target, independentEvaluator: true }, signalIds: [] };
}

export interface CandidateDiff { baselineDigest: string; candidateDigest: string; dir: string; files: TreeEntry[]; diff: string; report: ValidationReport }
/**
 * Applies the single change to a scratch COPY of the approved version and validates it. The approved source directory (and therefore the
 * active skill) is only ever read; nothing is written back to it.
 */
export function generateCandidate(i: { approvedDir: string; scratchBase: string; change: BoundedChange; policy: ValidationPolicy }): CandidateDiff {
  checkBounded(i.change);
  const src = realpathSync(i.approvedDir); const base = realpathSync(i.scratchBase);
  if (base === src || base.startsWith(src + sep) || src.startsWith(base + sep)) throw new EngineError("OUTSIDE_COPY", "scratch directory must be separate from the approved version");
  const baselineDigest = treeDigest(listTree(src).entries);
  const dir = mkdtempSync(join(base, "improve-"));
  cpSync(src, dir, { recursive: true });
  const target = resolve(dir, i.change.path);
  if (!target.startsWith(dir + sep)) throw new EngineError("OUTSIDE_COPY", "path escapes the copy");
  const before = readFileSync(target, "utf8");
  if (before.split(i.change.find).length !== 2) throw new EngineError("CHANGE_DOES_NOT_APPLY", "the text to replace must occur exactly once");
  const after = before.replace(i.change.find, () => i.change.replace);
  writeFileSync(target, after);
  const files = listTree(dir).entries;
  const report = validateSkillTree({ root: dir, origin: { uri: `factory://improvement/${baselineDigest.slice(7, 19)}`, type: "upload" }, policy: i.policy });
  const diff = [`--- a/${i.change.path}`, `+++ b/${i.change.path}`, ...i.change.find.split("\n").map((l) => `-${l}`), ...i.change.replace.split("\n").map((l) => `+${l}`)].join("\n");
  return { baselineDigest, candidateDigest: treeDigest(files), dir, files, diff, report };
}
