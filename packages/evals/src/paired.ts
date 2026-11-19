import { createHash } from "node:crypto";

/** Deterministic JSON so benchmark digests do not depend on key order. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canon(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
export const sha = (v: unknown): string => `sha256:${createHash("sha256").update(typeof v === "string" ? v : canon(v)).digest("hex")}`;

export type Check =
  | { type: "contains"; value: string; critical?: boolean }
  | { type: "regex"; pattern: string; flags?: string; critical?: boolean }
  | { type: "not_contains"; value: string; critical?: boolean }
  | { type: "cites_source"; sources: string[]; critical?: boolean }
  | { type: "no_invented_names"; allowed: string[]; critical?: boolean };
export interface BenchmarkTask { id: string; role: string; input: string; sources?: string[]; checks: Check[]; rubric?: string[] }
export interface Benchmark {
  name: string; version: string; role: string;
  /** Visible to the generator/candidate. */
  tasks: BenchmarkTask[];
  /** Hidden from generators; scored only by the evaluator. */
  holdout: BenchmarkTask[];
  graderId: string;
  /** Minimum number of tasks (visible + holdout) for any confidence claim. */
  minSamples: number;
  /** Minimum candidate mean score for this role. */
  roleThreshold: number;
}
export interface BenchmarkDigests { benchmark: string; holdout: string; grader: string }
export const benchmarkDigests = (b: Benchmark): BenchmarkDigests => ({ benchmark: sha({ name: b.name, version: b.version, role: b.role, tasks: b.tasks, holdout: b.holdout, graderId: b.graderId, minSamples: b.minSamples, roleThreshold: b.roleThreshold }), holdout: sha(b.holdout), grader: sha({ graderId: b.graderId, checks: [...b.tasks, ...b.holdout].map((t) => [t.id, t.checks, t.rubric ?? []]) }) });

/** A subject (baseline or candidate) sees ONLY the frozen, visible task input. */
export interface PairedSubject { id: string; digest: string; runtime: string; run(task: Readonly<Pick<BenchmarkTask, "id" | "role" | "input" | "sources">>): Promise<{ output: string; cited?: string[] }> }
/** Independent reviewer: must not be one of the subjects. Returns rubric score 0..1 per task plus any critical safety flags. */
export interface IndependentGrader { id: string; review(task: Readonly<BenchmarkTask>, output: string): Promise<{ rubricScore: number; criticalFlags: string[] }> }

export interface TaskOutcome { taskId: string; holdout: boolean; baseline: number; candidate: number; criticalBaseline: string[]; criticalCandidate: string[] }
export interface ComparisonReport {
  schemaVersion: "2.2"; candidateDigest: string; baselineDigest: string; benchmarkDigest: string; policyDigest: string;
  status: "passed" | "failed" | "insufficient_evidence";
  metrics: Record<string, number>; criticalRegressions: number; sampleSize: number; uncertaintyNotes: string; evidenceUris: string[];
  runtimeProvenance: Record<string, unknown>;
  reasons: string[];
  outcomes: TaskOutcome[];
  recommendation: "recommend_approval" | "do_not_recommend";
}

/** Deterministic checks: format, provenance, invented-entity guard. Returns score 0..1 and critical failures. */
export function deterministicScore(task: Readonly<BenchmarkTask>, output: string, cited: readonly string[] = []): { score: number; critical: string[] } {
  if (task.checks.length === 0) return { score: 1, critical: [] };
  let passed = 0; const critical: string[] = [];
  for (const c of task.checks) {
    let ok: boolean;
    switch (c.type) {
      case "contains": ok = output.toLowerCase().includes(c.value.toLowerCase()); break;
      case "not_contains": ok = !output.toLowerCase().includes(c.value.toLowerCase()); break;
      case "regex": ok = new RegExp(c.pattern, c.flags ?? "i").test(output.slice(0, 200_000)); break;
      case "cites_source": ok = c.sources.length > 0 && c.sources.every((s) => cited.includes(s) || output.includes(`[${s}]`)); break;
      case "no_invented_names": { const names = [...output.matchAll(/\b(?:Participant|Attendee|Speaker):\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)/g)].map((m) => m[1] as string); ok = names.every((n) => c.allowed.includes(n)); break; }
    }
    if (ok) passed++; else if (c.critical) critical.push(`${c.type}${"value" in c ? `:${c.value}` : ""}`);
  }
  return { score: passed / task.checks.length, critical };
}

