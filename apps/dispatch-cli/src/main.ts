#!/usr/bin/env bun
import { cmdDoctor, cmdMigrate, cmdStart, cmdStatus, cmdStop, launchBrowser, startFactory } from "./commands/lifecycle";
import { cmdServe } from "./commands/serve";
import { makeCtx } from "./launcher/context";
import { color, HEADER, sym } from "./render";
import { DISPATCH_VERSION } from "./version";

export const HELP = `${HEADER()}

Usage:
  dispatch                 start or attach to the factory, open the dashboard, enter the interactive prompt
  dispatch --no-browser    same, without opening a browser
  dispatch start           start missing managed services, then exit
  dispatch status          show real service health and job summary (read-only)
  dispatch doctor          diagnose prerequisites and settings (read-only)
  dispatch stop [--yes]    graceful shutdown of services Dispatch owns (warns about running jobs)
  dispatch migrate [--yes] apply pending database migrations (explicit; never automatic on an existing database)
  dispatch --version | --help

Security: Dispatch never uses usage-billed model APIs or API keys, never stores provider credentials,
binds only to 127.0.0.1, and never runs commands produced by a model. Closing the terminal does not stop jobs.`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "__serve") return cmdServe(rest[0] ?? "");
  if (cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(HELP); return 0; }
  if (cmd === "--version" || cmd === "-v") { console.log(`dispatch ${DISPATCH_VERSION}`); return 0; }
  if (cmd === "start") return cmdStart(rest);
  if (cmd === "status") return cmdStatus();
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "stop") return cmdStop(rest);
  if (cmd === "migrate") return cmdMigrate(rest);
  if (cmd !== undefined && cmd !== "--no-browser") { console.error(`${sym.fail()} unknown command "${cmd.slice(0, 40)}". Try \`dispatch --help\`.`); return 2; }
  // Default: start or attach, then browser, then the interactive prompt (DSP-03).
  const noBrowser = cmd === "--no-browser" || rest.includes("--no-browser");
  const c = makeCtx({ create: true });
  console.log(HEADER());
  const r = await startFactory(c);
  if (!r.ok) { console.error(`\n${sym.fail()} Factory failed to start. Run \`dispatch doctor\`, fix the cause, then run \`dispatch\` again.`); return 1; }
  if (!noBrowser && c.cfg.browser.open) await launchBrowser(c, r.services);
  console.log(color.dim("(interactive prompt arrives with DSP-03)"));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
