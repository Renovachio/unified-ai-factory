import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { latestSnapshot, changesSince, renderChangesSince, scopeFile, termsApproval, undoSince, type TermsCheck } from "@factory/dispatch-core";
import { buildHereLaunch, shQuote, type ClaudeLaunch } from "../claude-launch";
import { apiCall } from "../launcher/api";
import { configDir, pluginDir, selfCommand } from "../launcher/runtime";
import { makeCtx } from "../launcher/context";
import { safe, sym } from "../render";
import { startFactory } from "./lifecycle";
import { makeClient } from "../repl/repl";

export interface CodeDeps {
  home: string; cwd: string; request?: string | undefined;
  terms: () => TermsCheck; which: (cmd: string) => string | null; plugin: () => string | undefined;
  /** Make sure the factory is running; false = could not start. */
  ensureFactory: () => Promise<boolean>;
  ask: (prompt: string) => Promise<string>;
  /** Register the folder as a project (if new) and queue the request as a job on it. */
  createJob: (cwd: string, request: string) => Promise<{ jobId: string; project: string }>;
  /** Newest run for the job, once Claude has exited. */
  latestRun: (jobId: string) => Promise<{ id: string; status: string; changes: number; failure: string | null } | null>;
  spawn: (l: ClaudeLaunch) => Promise<number>;
  env: Record<string, string | undefined>;
  guardCommand: string;
  mcpCommand: { cmd: string; args: string[] };
  out: (s: string) => void; err: (s: string) => void;
}

/**
 * `dispatch code [request]`: the folder you are in becomes the project (GitHub not needed), the request is queued as a job, and Claude Code opens in it.
 * Same plan validation and run record as `dispatch work`, but the agents edit the REAL files: the API snapshots the folder when the plan is accepted,
 * the guard limits writes to the plan's paths, and you keep (/accept) or restore (/discard, `dispatch undo`) the result.
 */
export async function runCode(d: CodeDeps): Promise<number> {
  const t = d.terms();
  if (!t.approved) {
    d.err(`${sym.fail()} Not started: no provider-terms approval is recorded for Claude Code (${t.reason}).`);
    d.err("  Dispatch will not automate your Claude subscription until YOU have recorded your decision in config/provider-terms.json (adapterId \"claude-code\"); see docs/third-party/provider-terms/README.md. Dispatch never writes that file for you.");
    return 1;
  }
  const claude = d.which("claude"); if (!claude) { d.err(`${sym.fail()} Claude Code was not found on your PATH (command "claude").`); return 1; }
  const plugin = d.plugin(); if (!plugin) { d.err(`${sym.fail()} The Dispatch plugin for Claude Code was not found next to this install. Reinstall Dispatch.`); return 1; }
  let request = d.request?.trim() ?? ""; if (!request) request = (await d.ask("What should be done in this folder? ")).trim();
  if (!request) { d.err("No request given; nothing was started."); return 1; }
  let cwd: string; try { cwd = realpathSync(d.cwd); } catch { d.err(`${sym.fail()} Cannot read ${safe(d.cwd)}.`); return 1; }
  if (!(await d.ensureFactory())) { d.err(`${sym.fail()} The factory did not start. Run \`dispatch doctor\`.`); return 1; }
  let job; try { job = await d.createJob(cwd, request); } catch (e) { d.err(`${sym.fail()} Could not queue the request: ${safe((e as Error).message)}`); return 1; }
  d.out(`Queued job ${job.jobId.slice(0, 8)} on ${safe(job.project)}. Opening Claude Code in ${safe(cwd)}: Opus plans, Haiku/Sonnet agents edit the REAL files after a snapshot; writes are limited to the plan.`);
  const guard = `${d.guardCommand} --root ${shQuote(cwd)} --protect --scope-file ${shQuote(scopeFile(d.home, cwd))}`;
  const code = await d.spawn(buildHereLaunch({ claude, pluginDir: plugin, projectPath: cwd, env: d.env, guardCommand: guard, mcpCommand: d.mcpCommand }));
  let run = null; try { run = await d.latestRun(job.jobId); } catch { /* factory gone: nothing to report */ }
  if (!run) d.out("\nClaude exited without starting a run. The job stays queued; run `dispatch code` again.");
  else if (run.status === "awaiting_approval") d.out(`\nRun ${run.id.slice(0, 8)}: ${run.changes} file(s) changed in your folder. See \`dispatch changes\` or /review in \`dispatch\`; keep with /accept, restore with /discard (or \`dispatch undo --yes\`).`);
  else d.out(`\nRun ${run.id.slice(0, 8)} ended as ${run.status}${run.failure ? `: ${safe(run.failure)}` : ""}.`);
  return code;
}