// seeded PRNG so the confidence interval is reproducible byte-for-byte
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function pairedBootstrap(diffs: readonly number[], iters = 2000, seed = 20261119): { mean: number; lo: number; hi: number } {
  const n = diffs.length; if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const rnd = mulberry32(seed); const means: number[] = [];
  for (let i = 0; i < iters; i++) { let s = 0; for (let j = 0; j < n; j++) s += diffs[Math.floor(rnd() * n)] as number; means.push(s / n); }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(0.025 * iters)] as number, hi: means[Math.floor(0.975 * iters)] as number };
}

const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object") { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); } return o; };

export interface CompareInput {
  benchmark: Benchmark;
  /** Digests recorded in the registry when the benchmark was locked. Any drift aborts the comparison. */
  lockedDigests: BenchmarkDigests;
  baseline: PairedSubject; candidate: PairedSubject; grader: IndependentGrader;
  policyDigest: string;
  /** Runtimes the policy allows; anything else is an unsupported provider runtime and stops promotion. */
  allowedRuntimes: readonly string[];
  /** Weights of deterministic vs rubric components in the final per-task score. */
  weights?: { deterministic: number; rubric: number };
  /** Required lower bound on (candidate − baseline) mean difference. Default 0.0 + strictly above: a real improvement must be shown. */
  minImprovement?: number;
  /** Provenance: the data used must be flagged valid by the dataset owner. */
  dataProvenanceValid: boolean;
}
export class ComparisonAborted extends Error { constructor(readonly code: "BENCHMARK_DRIFT" | "GRADER_NOT_INDEPENDENT" | "IDENTICAL_SUBJECTS", m: string) { super(m); this.name = "ComparisonAborted"; } }

