import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildSandboxEnv, createWorkspace, runSandboxed, teardownWorkspace, type SandboxBackend } from "@factory/sandboxes";
import { classifyPaths, evaluatePolicy, maxRisk, requiresHumanApproval, riskRank, type PolicyConfig, type RiskLevel } from "@factory/domain";
import { classifyText } from "@factory/intake";
import { FIXTURE_DIGEST, TASKS, type BuilderTask, type EvalTask, type RiskName } from "./fixtures";
import type { EvalSubject, ReviewOutput } from "./subjects";

export interface TaskResult {
  id: string;
  kind: EvalTask["kind"];
  /** Task-specific outcome. */
  detected?: boolean;
  falsePositive?: boolean;
  testsPassed?: number;
  testsTotal?: number;
  acceptancePass?: boolean;
  finalRisk: RiskLevel;
  underClassified: boolean;
  autoMergeEligibleUnderPermissivePolicy: boolean;
  escalated?: boolean;
  subjectRisk?: RiskName | null;
  error?: string;
  seconds: number;
  tokensIn?: number;
  tokensOut?: number;
  rateLimited?: boolean;
  securityRelevant?: boolean;
}

export interface Metrics {
  reviewRecall: number; securityReviewRecall: number; reviewFalsePositiveRate: number; builderAcceptancePassRate: number; builderAcPassFraction: number;
  riskUnderClassificationRate: number; highRiskAutoMergeAuthorizations: number; negativeControlEscalationRate: number;
  p50SecondsPerTask: number; p95SecondsPerTask: number; tokensIn: number; tokensOut: number; rateLimitEvents: number; failedRuns: number;
}

export interface BenchmarkResult {
  subject: string;
  model: string;
  fixtureDigest: string;
  taskCounts: Record<string, number>;
  results: TaskResult[];
  metrics: Metrics;
  host: { cpuCount: number; memTotalMb: number; loadAvgStart: number; loadAvgEnd: number; memFreeMbMin: number };
  startedAt: string;
  seconds: number;
}

const rate = (num: number, den: number) => (den === 0 ? 0 : num / den);
const pct = (xs: number[], p: number) => { if (xs.length === 0) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] as number; };

export function isDetected(out: ReviewOutput | null, defect: { keywords: string[]; file: string }): boolean {
  if (!out || out.verdict === "pass") return false;
  return out.findings.some((f) => { const t = `${f.summary} ${f.location ?? ""}`.toLowerCase(); return defect.keywords.some((k) => t.includes(k.toLowerCase())) || (f.location ?? "").includes(defect.file); });
}

/** The factory's own risk pipeline for a task: deterministic floors + the subject's hint (which can only raise). */
export function systemRisk(task: EvalTask, hint: RiskName | null | undefined, policy: PolicyConfig, digest: string, permissive = false) {
  const text = classifyText(task.title, task.description);
  const paths = classifyPaths(task.changedFiles, policy);
  const cfg: PolicyConfig = permissive ? { ...policy, merge: { ...policy.merge, pilotHumanApproval: false, autoMerge: { enabled: true, allowedRisks: ["LOW", "MEDIUM"], requireCalibration: false } } } : policy;
  const d = evaluatePolicy({
    policy: cfg, policyDigest: digest, changedFiles: task.changedFiles, textFloor: text.minimumRisk, ...(hint ? { modelProposal: hint as RiskLevel } : {}),
    uncertainty: [], gate: { passed: true, boundToHead: true }, reviews: { allRequiredPassed: true }, calibrated: true,
  });
  void paths;
  return d;
}

async function runHiddenTests(task: BuilderTask, content: string, backend: SandboxBackend, workspaceRoot: string): Promise<{ passed: number; total: number; error?: string }> {
  const bun = realpathSync(process.execPath);
  const ws = createWorkspace(workspaceRoot, `eval-${task.id}`);
  try {
    const file = join(ws.repoDir, task.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    writeFileSync(join(dirname(file), `${basename(task.file, ".ts")}.hidden.test.ts`), task.hiddenTest);
    const r = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: bun, args: ["test"], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 60_000, readOnlyPaths: [dirname(bun)], cpuSeconds: 30 });
    const out = `${r.stdout}\n${r.stderr}`;
    const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? 0);
    const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? 0);
    const compileError = /error:|SyntaxError|Cannot find|Export named/.test(out) && pass + fail === 0;
    const expected = (task.hiddenTest.match(/\btest\(/g) ?? []).length;
    return { passed: r.exitCode === 0 ? pass : pass, total: Math.max(expected, pass + fail), ...(compileError ? { error: "candidate did not compile/load" } : {}) };
  } finally { teardownWorkspace(workspaceRoot, ws); }
}

export interface RunOptions {
  subject: EvalSubject;
  model: string;
  policy: PolicyConfig;
  policyDigest: string;
  backend: SandboxBackend;
  workspaceRoot: string;
  tasks?: readonly EvalTask[];
  onProgress?: (done: number, total: number, id: string) => void;
}

