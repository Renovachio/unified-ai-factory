import { latestSnapshot, changesSince, renderChangesSince, takeSnapshot, termsApproval, undoSince, WorkCopyError, type TermsCheck } from "@factory/dispatch-core";
import { buildHereLaunch, shQuote, type ClaudeLaunch } from "../claude-launch";
import { configDir, pluginDir, selfCommand } from "../launcher/runtime";
import { makeCtx } from "../launcher/context";
import { safe, sym } from "../render";

export interface CodeDeps {
  home: string; cwd: string; request?: string | undefined;
  terms: () => TermsCheck; which: (cmd: string) => string | null; plugin: () => string | undefined;
  spawn: (l: ClaudeLaunch) => Promise<number>;
  env: Record<string, string | undefined>;
  guardCommand: string;
  out: (s: string) => void; err: (s: string) => void;
}

/** `dispatch code [request]`: Claude Code in the current folder, in place. A snapshot is taken first; `dispatch changes` / `dispatch undo` use it. */
export async function runCode(d: CodeDeps): Promise<number> {
  const t = d.terms();
  if (!t.approved) {
    d.err(`${sym.fail()} Not started: no provider-terms approval is recorded for Claude Code (${t.reason}).`);
    d.err("  Dispatch will not automate your Claude subscription until YOU have recorded your decision in config/provider-terms.json (adapterId \"claude-code\"); see docs/third-party/provider-terms/README.md. Dispatch never writes that file for you.");
    return 1;
  }
  const claude = d.which("claude"); if (!claude) { d.err(`${sym.fail()} Claude Code was not found on your PATH (command "claude").`); return 1; }
  const plugin = d.plugin(); if (!plugin) { d.err(`${sym.fail()} The Dispatch plugin for Claude Code was not found next to this install. Reinstall Dispatch.`); return 1; }
  try { const s = takeSnapshot(d.cwd, d.home); d.out(`Snapshot taken (${Object.keys(s.manifest).length} files). Undo anything afterwards with \`dispatch undo\`; list changes with \`dispatch changes\`.`); }
  catch (e) { d.err(`${sym.fail()} Could not take a safety snapshot of ${safe(d.cwd)}: ${e instanceof WorkCopyError ? e.message : (e as Error).message}. Nothing was started.`); return 1; }
  d.out(`Opening Claude Code in ${safe(d.cwd)}, working on your real files (Opus plans; Haiku/Sonnet agents execute). Claude will ask before changing files.`);
  const guard = `${d.guardCommand} --root ${shQuote(d.cwd)} --protect`;
  const code = await d.spawn(buildHereLaunch({ claude, pluginDir: plugin, projectPath: d.cwd, env: d.env, guardCommand: guard, request: d.request }));
  const s = latestSnapshot(d.cwd, d.home);
  if (s) { const n = changesSince(s).length; d.out(`\nDone. ${n} file${n === 1 ? "" : "s"} changed since the snapshot. \`dispatch changes\` shows them; \`dispatch undo\` reverts them.`); }
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
  const c = makeCtx({ create: false }); const s = selfCommand();
  return runCode({
    home: c.paths.home, cwd: process.cwd(), request: args.join(" ").trim() || undefined, env: process.env,
    guardCommand: [s.cmd, ...s.prefix, "guard-write"].map(shQuote).join(" "),
    terms: () => termsApproval(configDir(), "claude-code"), which: (cmd) => Bun.which(cmd), plugin: () => pluginDir(),
    spawn: async (l) => { const p = Bun.spawn([l.command, ...l.args], { cwd: l.cwd, env: l.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }); return await p.exited; },
    out: (s2) => console.log(s2), err: (s2) => console.error(s2),
  });
}
