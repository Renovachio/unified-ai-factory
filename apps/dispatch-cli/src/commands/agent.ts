import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { guardWrite } from "../guard";
import { makeCtx } from "../launcher/context";
import { serveMcp, type ApiCall } from "../mcp";

/** `dispatch mcp`: stdio tool server for Claude Code. stdout carries ONLY protocol messages; diagnostics go to stderr. */
export async function cmdMcp(): Promise<number> {
  const c = makeCtx({ create: false });
  const call: ApiCall = async (method, path, body) => {
    if (!existsSync(c.paths.agentToken)) throw new Error("the agent token does not exist yet (the factory has never started)");
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
export async function cmdGuardWrite(): Promise<number> {
  const c = makeCtx({ create: false }); let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const r = guardWrite(input, join(c.paths.home, "work"));
  if (r.allow) return 0;
  process.stderr.write(`Dispatch blocked this write: ${r.reason}\n`); return 2;
}
