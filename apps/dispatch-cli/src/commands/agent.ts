import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { scopeFile } from "@factory/dispatch-core";
import { guardWrite } from "../guard";
import { makeCtx } from "../launcher/context";
import { selfCommand } from "../launcher/runtime";
import { serveMcp, type ApiCall } from "../mcp";

/** `dispatch mcp`: stdio tool server for Claude Code. stdout carries ONLY protocol messages; diagnostics go to stderr. */
export async function cmdMcp(): Promise<number> {
  const c = makeCtx({ create: false });
  let started = false;
  /** When Claude is used on its own the factory may not be running: start it once (no output on stdout: that carries the protocol), then retry. */
  const ensureUp = async () => {
    if (started) return; started = true;
    const s = selfCommand(); const p = Bun.spawn([s.cmd, ...s.prefix, "start"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); await p.exited;
  };
  const call: ApiCall = async (method, path, body) => {
    const once = async () => {
      if (!existsSync(c.paths.agentToken)) throw new Error("the agent token does not exist yet (the factory has never started)");
      return doFetch(method, path, body);
    };
    try { return await once(); } catch (e) { if (started) throw e; await ensureUp(); return await once(); }
  };
  const doFetch = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const r = await fetch(`http://${c.cfg.host}:${c.cfg.ports.api}${path}`, {
      method, signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${readFileSync(c.paths.agentToken, "utf8").trim()}`, ...(method === "POST" ? { "content-type": "application/json", "idempotency-key": crypto.randomUUID() } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  await serveMcp(createInterface({ input: process.stdin, crlfDelay: Infinity }), (s) => process.stdout.write(s), call);
  return 0;
}

/** `dispatch guard-write`: Claude Code PreToolUse hook. Exit 0 = allow, exit 2 = deny (the reason on stderr is shown to Claude). */
export async function cmdGuardWrite(args: string[] = []): Promise<number> {
  let input = ""; for await (const chunk of process.stdin) input += chunk;
  const ri = args.indexOf("--root"); const root = ri >= 0 ? args[ri + 1] : undefined;
  let r;
  if (args.includes("--from-cwd")) {
    // Plugin mode (Claude started by the user, Dispatch is just a plugin): the hook is installed for EVERY session, so it only acts while a Dispatch run is
    // active for the folder Claude is in; with no active run it stays out of the way. Active run = the scope file the API wrote for that folder.
    let cwd: string; try { cwd = realpathSync((JSON.parse(input) as { cwd?: string }).cwd ?? process.cwd()); } catch { return 0; }
    const sf = scopeFile(makeCtx({ create: false }).paths.home, cwd);
    if (!existsSync(sf)) return 0;
    r = guardWrite(input, cwd, { protect: true, scopeFile: sf });
  } else r = root ? guardWrite(input, root, { protect: args.includes("--protect"), ...(args.includes("--scope-file") ? { scopeFile: args[args.indexOf("--scope-file") + 1] as string } : {}) }) : guardWrite(input, join(makeCtx({ create: false }).paths.home, "work")); // no --root: the work folder (queued-job flow)
  if (r.allow) return 0;
  process.stderr.write(`Dispatch blocked this write: ${r.reason}\n`); return 2;
}