/** Runs baseline and candidate on identical frozen inputs/settings, grades with deterministic checks + an independent reviewer, reports uncertainty. */
export async function runPairedComparison(i: CompareInput): Promise<ComparisonReport> {
  const d = benchmarkDigests(i.benchmark);
  if (d.benchmark !== i.lockedDigests.benchmark || d.holdout !== i.lockedDigests.holdout || d.grader !== i.lockedDigests.grader) throw new ComparisonAborted("BENCHMARK_DRIFT", "benchmark, holdout or grader differs from the locked digests");
  if (i.grader.id === i.candidate.id || i.grader.id === i.baseline.id || i.grader.id === i.benchmark.graderId + ":candidate") throw new ComparisonAborted("GRADER_NOT_INDEPENDENT", "the grader must be independent of both subjects");
  if (i.candidate.digest === i.baseline.digest) throw new ComparisonAborted("IDENTICAL_SUBJECTS", "candidate and baseline have the same digest");
  const w = i.weights ?? { deterministic: 0.6, rubric: 0.4 };
  const all: Array<[BenchmarkTask, boolean]> = [...i.benchmark.tasks.map((t): [BenchmarkTask, boolean] => [t, false]), ...i.benchmark.holdout.map((t): [BenchmarkTask, boolean] => [t, true])];
  const outcomes: TaskOutcome[] = [];
  for (const [task, hold] of all) {
    const view = deepFreeze(structuredClone({ id: task.id, role: task.role, input: task.input, ...(task.sources ? { sources: task.sources } : {}) }));
    const one = async (s: PairedSubject) => {
      let out: { output: string; cited?: string[] };
      try { out = await s.run(view); } catch { return { score: 0, critical: ["subject_error"] }; }
      const det = deterministicScore(task, out.output, out.cited ?? []);
      const rev = await i.grader.review(deepFreeze(structuredClone(task)), out.output);
      return { score: w.deterministic * det.score + w.rubric * Math.max(0, Math.min(1, rev.rubricScore)), critical: [...det.critical, ...rev.criticalFlags] };
    };
    const [b, c] = [await one(i.baseline), await one(i.candidate)];
    outcomes.push({ taskId: task.id, holdout: hold, baseline: b.score, candidate: c.score, criticalBaseline: b.critical, criticalCandidate: c.critical });
  }
  // Tamper check: nothing a subject did may have changed what we graded against.
  const after = benchmarkDigests(i.benchmark);
  if (after.benchmark !== d.benchmark) throw new ComparisonAborted("BENCHMARK_DRIFT", "benchmark changed during the run");

  const n = outcomes.length;
  const diffs = outcomes.map((o) => o.candidate - o.baseline);
  const ci = pairedBootstrap(diffs);
  const candMean = n ? outcomes.reduce((a, o) => a + o.candidate, 0) / n : 0;
  const baseMean = n ? outcomes.reduce((a, o) => a + o.baseline, 0) / n : 0;
  // A critical regression is a critical failure the candidate has and the baseline does not on the same task.
  const criticalRegressions = outcomes.filter((o) => o.criticalCandidate.some((c) => !o.criticalBaseline.includes(c))).length;
  const reasons: string[] = []; let status: ComparisonReport["status"] = "passed";
  const fail = (r: string) => { reasons.push(r); status = "failed"; };
  const insufficient = (r: string) => { reasons.push(r); if (status !== "failed") status = "insufficient_evidence"; };
  if (!i.allowedRuntimes.includes(i.candidate.runtime) || !i.allowedRuntimes.includes(i.baseline.runtime)) fail(`unsupported provider runtime (${i.candidate.runtime}/${i.baseline.runtime})`);
  if (!i.dataProvenanceValid) fail("invalid data provenance");
  if (criticalRegressions > 0) fail(`${criticalRegressions} critical safety regression(s)`);
  if (candMean < i.benchmark.roleThreshold) fail(`candidate mean ${candMean.toFixed(3)} below role threshold ${i.benchmark.roleThreshold}`);
  if (n < i.benchmark.minSamples) insufficient(`sample size ${n} < required ${i.benchmark.minSamples}`);
  const need = i.minImprovement ?? 0;
  if (n >= 1 && !(ci.lo > need)) insufficient(`95% CI of improvement [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] does not exclude ${need}; an apparent gain of ${ci.mean.toFixed(3)} is not enough`);
  if (reasons.length === 0) reasons.push("all gates passed");
  return {
    schemaVersion: "2.2", candidateDigest: i.candidate.digest, baselineDigest: i.baseline.digest, benchmarkDigest: d.benchmark, policyDigest: i.policyDigest, status,
    metrics: { candidateMean: candMean, baselineMean: baseMean, meanImprovement: ci.mean, ciLow: ci.lo, ciHigh: ci.hi, holdoutCandidateMean: mean(outcomes.filter((o) => o.holdout).map((o) => o.candidate)), holdoutBaselineMean: mean(outcomes.filter((o) => o.holdout).map((o) => o.baseline)) },
    criticalRegressions, sampleSize: n,
    uncertaintyNotes: `paired bootstrap (2000 resamples, fixed seed) over ${n} tasks (${i.benchmark.holdout.length} holdout); deterministic checks weigh ${w.deterministic}, independent rubric ${w.rubric}; small samples widen the interval and block recommendation`,
    evidenceUris: [], runtimeProvenance: { candidate: i.candidate.runtime, baseline: i.baseline.runtime, grader: i.grader.id, benchmark: `${i.benchmark.name}@${i.benchmark.version}`, sameSettings: true },
    reasons, outcomes, recommendation: status === "passed" ? "recommend_approval" : "do_not_recommend",
  };
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