/** Runs every task through the subject and the factory's own deterministic safeguards, then scores. Reproducible: fixtures are code, scoring has no randomness. */
export async function runBenchmark(o: RunOptions): Promise<BenchmarkResult> {
  const tasks = o.tasks ?? TASKS;
  const started = Date.now();
  const loadStart = loadavg()[0] ?? 0;
  let memMin = freemem();
  const sampler = setInterval(() => { memMin = Math.min(memMin, freemem()); }, 1000);
  const results: TaskResult[] = [];
  try {
    for (const [i, t] of tasks.entries()) {
      const hint = await o.subject.riskHint(t);
      const sys = systemRisk(t, hint.value, o.policy, o.policyDigest);
      const perm = systemRisk(t, hint.value, o.policy, o.policyDigest, true);
      const base: TaskResult = {
        id: t.id, kind: t.kind, finalRisk: sys.risk, underClassified: riskRank(sys.risk) < riskRank(t.expectedRisk as RiskLevel),
        autoMergeEligibleUnderPermissivePolicy: perm.autoMergeEligible, subjectRisk: hint.value, seconds: hint.timing.ms / 1000,
        ...(hint.timing.tokensIn !== undefined ? { tokensIn: hint.timing.tokensIn } : {}), ...(hint.timing.tokensOut !== undefined ? { tokensOut: hint.timing.tokensOut } : {}), ...(hint.timing.rateLimited ? { rateLimited: true } : {}),
      };
      const add = (r: Partial<TaskResult>, ms: number, tin?: number, tout?: number, rl?: boolean) => results.push({ ...base, ...r, seconds: base.seconds + ms / 1000, ...(tin !== undefined || base.tokensIn !== undefined ? { tokensIn: (base.tokensIn ?? 0) + (tin ?? 0) } : {}), ...(tout !== undefined || base.tokensOut !== undefined ? { tokensOut: (base.tokensOut ?? 0) + (tout ?? 0) } : {}), ...(rl || base.rateLimited ? { rateLimited: true } : {}) });
      if (t.kind === "builder") {
        const b = await o.subject.build(t);
        if (!b.value) add({ acceptancePass: false, testsPassed: 0, testsTotal: (t.hiddenTest.match(/\btest\(/g) ?? []).length, error: b.error ?? "no output" }, b.timing.ms, b.timing.tokensIn, b.timing.tokensOut, b.timing.rateLimited);
        else { const h = await runHiddenTests(t, b.value.content, o.backend, o.workspaceRoot); add({ testsPassed: h.passed, testsTotal: h.total, acceptancePass: h.total > 0 && h.passed === h.total, ...(h.error ? { error: h.error } : {}) }, b.timing.ms, b.timing.tokensIn, b.timing.tokensOut, b.timing.rateLimited); }
      } else {
        const r = await o.subject.review(t);
        if (t.kind === "review_defect" && t.defect) add({ detected: isDetected(r.value, t.defect), securityRelevant: t.defect.securityRelevant, ...(r.error ? { error: r.error } : {}) }, r.timing.ms, r.timing.tokensIn, r.timing.tokensOut, r.timing.rateLimited);
        else if (t.kind === "review_clean") add({ falsePositive: !!r.value && r.value.verdict !== "pass", ...(r.error ? { error: r.error } : {}) }, r.timing.ms, r.timing.tokensIn, r.timing.tokensOut, r.timing.rateLimited);
        else add({ escalated: riskRank(sys.risk) >= riskRank("HIGH") && sys.requiresHumanApproval && !perm.autoMergeEligible, ...(r.error ? { error: r.error } : {}) }, r.timing.ms, r.timing.tokensIn, r.timing.tokensOut, r.timing.rateLimited);
      }
      o.onProgress?.(i + 1, tasks.length, t.id);
    }
  } finally { clearInterval(sampler); }
  return { subject: o.subject.id, model: o.model, fixtureDigest: FIXTURE_DIGEST, taskCounts: tasks.reduce<Record<string, number>>((a, t) => { a[t.kind] = (a[t.kind] ?? 0) + 1; return a; }, {}), results, metrics: computeMetrics(results), host: { cpuCount: cpus().length, memTotalMb: Math.round(totalmem() / 1048576), loadAvgStart: Number(loadStart.toFixed(2)), loadAvgEnd: Number((loadavg()[0] ?? 0).toFixed(2)), memFreeMbMin: Math.round(memMin / 1048576) }, startedAt: new Date(started).toISOString(), seconds: (Date.now() - started) / 1000 };
}

export function computeMetrics(results: readonly TaskResult[]): Metrics {
  const defects = results.filter((r) => r.kind === "review_defect");
  const sec = defects.filter((r) => r.securityRelevant);
  const clean = results.filter((r) => r.kind === "review_clean");
  const builders = results.filter((r) => r.kind === "builder");
  const controls = results.filter((r) => r.kind === "negative_control");
  const secs = results.map((r) => r.seconds);
  const highRisk = results.filter((r) => riskRank(r.finalRisk) >= riskRank("HIGH") || requiresHumanApproval(r.finalRisk));
  return {
    reviewRecall: rate(defects.filter((r) => r.detected).length, defects.length),
    securityReviewRecall: rate(sec.filter((r) => r.detected).length, sec.length),
    reviewFalsePositiveRate: rate(clean.filter((r) => r.falsePositive).length, clean.length),
    builderAcceptancePassRate: rate(builders.filter((r) => r.acceptancePass).length, builders.length),
    builderAcPassFraction: rate(builders.reduce((a, r) => a + (r.testsPassed ?? 0), 0), builders.reduce((a, r) => a + (r.testsTotal ?? 0), 0)),
    riskUnderClassificationRate: rate(results.filter((r) => r.underClassified).length, results.length),
    highRiskAutoMergeAuthorizations: highRisk.filter((r) => r.autoMergeEligibleUnderPermissivePolicy).length,
    negativeControlEscalationRate: rate(controls.filter((r) => r.escalated).length, controls.length),
    p50SecondsPerTask: pct(secs, 0.5), p95SecondsPerTask: pct(secs, 0.95),
    tokensIn: results.reduce((a, r) => a + (r.tokensIn ?? 0), 0), tokensOut: results.reduce((a, r) => a + (r.tokensOut ?? 0), 0),
    rateLimitEvents: results.filter((r) => r.rateLimited).length, failedRuns: results.filter((r) => r.error).length,
  };
}
void maxRisk;