export function cmdChanges(cwd: string, home: string, out: (s: string) => void, err: (s: string) => void): number {
  const s = latestSnapshot(cwd, home); if (!s) { err(`${sym.fail()} No snapshot for ${safe(cwd)}. Run \`dispatch code\` here first.`); return 1; }
  const ch = changesSince(s); if (!ch.length) { out(`No changes since the snapshot (${s.createdAt}).`); return 0; }
  out(`${ch.length} change${ch.length === 1 ? "" : "s"} since ${s.createdAt}:\n${ch.map((c) => `  ${c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~"} ${safe(c.path)}`).join("\n")}\n\n${renderChangesSince(s, ch)}`);
  return 0;
}

export function cmdUndo(cwd: string, home: string, yes: boolean, out: (s: string) => void, err: (s: string) => void): number {
  const s = latestSnapshot(cwd, home); if (!s) { err(`${sym.fail()} No snapshot for ${safe(cwd)}.`); return 1; }
  const ch = changesSince(s); if (!ch.length) { out("Nothing to undo."); return 0; }
  if (!yes) { out(`${ch.length} file${ch.length === 1 ? "" : "s"} would be restored to the snapshot of ${s.createdAt}:\n${ch.map((c) => `  ${safe(c.path)}`).join("\n")}\nRun \`dispatch undo --yes\` to do it.`); return 0; }
  const r = undoSince(s);
  if (!r.ok) { err(`${sym.fail()} Nothing was changed: ${r.conflicts.map((c) => `${safe(c.path)} ${c.reason}`).join("; ")}`); return 1; }
  out(`${sym.ok()} Restored ${r.applied} file${r.applied === 1 ? "" : "s"}.`); return 0;
}

export async function cmdCode(args: string[]): Promise<number> {
  const c = makeCtx({ create: true }); const s = selfCommand();
  return runCode({
    home: c.paths.home, cwd: process.cwd(), request: args.join(" ").trim() || undefined, env: process.env,
    guardCommand: [s.cmd, ...s.prefix, "guard-write"].map(shQuote).join(" "),
    mcpCommand: { cmd: s.cmd, args: [...s.prefix, "mcp"] },
    terms: () => termsApproval(configDir(), "claude-code"), which: (cmd) => Bun.which(cmd), plugin: () => pluginDir(),
    ensureFactory: async () => (await startFactory(c, { quiet: true })).ok,
    ask: async (p) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(p); } finally { rl.close(); } },
    createJob: async (cwd, request) => {
      const client = makeClient(c);
      const p = await client.send<{ id?: string; name: string }>(client.mutation("POST", "/api/v2/dispatch/projects", { path: cwd }));
      if (!p.id) throw new Error("the folder could not be added as a project");
      const r = await client.send<{ jobId: string }>(client.mutation("POST", "/api/v1/jobs", { repositoryId: p.id, request: { type: "feature", title: request.slice(0, 120), description: request, sourceId: `dispatch-code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` } }));
      return { jobId: r.jobId, project: p.name };
    },
    latestRun: async (jobId) => {
      const r = await apiCall<{ items: Array<{ id: string; jobId: string; status: string; changes: unknown[]; failure: string | null }> }>(c.cfg, c.paths, "/api/v2/dispatch/runs");
      const hit = r.ok ? r.data.items.find((x) => x.jobId === jobId) : undefined; return hit ? { id: hit.id, status: hit.status, changes: hit.changes.length, failure: hit.failure } : null;
    },
    spawn: async (l) => { const p = Bun.spawn([l.command, ...l.args], { cwd: l.cwd, env: l.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }); return await p.exited; },
    out: (x) => console.log(x), err: (x) => console.error(x),
  });
}
