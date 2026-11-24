import { describe, expect, test } from "bun:test";
import { benchmarkDigests, ComparisonAborted, deterministicScore, PM_BENCHMARKS, pairedBootstrap, runPairedComparison, type Benchmark, type CompareInput, type IndependentGrader, type PairedSubject } from "../src/index";

/** Synthetic benchmark with `n` tasks, each requiring a keyword; so we can make subjects of exactly known quality. */
function bench(n: number, holdout = 2, over: Partial<Benchmark> = {}): Benchmark {
  const mk = (i: number) => ({ id: `t${i}`, role: "pm.test", input: `task ${i}`, checks: [{ type: "contains" as const, value: "alpha" }, { type: "contains" as const, value: "beta" }, { type: "not_contains" as const, value: "forbidden", critical: true }] });
  return { name: "synthetic", version: "1", role: "pm.test", graderId: "grader:x", minSamples: 20, roleThreshold: 0.6, tasks: Array.from({ length: n - holdout }, (_, i) => mk(i)), holdout: Array.from({ length: holdout }, (_, i) => mk(1000 + i)), ...over };
}
const subject = (id: string, f: (taskId: string) => string, runtime = "local_model"): PairedSubject => ({ id, digest: `sha256:${id.padEnd(64, "0").slice(0, 64)}`, runtime, run: async (t) => ({ output: f(t.id) }) });
const grader: IndependentGrader = { id: "grader:independent", review: async (_t, out) => ({ rubricScore: out.includes("alpha") && out.includes("beta") ? 1 : out.includes("alpha") ? 0.5 : 0, criticalFlags: [] }) };
const base = (b: Benchmark, o: Partial<CompareInput> = {}): CompareInput => ({ benchmark: b, lockedDigests: benchmarkDigests(b), baseline: subject("base", () => "alpha"), candidate: subject("cand", () => "alpha beta"), grader, policyDigest: "sha256:" + "p".repeat(64), allowedRuntimes: ["local_model", "claude_code_cli"], dataProvenanceValid: true, ...o });

describe("SAI-09 paired evaluator (T-20, T-21, T-24)", () => {
  test("same benchmark digest, quality metrics, critical failures, sample size and limitations are all reported; clear improvement with enough samples passes", async () => {
    const b = bench(40, 8);
    const r = await runPairedComparison(base(b));
    expect(r).toMatchObject({ status: "passed", recommendation: "recommend_approval", sampleSize: 40, criticalRegressions: 0, schemaVersion: "2.2", benchmarkDigest: benchmarkDigests(b).benchmark });
    expect(r.metrics.candidateMean).toBeGreaterThan(r.metrics.baselineMean!);
    expect(r.metrics.ciLow).toBeGreaterThan(0);
    expect(r.uncertaintyNotes).toMatch(/bootstrap.*holdout/);
    expect(r.runtimeProvenance).toMatchObject({ sameSettings: true, grader: "grader:independent" });
    expect(r.outcomes.filter((o) => o.holdout)).toHaveLength(8);
  });
  test("insufficient confidence blocks the recommendation EVEN for an apparent improvement (too few samples)", async () => {
    const r = await runPairedComparison(base(bench(6, 2)));
    expect(r.metrics.meanImprovement).toBeGreaterThan(0.2);
    expect(r).toMatchObject({ status: "insufficient_evidence", recommendation: "do_not_recommend" });
    expect(r.reasons.join(" ")).toMatch(/sample size 6 < required 20/);
  });
  test("a noisy 'improvement' whose interval includes zero is not recommended even with enough samples", async () => {
    const b = bench(40, 8);
    // candidate better on 1 task, worse on 1, equal elsewhere: mean diff ~0 -> CI straddles 0
    const cand = subject("cand", (id) => (id === "t1" ? "alpha beta" : id === "t2" ? "" : "alpha"));
    const r = await runPairedComparison(base(b, { candidate: cand }));
    expect(r.status).not.toBe("passed");
    expect(r.recommendation).toBe("do_not_recommend");
  });
  test("a critical safety regression fails promotion even if the mean improved", async () => {
    const b = bench(40, 8);
    const cand = subject("cand", (id) => (id === "t3" ? "alpha beta forbidden" : "alpha beta"));
    const r = await runPairedComparison(base(b, { candidate: cand }));
    expect(r.criticalRegressions).toBe(1);
    expect(r).toMatchObject({ status: "failed", recommendation: "do_not_recommend" });
    expect(r.metrics.meanImprovement).toBeGreaterThan(0);
  });
  test("role threshold, invalid data provenance and unsupported runtime each stop promotion", async () => {
    const b = bench(40, 8, { roleThreshold: 0.8 });
    const weak = await runPairedComparison(base(b, { baseline: subject("base", () => ""), candidate: subject("cand", () => "alpha") }));
    expect(weak.status).toBe("failed"); expect(weak.reasons.join(" ")).toMatch(/below role threshold/);
    expect((await runPairedComparison(base(b, { dataProvenanceValid: false }))).reasons.join(" ")).toMatch(/provenance/);
    const rt = await runPairedComparison(base(b, { candidate: subject("cand", () => "alpha beta", "openai_api") }));
    expect(rt.status).toBe("failed"); expect(rt.reasons.join(" ")).toMatch(/unsupported provider runtime/);
  });
  test("the candidate cannot edit the grader/holdout: inputs are frozen, the holdout is never shown, and drift aborts the run", async () => {
    const b = bench(40, 8);
    const seen: string[] = []; let mutated = false;
    const sneaky: PairedSubject = { id: "cand", digest: "sha256:" + "c".repeat(64), runtime: "local_model", run: async (t) => { seen.push(Object.keys(t).sort().join(",")); try { (t as { input: string }).input = "hacked"; mutated = true; } catch { /* frozen */ } return { output: "alpha beta" }; } };
    const r = await runPairedComparison(base(b, { candidate: sneaky }));
    expect(mutated).toBe(false);                      // frozen view
    // subjects get only {id, role, input[, sources]}: never the checks, rubric, expected values or grader (holdout INPUTS must be run to be scored, its answers stay hidden)
    expect(new Set(seen)).toEqual(new Set(["id,input,role"]));
    expect(r.outcomes.filter((o) => o.holdout).length).toBe(8);
    // a subject that mutates the in-process benchmark/holdout is detected and the whole comparison is void
    const b2 = bench(40, 8);
    const tamperer: PairedSubject = { id: "cand2", digest: "sha256:" + "e".repeat(64), runtime: "local_model", run: async () => { b2.holdout.length = 0; return { output: "alpha beta" }; } };
    await expect(runPairedComparison(base(b2, { candidate: tamperer }))).rejects.toMatchObject({ code: "BENCHMARK_DRIFT" });
    // locked digests that do not match the benchmark abort the run before any model is called
    const tampered = { ...bench(40, 8), roleThreshold: 0.0 };
    await expect(runPairedComparison({ ...base(b), benchmark: tampered })).rejects.toMatchObject({ code: "BENCHMARK_DRIFT" });
    const holdoutSwapped = { ...b, holdout: b.holdout.slice(0, 7) };
    await expect(runPairedComparison({ ...base(b), benchmark: holdoutSwapped })).rejects.toBeInstanceOf(ComparisonAborted);
  });
  test("the grader must be independent of both subjects; identical subjects are refused", async () => {
    const b = bench(40, 8);
    await expect(runPairedComparison(base(b, { grader: { ...grader, id: "cand" } }))).rejects.toMatchObject({ code: "GRADER_NOT_INDEPENDENT" });
    await expect(runPairedComparison(base(b, { candidate: subject("base", () => "x") }))).rejects.toMatchObject({ code: "IDENTICAL_SUBJECTS" });
  });
  test("a subject that throws scores zero with a critical flag instead of aborting the comparison", async () => {
    const b = bench(40, 8);
    const boom: PairedSubject = { id: "cand", digest: "sha256:" + "d".repeat(64), runtime: "local_model", run: async () => { throw new Error("model down"); } };
    const r = await runPairedComparison(base(b, { candidate: boom }));
    expect(r.status).toBe("failed"); expect(r.criticalRegressions).toBe(40);
  });
  test("bootstrap is reproducible", () => { expect(pairedBootstrap([0.1, 0.2, 0.0, 0.3, 0.1])).toEqual(pairedBootstrap([0.1, 0.2, 0.0, 0.3, 0.1])); expect(pairedBootstrap([])).toEqual({ mean: 0, lo: 0, hi: 0 }); });
});

