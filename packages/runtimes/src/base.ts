import { PolicyViolation } from "@factory/sandboxes";
import {
  AgentRunRequestSchema, EventSequencer, toWireResult,
  type AgentRunRequest, type AgentRunResult, type AgentRuntimeAdapter, type EventSink, type ProbeResult, type TerminalType,
} from "./types";
import { validateAgentResult } from "@factory/contracts";

export interface RunContext {
  runId: string;
  request: AgentRunRequest;
  signal: AbortSignal;
  seq: EventSequencer;
  /** Why the signal fired, if it did. */
  abortReason(): "cancelled" | "timed_out" | null;
  /** Record the final result and emit the (single) terminal event. */
  finish(result: Omit<AgentRunResult, "runId" | "usageSource" | "inferenceBillingMode"> & Partial<Pick<AgentRunResult, "usageSource" | "inferenceBillingMode">>, type: TerminalType, payload?: Record<string, unknown>): Promise<void>;
}

interface Run { abort: AbortController; done: Promise<void>; result?: AgentRunResult }

/**
 * Shared run bookkeeping for real adapters: strict request validation, policy preflight before anything executes,
 * requestId idempotency, wall-time enforcement, idempotent cancel, and guaranteed single terminal event.
 */
export abstract class BaseRunAdapter implements AgentRuntimeAdapter {
  private readonly runs = new Map<string, Run>();
  private readonly byRequest = new Map<string, string>();
  private n = 0;
  protected constructor(readonly id: string, private readonly defaults: Pick<AgentRunResult, "inferenceBillingMode"> & { usageSource: AgentRunResult["usageSource"] }) {}

  abstract probe(): Promise<ProbeResult>;
  /** Throw PolicyViolation to refuse the run before any process/network activity. */
  protected abstract preflight(request: AgentRunRequest): Promise<void> | void;
  protected abstract execute(ctx: RunContext): Promise<void>;

  async start(request: AgentRunRequest, events: EventSink): Promise<string> {
    const req = AgentRunRequestSchema.parse(request);
    await this.preflight(req);
    const existing = this.byRequest.get(req.requestId);
    if (existing) return existing;
    const runId = `run_${this.id}_${++this.n}_${crypto.randomUUID().slice(0, 8)}`;
    this.byRequest.set(req.requestId, runId);
    const abort = new AbortController();
    let reason: "cancelled" | "timed_out" | null = null;
    const run: Run = { abort, done: Promise.resolve() };
    this.runs.set(runId, run);
    const seq = new EventSequencer({ runId, jobId: req.jobId, attempt: req.attempt }, events);
    const timer = setTimeout(() => { reason ??= "timed_out"; abort.abort(); }, req.maxWallTimeSec * 1000);
    (run as { cancelReason?: () => void }).cancelReason = () => { reason ??= "cancelled"; abort.abort(); };
    const ctx: RunContext = {
      runId, request: req, signal: abort.signal, seq, abortReason: () => reason,
      finish: async (r, type, payload) => {
        if (seq.terminal) return;
        const result: AgentRunResult = { runId, ...this.defaults, ...r };
        const wire = validateAgentResult(toWireResult(result));
        if (!wire.ok) throw new Error(`adapter produced a contract-invalid result: ${wire.errors.join("; ")}`);
        run.result = result;
        await seq.emit(type, payload ?? {});
      },
    };
    run.done = (async () => {
      try {
        await this.execute(ctx);
        if (!seq.terminal) await ctx.finish({ exitStatus: "failed", failureCode: "no-result" }, "agent.failed", { code: "no-result" });
      } catch (e) {
        if (!seq.terminal) await ctx.finish({ exitStatus: "failed", failureCode: "adapter-error" }, "agent.failed", { code: "adapter-error", message: e instanceof Error ? e.message.slice(0, 500) : "error" }).catch(() => undefined);
      } finally {
        clearTimeout(timer);
      }
    })();
    return runId;
  }

  async status(runId: string): Promise<AgentRunResult | { exitStatus: "running" }> {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`unknown run ${runId}`);
    return r.result ?? { exitStatus: "running" };
  }

  async cancel(runId: string): Promise<void> {
    const r = this.runs.get(runId) as (Run & { cancelReason?: () => void }) | undefined;
    if (!r) return;
    r.cancelReason?.();
    await r.done;
  }

  /** Helper for subclasses: terminal event type for an abort. */
  protected static abortTerminal(reason: "cancelled" | "timed_out"): { exitStatus: "cancelled" | "timed_out"; type: TerminalType } {
    return reason === "cancelled" ? { exitStatus: "cancelled", type: "agent.cancelled" } : { exitStatus: "timed_out", type: "agent.timed_out" };
  }
}

export { PolicyViolation };
