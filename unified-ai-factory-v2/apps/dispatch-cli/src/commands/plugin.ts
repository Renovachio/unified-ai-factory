import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCtx } from "../launcher/context";
import { pluginDir } from "../launcher/runtime";
import { sym } from "../render";

export const MARKETPLACE = "dispatch-local";
export const marketplaceJson = (): string => JSON.stringify({ name: MARKETPLACE, owner: { name: "Dispatch (local)" }, plugins: [{ name: "dispatch", source: "./dispatch", description: "Dispatch for Claude Code: /dispatch:do runs Opus-planned, cheaper-agent work in this folder with a snapshot and a plan-scoped write guard." }] }, null, 2);

export interface PluginDeps {
  home: string; plugin: () => string | undefined; which: (c: string) => string | null;
  run: (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
  out: (s: string) => void; err: (s: string) => void;
}
/** Build the local marketplace under Dispatch's home (a copy of the shipped plugin) so Claude Code can install it like any plugin. Touches only Dispatch's home and Claude's own plugin registry. */
export async function runPlugin(sub: string | undefined, d: PluginDeps): Promise<number> {
  const claude = d.which("claude"); if (!claude) { d.err(`${sym.fail()} Claude Code was not found on your PATH (command "claude").`); return 1; }
  if (sub === "uninstall") {
    const a = await d.run(claude, ["plugin", "uninstall", `dispatch@${MARKETPLACE}`]); const b = await d.run(claude, ["plugin", "marketplace", "remove", MARKETPLACE]);
    d.out(`${a.out}${b.out}`.trim()); return a.code === 0 && b.code === 0 ? 0 : 1;
  }
  if (sub !== "install") { d.err("usage: dispatch plugin install | uninstall"); return 2; }
  const src = d.plugin(); if (!src) { d.err(`${sym.fail()} The Dispatch plugin was not found next to this install. Reinstall Dispatch.`); return 1; }
  const mk = join(d.home, "marketplace"); rmSync(mk, { recursive: true, force: true });
  mkdirSync(join(mk, ".claude-plugin"), { recursive: true, mode: 0o700 }); cpSync(src, join(mk, "dispatch"), { recursive: true });
  writeFileSync(join(mk, ".claude-plugin", "marketplace.json"), marketplaceJson());
  if (existsSync(join(mk, "dispatch", ".git"))) rmSync(join(mk, "dispatch", ".git"), { recursive: true, force: true });
  await d.run(claude, ["plugin", "marketplace", "remove", MARKETPLACE]); // idempotent re-install
  const add = await d.run(claude, ["plugin", "marketplace", "add", mk]); if (add.code !== 0) { d.err(`${sym.fail()} Could not add the marketplace:\n${add.out}`); return 1; }
  const inst = await d.run(claude, ["plugin", "install", `dispatch@${MARKETPLACE}`]); if (inst.code !== 0) { d.err(`${sym.fail()} Could not install the plugin:\n${inst.out}`); return 1; }
  d.out(`${sym.ok()} Installed. In any folder, start \`claude\` and type: /dispatch:do <what you want done>\nThe write guard only acts while a Dispatch run is active; normal Claude sessions are not affected. Remove with \`dispatch plugin uninstall\`.`);
  return 0;
}

export async function cmdPlugin(args: string[]): Promise<number> {
  const c = makeCtx({ create: false });
  return runPlugin(args[0], {
    home: c.paths.home, plugin: () => pluginDir(), which: (x) => Bun.which(x),
    run: async (cmd, a) => { const p = Bun.spawn([cmd, ...a], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }); const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); return { code: await p.exited, out: `${o}${e}` }; },
    out: (s) => console.log(s), err: (s) => console.error(s),
  });
}
