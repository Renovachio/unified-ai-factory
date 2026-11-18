import { spawn } from "node:child_process";
import { redactString } from "@factory/telemetry";
import type { SandboxBackend, WrapContext } from "./backends";

export interface RunOptions {
  backend: SandboxBackend;
  workspaceRoot: string;
  cwd: string;
  command: string;
  args?: string[];
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  readOnlyPaths?: string[];
  cpuSeconds?: number;
  maxFileBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True when no process of the command's group remains alive. */
  groupGone: boolean;
}

const alive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a command inside the sandbox backend with a minimal env, its own process group, an output cap,
 * a wall-clock timeout and cancellation. On timeout/cancel the whole group is SIGTERM'd then SIGKILL'd.
 */
export async function runSandboxed(opts: RunOptions): Promise<RunResult> {
  const ctx: WrapContext = { workspaceRoot: opts.workspaceRoot };
  if (opts.readOnlyPaths) ctx.readOnlyPaths = opts.readOnlyPaths;
  if (opts.cpuSeconds) ctx.cpuSeconds = opts.cpuSeconds;
  if (opts.maxFileBytes) ctx.maxFileBytes = opts.maxFileBytes;
  const wrapped = opts.backend.wrap(opts.command, opts.args ?? [], ctx); // throws PolicyViolation when no isolation
  const max = opts.maxOutputBytes ?? 1_000_000;
  const start = Date.now();
  const child = spawn(wrapped.command, wrapped.args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pgid = child.pid as number;
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let truncated = false;
  const collect = (which: "out" | "err") => (d: Buffer) => {
    if (bytes >= max) { truncated = true; return; }
    const room = max - bytes;
    const chunk = d.length > room ? d.subarray(0, room) : d;
    if (d.length > room) truncated = true;
    bytes += chunk.length;
    if (which === "out") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", collect("out"));
  child.stderr.on("data", collect("err"));

  let timedOut = false;
  let cancelled = false;
  let killing: Promise<void> | undefined;
  const killGroup = (): Promise<void> => (killing ??= (async () => {
    try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
    const deadline = Date.now() + (opts.killGraceMs ?? 500);
    while (Date.now() < deadline && alive(pgid)) await sleep(25);
    if (alive(pgid)) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
  })());

  const timer = setTimeout(() => { timedOut = true; void killGroup(); }, opts.timeoutMs);
  const onAbort = () => { cancelled = true; void killGroup(); };
  if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", () => resolve({ code: 127, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  // Leftover grandchildren (e.g. `sleep &`) must not outlive the task.
  if (alive(pgid)) await killGroup();
  for (let i = 0; i < 40 && alive(pgid); i++) await sleep(25);
  return {
    exitCode: exit.code, signal: exit.signal, timedOut, cancelled, outputTruncated: truncated, durationMs: Date.now() - start,
    stdout: redactString(stdout), stderr: redactString(stderr), groupGone: !alive(pgid),
  };
}
