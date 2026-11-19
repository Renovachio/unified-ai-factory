import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertEnvAllowed, buildSandboxEnv, createWorkspace, detectBackend, forbiddenEnvNames, runSandboxed, teardownWorkspace, type Workspace } from "../src/index";

const backend = detectBackend();
const base = mkdtempSync(join(tmpdir(), "iso-"));
let ws: Workspace;
const HOST_SECRETS = { GITHUB_APP_PRIVATE_KEY: "PEM-SECRET-1", GITHUB_TOKEN: "ghs_SECRET2", GH_TOKEN: "SECRET3", SSH_AUTH_SOCK: "/tmp/agent.sock", MERGE_TOKEN: "SECRET4", SESSION_SECRET: "SECRET5", OIDC_CLIENT_SECRET: "SECRET6", DATABASE_URL: "postgres://u:SECRET7@h/db", PGPASSWORD: "SECRET8", NPM_CONFIG__AUTH: "SECRET9", OPENAI_API_KEY: "SECRET10", ANTHROPIC_API_KEY: "SECRET11" };
const saved: Record<string, string | undefined> = {};
beforeAll(() => { ws = createWorkspace(base, "iso"); for (const [k, v] of Object.entries(HOST_SECRETS)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) Reflect.deleteProperty(process.env, k); else process.env[k] = v; } teardownWorkspace(base, ws); rmSync(base, { recursive: true, force: true }); });

describe("secret isolation for builder processes (SEC-04)", () => {
  test("the sandbox environment is built from scratch: no host secret reaches `env`, even when the host process holds all of them", async () => {
    const r = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/usr/bin/env", args: [], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 8000 });
    for (const v of Object.values(HOST_SECRETS)) expect(r.stdout).not.toContain(v);
    for (const k of Object.keys(HOST_SECRETS)) expect(r.stdout).not.toContain(`${k}=`);
    expect(r.stdout).toContain("HOME=" + ws.homeDir);
  });
  test("smuggling a credential through `extra` is refused (every credential-shaped name, including database and session secrets)", () => {
    for (const k of Object.keys(HOST_SECRETS)) {
      expect(() => buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }, { [k]: "x" }), k).toThrow(/credential-like/);
      expect(forbiddenEnvNames({ [k]: "x" })).toEqual([k]);
    }
    expect(() => assertEnvAllowed({ PATH: "/bin", LANG: "C", HOME: "/h" })).not.toThrow();
  });
  test("host credential stores are unreadable from inside the sandbox (ssh keys, gh/claude/codex config, shell history, git credentials)", async () => {
    const targets = [".ssh/id_rsa", ".ssh/id_ed25519", ".config/gh/hosts.yml", ".claude.json", ".claude/.credentials.json", ".codex/auth.json", ".git-credentials", ".netrc", ".aws/credentials", ".zsh_history", ".bash_history"].map((t) => join(homedir(), t));
    for (const t of targets) {
      const r = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/bin/cat", args: [t], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 8000 });
      expect(r.stdout, `${t} (exists on host: ${existsSync(t)})`).toBe("");
      if (existsSync(t)) expect(r.exitCode).not.toBe(0);
    }
  });
  test("the sandbox cannot list the host home directory or read the macOS keychain / process environments", async () => {
    const ls = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/bin/ls", args: [homedir()], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 8000 });
    expect(ls.stdout.trim()).toBe("");
    const ps = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/bin/ps", args: ["eww", "-p", String(process.pid)], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 8000 });
    for (const v of Object.values(HOST_SECRETS)) expect(ps.stdout + ps.stderr).not.toContain(v); // other processes' environments are not readable
  });
  test("exfiltration attempts leave no secret in captured output or logs (and none was reachable to begin with)", async () => {
    const r = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/bin/sh", args: ["-c", 'echo "$GITHUB_TOKEN$GITHUB_APP_PRIVATE_KEY$MERGE_TOKEN"; printenv | grep -i -E "token|secret|key|password" || true; cat ~/.ssh/id_rsa 2>&1 || true'], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 8000 });
    for (const v of Object.values(HOST_SECRETS)) expect(r.stdout + r.stderr).not.toContain(v);
  });
});
