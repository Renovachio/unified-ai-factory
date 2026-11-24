import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runSandboxed, sanitizeGitDir, SAFE_GIT_ENV, type SandboxBackend } from "@factory/sandboxes";
import type { GateManifest } from "./manifest";
import type { StepResult } from "./evidence";

const run = promisify(execFile);

export interface RunGatesInput {
  manifest: GateManifest;
  repoDir: string;
  workspaceRoot: string;
  expectedHead: string;
  backend: SandboxBackend;
  env: Record<string, string>;
  /** Absolute, pinned executable paths for the allowlisted names (e.g. bun). */
  executables: Record<string, string>;
  readOnlyPaths: string[];
  putLog: (text: string) => string;
  signal?: AbortSignal;
}

export interface RunGatesResult {
  steps: StepResult[];
  allPassed: boolean;
  failedStep?: string;
  worktreeMutated: boolean;
  headVerified: boolean;
}

const gitOut = async (repoDir: string, args: string[]) =>
  (await run("git", ["-C", repoDir, ...args], { env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", HOME: repoDir, ...SAFE_GIT_ENV }, timeout: 60_000, maxBuffer: 10_000_000, encoding: "utf8" })).stdout;

/**
 * Runs the LOCKED manifest's commands (argv only, no shell, factory-chosen) inside the sandbox against exactly `expectedHead`.
 * Afterwards re-checks that HEAD is unchanged and that no tracked file was modified (a check that edits sources could fake a pass).
 */
export async function runGates(i: RunGatesInput): Promise<RunGatesResult> {
  sanitizeGitDir(i.repoDir);
  const headBefore = (await gitOut(i.repoDir, ["rev-parse", "HEAD"])).trim();
  if (headBefore !== i.expectedHead) return { steps: [], allPassed: false, failedStep: "head-mismatch", worktreeMutated: false, headVerified: false };
  const steps: StepResult[] = [];
  let failedStep: string | undefined;
  for (const s of i.manifest.steps) {
    const exe = i.executables[s.command[0] as string];
    const startedAt = new Date().toISOString();
    if (!exe) {
      steps.push({ id: s.id, command: s.command, exitCode: null, timedOut: false, durationMs: 0, startedAt, logDigest: i.putLog("executable not provisioned on this runner") });
      failedStep ??= s.id;
      continue;
    }
    const r = await runSandboxed({
      backend: i.backend, workspaceRoot: i.workspaceRoot, cwd: i.repoDir, command: exe, args: s.command.slice(1), env: i.env,
      timeoutMs: s.timeoutSeconds * 1000, readOnlyPaths: i.readOnlyPaths, maxOutputBytes: 400_000, ...(i.signal ? { signal: i.signal } : {}),
    });
    const log = `$ ${s.command.join(" ")}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}${r.outputTruncated ? "\n[output truncated]" : ""}`;
    steps.push({ id: s.id, command: s.command, exitCode: r.exitCode, timedOut: r.timedOut || r.cancelled, durationMs: r.durationMs, startedAt, logDigest: i.putLog(log) });
    if (r.exitCode !== 0 || r.timedOut || r.cancelled) failedStep ??= s.id;
  }
  sanitizeGitDir(i.repoDir);
  const headAfter = (await gitOut(i.repoDir, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  const dirty = (await gitOut(i.repoDir, ["status", "--porcelain=v1", "--untracked-files=no"]).catch(() => "x")).trim();
  const worktreeMutated = headAfter !== i.expectedHead || dirty.length > 0;
  return { steps, allPassed: failedStep === undefined && !worktreeMutated, ...(failedStep ? { failedStep } : {}), worktreeMutated, headVerified: headAfter === i.expectedHead };
}
