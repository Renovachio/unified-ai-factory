import { type Sql } from "@factory/db";
import {
  assertEnvAllowed, buildSandboxEnv, createWorkspace, PolicyViolation, runSandboxed, teardownWorkspace, verifySandboxEnforcement,
  type RunResult, type SandboxBackend, type TeardownReport, type Workspace,
} from "@factory/sandboxes";
import { claimTask, completeTask, heartbeatTask, registerWorker, reportTaskEvent, StaleLeaseError, type TaskLease } from "@factory/scheduler";

export interface RunnerConfig {
  sql: Sql;
  organizationId: string;
  workspaceRoot: string;
  backend: SandboxBackend;
  /** The environment this worker process was started with; inspected, never forwarded. */
  processEnv: Readonly<Record<string, string | undefined>>;
  /** Explicit operator opt-in to run without OS confinement (trusted repositories only). */
  trustedRepositoryOnly?: boolean;
  uid?: number | undefined;
  heartbeatMs?: number;
  /** Lease TTL for claims made by runOnce (default: scheduler default, 45s). */
  leaseTtlMs?: number;
}

/** Enrollment/run-time checks (SECURITY.md): unprivileged identity, no model credentials, real isolation. */
export function assertRunnerEligible(cfg: Pick<RunnerConfig, "backend" | "processEnv" | "trustedRepositoryOnly" | "uid">): void {
  const uid = cfg.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid === 0) throw new PolicyViolation("root-worker", "runner must not run as root; use a dedicated unprivileged account");
  assertEnvAllowed(cfg.processEnv);
  if (cfg.backend.isolation !== "strong" && !cfg.trustedRepositoryOnly)
    throw new PolicyViolation("no-isolation", "no confinement backend available; set trustedRepositoryOnly explicitly to run trusted repositories");
}

export async function enrollWorker(cfg: RunnerConfig): Promise<string> {
  assertRunnerEligible(cfg);
  // Fail closed: claiming "strong" isolation is not enough; prove (network + host read/write denial) before this worker may take any task.
  if (cfg.backend.isolation === "strong") {
    const rep = await verifySandboxEnforcement(cfg.backend);
    if (!rep.enforced) throw new PolicyViolation("sandbox-not-enforced", `sandbox self-test failed: ${rep.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ")}`);
  }
  return registerWorker(cfg.sql, {
    organizationId: cfg.organizationId,
    mode: "local",
    capabilities: { sandbox: cfg.backend.name, isolation: cfg.backend.isolation, trustedRepositoryOnly: cfg.trustedRepositoryOnly ?? false },
  });
}

export interface TaskContext {
  lease: TaskLease;
  workspace: Workspace;
  signal: AbortSignal;
  /** Run a command confined to this task's workspace with a scrubbed environment. */
  run(command: string, args?: string[], opts?: { timeoutMs?: number; readOnlyPaths?: string[]; cpuSeconds?: number; maxOutputBytes?: number }): Promise<RunResult>;
  report(type: string, payload?: Record<string, unknown>): Promise<void>;
}

export type TaskExecutor = (ctx: TaskContext) => Promise<{ ok: boolean; payload?: Record<string, unknown> }>;

export interface TaskOutcome {
  status: "succeeded" | "failed" | "lease_lost" | "error";
  cleanup: TeardownReport;
  error?: string;
}

/**
 * Execute a leased task. A heartbeat keeps the lease alive; if the lease is revoked or superseded the execution is
 * aborted (process group killed), the workspace is torn down, and NOTHING is reported for the stale attempt.
 */
export async function runLeasedTask(cfg: RunnerConfig, workerId: string, lease: TaskLease, executor: TaskExecutor): Promise<TaskOutcome> {
  assertRunnerEligible(cfg);
  const ws = createWorkspace(cfg.workspaceRoot, `${lease.taskId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "task");
  const abort = new AbortController();
  let leaseLost = false;
  const fence = { taskId: lease.taskId, workerId, leaseToken: lease.leaseToken };
  const hb = setInterval(() => {
    heartbeatTask(cfg.sql, fence).catch((e: unknown) => {
      if (e instanceof StaleLeaseError) {
        leaseLost = true;
        abort.abort();
      }
    });
  }, cfg.heartbeatMs ?? 10_000);
  const env = buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir });
  const ctx: TaskContext = {
    lease, workspace: ws, signal: abort.signal,
    run: (command, args = [], o = {}) =>
      runSandboxed({
        backend: cfg.backend, workspaceRoot: ws.root, cwd: ws.repoDir, command, args, env, timeoutMs: o.timeoutMs ?? 60_000, signal: abort.signal,
        ...(o.readOnlyPaths ? { readOnlyPaths: o.readOnlyPaths } : {}), ...(o.cpuSeconds ? { cpuSeconds: o.cpuSeconds } : {}), ...(o.maxOutputBytes ? { maxOutputBytes: o.maxOutputBytes } : {}),
      }),
    report: async (type, payload) => { await reportTaskEvent(cfg.sql, { ...fence, type, ...(payload ? { payload } : {}) }); },
  };
  let status: TaskOutcome["status"] = "error";
  let error: string | undefined;
  let result: Awaited<ReturnType<TaskExecutor>> | undefined;
  try {
    result = await executor(ctx);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearInterval(hb);
  }
  const cleanup = teardownWorkspace(cfg.workspaceRoot, ws); // cleanup always happens first; its status is recorded below
  if (leaseLost || error?.includes("StaleLeaseError")) status = "lease_lost";
  else if (result) {
    try {
      await reportTaskEvent(cfg.sql, { ...fence, type: "runner.cleanup", payload: { removed: cleanup.removed, ...(cleanup.error ? { error: cleanup.error } : {}) } });
      await completeTask(cfg.sql, { ...fence, outcome: result.ok ? "succeeded" : "failed", ...(result.payload ? { payload: result.payload } : {}) });
      status = result.ok ? "succeeded" : "failed";
    } catch (e) {
      if (e instanceof StaleLeaseError) status = "lease_lost";
      else error = String(e);
    }
  }
  return { status, cleanup, ...(error ? { error } : {}) };
}

/** One polling iteration: claim a task and run it. Returns null when nothing was runnable. */
export async function runOnce(cfg: RunnerConfig, workerId: string, executor: TaskExecutor, roles?: string[]): Promise<TaskOutcome | null> {
  const lease = await claimTask(cfg.sql, { workerId, ...(roles ? { roles } : {}), ...(cfg.leaseTtlMs ? { ttlMs: cfg.leaseTtlMs } : {}) });
  return lease ? runLeasedTask(cfg, workerId, lease, executor) : null;
}
