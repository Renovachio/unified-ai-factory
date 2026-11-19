import { mkdirSync } from "node:fs";
import { termsApproval, type TermsCheck } from "@factory/dispatch-core";
import { buildClaudeLaunch, workDirOf, type ClaudeLaunch } from "../claude-launch";
import { apiCall } from "../launcher/api";
import { makeCtx } from "../launcher/context";
import { configDir, pluginDir } from "../launcher/runtime";
import { safe, sym } from "../render";

export interface WorkDeps {
  home: string;
  terms: () => TermsCheck;
  which: (cmd: string) => string | null;
  plugin: () => string | undefined;
  /** The factory's oldest queued local job, or null; throws when the factory is not reachable. */
  nextJob: () => Promise<{ title: string; project: { name: string; path: string } } | null>;
  spawn: (l: ClaudeLaunch) => Promise<number>;
  env: Record<string, string | undefined>;
  out: (s: string) => void; err: (s: string) => void;
}

export async function runWork(d: WorkDeps): Promise<number> {
  const t = d.terms();
  if (!t.approved) {
    d.err(`${sym.fail()} Not started: no provider-terms approval is recorded for Claude Code (${t.reason}).`);
    d.err("  Dispatch will not automate your Claude subscription until YOU have read Anthropic's terms for this use and recorded your decision.");
    d.err("  Add an entry for adapterId \"claude-code\" to config/provider-terms.json (fields: adapterId, provider, termsUrl, termsReviewedOn, approvedBy, scope, optional expiresOn),");
    d.err("  see docs/third-party/provider-terms/README.md. Dispatch never writes that file for you.");
    return 1;
  }
  const claude = d.which("claude"); if (!claude) { d.err(`${sym.fail()} Claude Code was not found on your PATH (command "claude").`); return 1; }
  const plugin = d.plugin(); if (!plugin) { d.err(`${sym.fail()} The Dispatch plugin for Claude Code was not found next to this install. Reinstall Dispatch.`); return 1; }
  let job; try { job = await d.nextJob(); } catch (e) { d.err(`${sym.fail()} Dispatch is not reachable (${safe((e as Error).message)}). Run \`dispatch\` first.`); return 1; }
  if (!job) { d.out("Nothing is queued. Create a request with `dispatch --project <folder> <request>` first."); return 0; }
  const work = workDirOf(d.home); mkdirSync(work, { recursive: true, mode: 0o700 });
  d.out(`Job: ${safe(job.title)}\nProject: ${safe(job.project.name)} (${safe(job.project.path)})`);
  d.out("Opening Claude Code (restricted mode, Opus plans, cheaper agents execute). It works on a COPY; nothing changes in your folder until you approve in Dispatch.");
  const code = await d.spawn(buildClaudeLaunch({ claude, pluginDir: plugin, projectPath: job.project.path, workDir: work, env: d.env }));
  d.out(`\nBack in Dispatch. Review what the agents did with \`dispatch\` then /runs, /review <run>, /accept <run>.`);
  return code;
}

export async function cmdWork(): Promise<number> {
  const c = makeCtx({ create: false });
  return runWork({
    home: c.paths.home, env: process.env,
    terms: () => termsApproval(configDir(), "claude-code"),
    which: (cmd) => Bun.which(cmd), plugin: () => pluginDir(),
    nextJob: async () => {
      const r = await apiCall<{ job: { title: string } | null; project?: { name: string; path: string } }>(c.cfg, c.paths, "/api/v2/dispatch/work/next");
      if (!r.ok) throw new Error(r.error);
      return r.data.job && r.data.project ? { title: r.data.job.title, project: r.data.project } : null;
    },
    spawn: async (l) => { const p = Bun.spawn([l.command, ...l.args], { cwd: l.cwd, env: l.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }); return await p.exited; },
    out: (s) => console.log(s), err: (s) => console.error(s),
  });
}
