#!/usr/bin/env bun
import { shellRequestText } from "@factory/dispatch-core";
import { runRepl } from "./repl/repl";
import { getSummary } from "./launcher/api";
import { cmdDoctor, cmdMigrate, cmdStart, cmdStatus, cmdStop, launchBrowser, startFactory } from "./commands/lifecycle";
import { cmdServe } from "./commands/serve";
import { cmdGuardWrite, cmdMcp } from "./commands/agent";
import { cmdWork } from "./commands/work";
import { makeCtx } from "./launcher/context";
import { HEADER, safe, sym } from "./render";
import { DISPATCH_VERSION } from "./version";

export const HELP = `${HEADER()}

Usage:
  dispatch                 start or attach to the factory, open the dashboard, enter the interactive prompt
  dispatch <request>       same, and create a new request (e.g. dispatch add dark mode to settings)
  dispatch --project <dir> [request]   use a local folder as the project (no GitHub needed)
  dispatch --no-browser    same, without opening a browser
  dispatch start           start missing managed services, then exit
  dispatch status          show real service health and job summary (read-only)
  dispatch doctor          diagnose prerequisites and settings (read-only)
  dispatch stop [--yes]    graceful shutdown of services Dispatch owns (warns about running jobs)
  dispatch migrate [--yes] apply pending database migrations (explicit; never automatic on an existing database)
  dispatch work            have Claude Code (Opus plans, cheaper agents execute) do the next queued job in a work copy
  dispatch mcp             (used by Claude Code) the Dispatch tool server; never run by hand
  dispatch --version | --help

Security: Dispatch never uses usage-billed model APIs or API keys, never stores provider credentials,
binds only to 127.0.0.1, and never runs commands produced by a model. Closing the terminal does not stop jobs.`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "__serve") return cmdServe(rest[0] ?? "");
  if (cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(HELP); return 0; }
  if (cmd === "--version" || cmd === "-v") { console.log(`dispatch ${DISPATCH_VERSION}`); return 0; }
  if (cmd === "mcp") return cmdMcp();
  if (cmd === "work") return cmdWork();
  if (cmd === "guard-write") return cmdGuardWrite();
  if (cmd === "start") return cmdStart(rest);
  if (cmd === "status") return cmdStatus();
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "stop") return cmdStop(rest);
  if (cmd === "migrate") return cmdMigrate(rest);
  const noBrowser = argv.includes("--no-browser");
  let folder: string | undefined; const rest2: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i] as string; if (a === "--no-browser") continue; if (a === "--project") { folder = argv[++i]; if (!folder) { console.error(`${sym.fail()} --project needs a folder.`); return 2; } continue; } rest2.push(a); }
  const words = rest2;
  if (words.some((w) => w.startsWith("-"))) { console.error(`${sym.fail()} unknown option "${(words.find((w) => w.startsWith("-")) ?? "").slice(0, 40)}". Try \`dispatch --help\`.`); return 2; }
  // `dispatch <words>` is a request. Validate it BEFORE starting anything so a typo costs nothing.
  const req = words.length ? shellRequestText(words) : null;
  if (req && !req.ok) { console.error(`${sym.fail()} ${req.error}`); return 2; }
  const c = makeCtx({ create: true });
  console.log(HEADER());
  const before = await c.lifecycle.status(); const wasRunning = before.services.find((x) => x.name === "api")?.state === "ready";
  const r = await startFactory(c);
  if (!r.ok) { console.error(`\n${sym.fail()} Factory failed to start. Run \`dispatch doctor\`, fix the cause, then run \`dispatch\` again.`); return 1; }
  // Plain `dispatch` always opens the dashboard; with a request it opens only when this invocation started the factory.
  if (!noBrowser && c.cfg.browser.open && (!req || !wasRunning)) await launchBrowser(c, r.services);
  const stopFlow = async (io: { out(s: string): void; ask(p: string): Promise<string> }) => {
    const st = await c.lifecycle.status(); const api = st.services.find((x) => x.name === "api"); let inFlight = 0;
    if (api?.state === "ready") { const sm = await getSummary(c.cfg, c.paths); if (!sm.ok) return { stopped: false, message: `${sym.fail()} Cannot determine active jobs (${safe(sm.error)}); not shutting down.` }; inFlight = sm.data.jobs.inFlight; }
    if (inFlight > 0) { io.out(`${sym.warn()} ${inFlight} job(s) are in flight; shutting down interrupts them.`); if ((await io.ask("Type “shutdown” to stop the factory anyway: ")).trim().toLowerCase() !== "shutdown") return { stopped: false, message: "Not stopped." }; }
    else if ((await io.ask("Stop the whole factory? Type “shutdown” to confirm: ")).trim().toLowerCase() !== "shutdown") return { stopped: false, message: "Not stopped." };
    const r = await c.lifecycle.stop({ confirmed: true, activeJobs: inFlight });
    return { stopped: true, message: r.results.length ? r.results.map((x) => `${x.name}: ${x.action}`).join(", ") : "Nothing owned by Dispatch was running." };
  };
  const initial = req && req.ok ? req.text : undefined;
  const result = await runRepl(c, {
    openDashboard: async () => { const st = await c.lifecycle.status(); await launchBrowser(c, st.services); return ""; },
    shutdown: stopFlow,
  }, { ...(initial ? { initialRequest: initial } : {}), ...(folder ? { initialFolder: folder } : {}) });
  void result; // both ending a session (detach) and a confirmed shutdown exit cleanly
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
