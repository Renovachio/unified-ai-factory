import type { Sql } from "@factory/db";
import { enrollWorker, runOnce, selectingExecutor, type RunnerConfig, type TaskExecutor, type TaskOutcome } from "@factory/runner";
import {
  type AgentRole, type AgentRuntimeAdapter, type InferenceSourcePolicy, type QualificationRegistry, type SelectionCandidate,
} from "@factory/runtimes";
import type { FileArtifactStore } from "./artifacts";
import { composeAgentExecutor } from "./agent-composition";

export interface AgentWorkerDeps {
  sql: Sql;
  store: FileArtifactStore;
  /** Adapters that exist in this build, keyed by adapterId. A candidate with no adapter here is never selected. */
  adapters: ReadonlyMap<string, AgentRuntimeAdapter>;
  candidates: readonly SelectionCandidate[];
  policy: InferenceSourcePolicy;
  qualification: QualificationRegistry;
  env: Readonly<Record<string, string | undefined>>;
  /** Result of the sandbox self-test for this worker (fail closed when false). */
  sandboxEnforced: boolean;
  fallbackContextUri: (jobId: string, role: AgentRole) => string | Promise<string>;
  memory?: { enabled: boolean; roles?: ReadonlySet<AgentRole>; promptsDir?: string };
}

/**
 * Selection-gated agent executor. A task starts only when selectRuntime finds a candidate that is qualified for its role,
 * policy-allowed and has an adapter in this build. Otherwise the task is NOT run, and the block reason is recorded in the
 * runtime.selection event. There is no fallback to another source.
 */
export function agentWorkerExecutor(d: AgentWorkerDeps): TaskExecutor {
  return selectingExecutor(
    (ctx) => ({
      role: ctx.lease.role,
      candidates: d.candidates.filter((c) => d.adapters.has(c.adapterId)),
      policy: d.policy,
      qualification: d.qualification,
      env: d.env,
      sandboxEnforced: d.sandboxEnforced,
    }),
    async (ctx, selected) => {
      const adapter = d.adapters.get(selected.adapterId);
      if (!adapter) return { ok: false, payload: { blocked: true, blockReason: "RUNTIME_UNAVAILABLE" } };
      const composed = composeAgentExecutor({
        sql: d.sql,
        adapter,
        store: d.store,
        modelFor: () => selected.modelId,
        fallbackContextUri: d.fallbackContextUri,
        ...(d.memory ? { memory: d.memory } : {}),
      });
      return composed.executor(ctx);
    },
  );
}

/**
 * Worker loop: enrolment checks (unprivileged user, no model credentials, real isolation), then claim-and-run until stopped.
 * Nothing runs unless the caller passes a configured runner. The caller owns the signal and the process lifecycle.
 */
export async function runAgentWorker(
  cfg: RunnerConfig,
  executor: TaskExecutor,
  opts: { roles?: string[]; signal: AbortSignal; idleMs?: number; onOutcome?: (o: TaskOutcome) => void },
): Promise<void> {
  const workerId = await enrollWorker(cfg);
  const idleMs = opts.idleMs ?? 1000;
  while (!opts.signal.aborted) {
    const outcome = await runOnce(cfg, workerId, executor, opts.roles);
    if (outcome) opts.onOutcome?.(outcome);
    else await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, idleMs);
      opts.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
