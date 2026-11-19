import { validateAgentResult } from "@factory/contracts";
import { findForbiddenEnv } from "@factory/domain";
import { PolicyViolation } from "@factory/sandboxes";
import { OutputRejected, parseRoleOutput } from "./output";
import {
  AgentRunRequestSchema, EventSequencer, isReviewRole, toWireResult,
  type AgentRunRequest, type AgentRunResult, type AgentRuntimeAdapter, type EventSink, type ProbeResult,
} from "./types";

export type MockBehavior = "ok" | "slow" | "fail" | "rate_limited" | "bad_output" | "wrong_sha" | "offline";

export interface MockOptions {
  behavior?: MockBehavior;
  /** Per-run wall time in ms for "slow" (default 60s so tests can cancel / time out). */
  slowMs?: number;
  stepMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Override the structured output the mock "model" returns. */
  output?: (req: AgentRunRequest) => unknown;
}

interface Run {
  req: AgentRunRequest;
  abort: AbortController;
  done: Promise<void>;
  result?: AgentRunResult;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Deterministic in-process runtime used by tests and the end-to-end mock pipeline. Spends no tokens and calls no network. */
export class MockAdapter implements AgentRuntimeAdapter {
  readonly id = "mock";
  private readonly runs = new Map<string, Run>();
  private readonly byRequest = new Map<string, string>();
  private n = 0;
  constructor(private readonly o: MockOptions = {}) {}

  async probe(): Promise<ProbeResult> {
    if (this.o.behavior === "offline") return { available: false, adapterId: this.id, reason: "offline", detail: "mock runtime configured offline" };
    return {
      available: true, adapterId: this.id, version: "1.0.0",
      capabilities: { structuredOutput: true, shell: false, toolAllowlist: true, resume: false, tokenTelemetry: false, authMode: "local_model", sandboxModes: ["local", "cloud"] },
    };
  }

  defaultOutput(req: AgentRunRequest): unknown {
    if (isReviewRole(req.role)) return { reviewerRole: req.role.replace("review_", ""), candidateSha: req.candidateSha ?? "0".repeat(40), verdict: "pass", findings: [] };
    return { artifactUri: `mock://${req.jobId}/${req.role}/${req.attempt}.json`, summary: `mock ${req.role} output` };
  }

  async start(request: AgentRunRequest, events: EventSink): Promise<string> {
    const req = AgentRunRequestSchema.parse(request); // strict boundary validation
    const leaked = findForbiddenEnv(this.o.env ?? {});
    if (leaked.length) throw new PolicyViolation("forbidden-env", `refusing to run with ${leaked.join(", ")} present`);
    const existing = this.byRequest.get(req.requestId);
    if (existing) return existing; // idempotent on requestId
    const runId = `run_mock_${++this.n}`;
    this.byRequest.set(req.requestId, runId);
    const abort = new AbortController();
    const seq = new EventSequencer({ runId, jobId: req.jobId, attempt: req.attempt }, events);
    const run: Run = { req, abort, done: Promise.resolve() };
    this.runs.set(runId, run);
    run.done = this.execute(runId, run, seq);
    return runId;
  }

  private async execute(runId: string, run: Run, seq: EventSequencer): Promise<void> {
    const { req, abort } = run;
    const behavior = this.o.behavior ?? "ok";
    const finish = async (r: Omit<AgentRunResult, "runId" | "usageSource" | "inferenceBillingMode">, type: Parameters<EventSequencer["emit"]>[0], payload: Record<string, unknown> = {}) => {
      const result: AgentRunResult = { runId, usageSource: "unavailable", inferenceBillingMode: "local_compute", ...r };
      const contract = validateAgentResult(toWireResult(result));
      if (!contract.ok) throw new Error(`mock produced a contract-invalid result: ${contract.errors.join("; ")}`);
      run.result = result;
      await seq.emit(type, payload);
    };
    try {
      await seq.emit("agent.started", { role: req.role, model: req.modelId });
      const step = this.o.stepMs ?? 1;
      await seq.emit("agent.progress", { message: "working", step: 1 });
      await sleep(step, abort.signal);
      if (abort.signal.aborted) return finish({ exitStatus: "cancelled" }, "agent.cancelled");
      if (behavior === "slow") {
        const wallMs = req.maxWallTimeSec * 1000;
        const workMs = this.o.slowMs ?? 60_000;
        await sleep(Math.min(workMs, wallMs), abort.signal);
        if (abort.signal.aborted) return finish({ exitStatus: "cancelled" }, "agent.cancelled");
        if (workMs >= wallMs) return finish({ exitStatus: "timed_out", failureCode: "wall-time" }, "agent.timed_out", { maxWallTimeSec: req.maxWallTimeSec });
      }
      if (behavior === "rate_limited") {
        await seq.emit("agent.rate_limited", { retry_after_sec: 3600 });
        return finish({ exitStatus: "failed", failureCode: "rate-limited" }, "agent.failed", { code: "rate-limited", fallback: "none-without-operator" });
      }
      if (behavior === "fail") return finish({ exitStatus: "failed", failureCode: "mock-failure" }, "agent.failed", { code: "mock-failure" });
      let out = this.o.output ? this.o.output(req) : this.defaultOutput(req);
      if (behavior === "bad_output") out = { nonsense: true };
      if (behavior === "wrong_sha" && isReviewRole(req.role)) out = { ...(out as object), candidateSha: "f".repeat(40) };
      try {
        const parsed = parseRoleOutput(req.role, out, { maxBytes: req.maxOutputBytes, expectedSha: req.candidateSha });
        await seq.emit("agent.artifact", { role: req.role });
        const artifactUri = "artifactUri" in parsed ? parsed.artifactUri : `mock://${req.jobId}/${req.role}/${req.attempt}.json`;
        const candidateSha = "candidateSha" in parsed ? parsed.candidateSha : undefined;
        return await finish({ exitStatus: "succeeded", artifactUri, ...(candidateSha ? { candidateSha } : {}), output: parsed }, "agent.completed");
      } catch (e) {
        if (!(e instanceof OutputRejected)) throw e;
        return await finish({ exitStatus: "failed", failureCode: `output-${e.code}` }, "agent.failed", { code: `output-${e.code}`, message: e.message });
      }
    } catch (e) {
      if (!seq.terminal) {
        run.result = { runId, exitStatus: "failed", usageSource: "unavailable", inferenceBillingMode: "local_compute", failureCode: "adapter-error" };
        await seq.emit("agent.failed", { code: "adapter-error", message: e instanceof Error ? e.message : "error" });
      }
    }
  }

  async status(runId: string): Promise<AgentRunResult | { exitStatus: "running" }> {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`unknown run ${runId}`);
    return r.result ?? { exitStatus: "running" };
  }

  async cancel(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) return;
    r.abort.abort();
    await r.done;
  }
}