describe("deterministic checks and the starter PM benchmarks", () => {
  test("format/provenance/invented-name checks", () => {
    const task = { id: "x", role: "r", input: "i", checks: [{ type: "cites_source" as const, sources: ["S1"], critical: true }, { type: "no_invented_names" as const, allowed: ["Ana Silva"], critical: true }] };
    expect(deterministicScore(task, "Claim [S1]. Participant: Ana Silva").score).toBe(1);
    expect(deterministicScore(task, "Claim. Participant: Zed Zimmer")).toEqual({ score: 0, critical: ["cites_source", "no_invented_names"] });
    expect(deterministicScore({ ...task, checks: [{ type: "regex", pattern: "^(a+)+$" }] }, "a".repeat(30) + "!").score).toBeDefined();
  });
  test("starter benchmarks cover the six required roles, have a hidden holdout, stable digests — and are honestly below min samples", () => {
    expect(PM_BENCHMARKS.map((b) => b.role).sort()).toEqual(["eng.security", "pm.analytics", "pm.meeting", "pm.prd", "pm.research", "pm.user_story"]);
    for (const b of PM_BENCHMARKS) {
      expect(b.holdout.length).toBeGreaterThan(0);
      expect(b.tasks.length + b.holdout.length).toBeLessThan(b.minSamples); // cannot yield a "passed" claim until grown
      expect(benchmarkDigests(b)).toEqual(benchmarkDigests(structuredClone(b)));
      const ids = [...b.tasks, ...b.holdout].map((x) => x.id); expect(new Set(ids).size).toBe(ids.length);
    }
  });
  test("an oracle on a starter benchmark still cannot pass: insufficient evidence", async () => {
    const b = PM_BENCHMARKS[3] as Benchmark;
    const oracle: PairedSubject = subject("oracle", () => "As a user I want x so that y. Given a state When it happens Then ok. acceptance criteria traceability");
    const r = await runPairedComparison({ ...base(b), lockedDigests: benchmarkDigests(b), baseline: subject("empty", () => ""), candidate: oracle, grader: { id: "grader:ind", review: async () => ({ rubricScore: 1, criticalFlags: [] }) } });
    expect(r.status).toBe("insufficient_evidence"); expect(r.recommendation).toBe("do_not_recommend");
  });
});
