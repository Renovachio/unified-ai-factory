import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxBackend } from "./backends";
import { runSandboxed } from "./process";
import { buildSandboxEnv } from "./env";
import { createWorkspace, teardownWorkspace } from "./workspace";

export interface EnforcementReport { enforced: boolean; backend: string; checks: Array<{ name: string; ok: boolean; detail: string }> }

/**
 * Fail-closed self-test: actually tries to (1) connect to a host loopback listener and (2) read/write outside the workspace from inside the sandbox.
 * Execution must be blocked unless every probe is denied. A backend reporting "none" is never enforced.
 */
export async function verifySandboxEnforcement(backend: SandboxBackend): Promise<EnforcementReport> {
  const checks: EnforcementReport["checks"] = [];
  if (backend.isolation !== "strong") return { enforced: false, backend: backend.name, checks: [{ name: "backend", ok: false, detail: `${backend.name} provides no OS isolation` }] };
  const base = mkdtempSync(join(tmpdir(), "enf-base-"));
  const hostDir = mkdtempSync(join(tmpdir(), "enf-host-"));
  writeFileSync(join(hostDir, "secret.txt"), "HOST-SECRET");
  let hits = 0;
  const srv = createServer((s) => { hits++; s.end("x"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const ws = createWorkspace(base, "enforce");
  const env = buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir });
  const run = (command: string, args: string[]) => runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command, args, env, timeoutMs: 8000 });
  try {
    const net = await run("/usr/bin/curl", ["-s", "-m", "3", `http://127.0.0.1:${port}/`]);
    checks.push({ name: "loopback-connect-denied", ok: hits === 0 && !net.stdout.includes("x"), detail: `listener hits=${hits}` });
    const rd = await run("/bin/cat", [join(hostDir, "secret.txt")]);
    checks.push({ name: "host-read-denied", ok: !rd.stdout.includes("HOST-SECRET"), detail: `exit=${rd.exitCode}` });
    const target = join(hostDir, "written.txt");
    await run("/bin/sh", ["-c", `echo pwn > '${target}'`]);
    checks.push({ name: "host-write-denied", ok: !existsSync(target), detail: existsSync(target) ? "file created outside workspace" : "no file created" });
  } finally {
    srv.close(); teardownWorkspace(base, ws);
    for (const d of [base, hostDir]) rmSync(d, { recursive: true, force: true });
  }
  return { enforced: checks.length === 3 && checks.every((c) => c.ok), backend: backend.name, checks };
}
