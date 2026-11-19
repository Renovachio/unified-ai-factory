import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { acquireLock, childEnv, ConfigError, DEFAULT_CONFIG, dispatchPaths, ensureConfig, forbiddenEnvNames, isOwnedProcess, Lifecycle, LockTimeout, loadConfig, phaseOf, processIdentity, readState, transition, validateConfig, writeState, IllegalTransition, type ServiceSpec } from "../src/index";

// Real database/process startup is slow on a busy machine; give each test generous headroom (the CLI --timeout would otherwise cap it).
setDefaultTimeout(180_000);

let home = ""; const spawned: number[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "dsp-")); });
afterEach(() => { for (const p of spawned.splice(0)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } rmSync(home, { recursive: true, force: true }); });
const port = () => 30000 + Math.floor(Math.random() * 20000);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleeper = () => { const c = spawn("sleep", ["300"], { stdio: "ignore", detached: true }); c.unref(); spawned.push(c.pid as number); return c.pid as number; };
const helper = (p: number, instance = "inst-1") => Bun.spawn([process.execPath, join(import.meta.dir, "launcher-helper.ts")], { env: { PATH: process.env.PATH ?? "", DISPATCH_HOME: home, SVC_PORT: String(p), INSTANCE: instance }, stdout: "pipe", stderr: "pipe" });
const ensureOk = async (h: ReturnType<typeof helper>) => { const out = await new Response(h.stdout).text(); await h.exited; return JSON.parse(out.trim().split("\n").pop() as string) as { phase: string; services: Array<{ name: string; mode: string; state: string; detail: string }> }; };

describe("config (DSP-01)", () => {
  test("defaults when absent, created once, never overwritten", () => {
    const p = dispatchPaths({ DISPATCH_HOME: home }); expect(loadConfig(p.config).fromFile).toBe(false);
    ensureConfig(p.config); expect(loadConfig(p.config)).toMatchObject({ fromFile: true, config: DEFAULT_CONFIG });
    writeFileSync(p.config, JSON.stringify({ ...DEFAULT_CONFIG, ports: { api: 9000, web: 9001 } })); ensureConfig(p.config); expect(loadConfig(p.config).config.ports.api).toBe(9000);
  });
  test("invalid, unknown-key, non-loopback, newer-version and damaged files are errors with remediation, never repaired", () => {
    const p = dispatchPaths({ DISPATCH_HOME: home });
    for (const bad of [{ ...DEFAULT_CONFIG, host: "0.0.0.0" }, { ...DEFAULT_CONFIG, extra: 1 }, { ...DEFAULT_CONFIG, ports: { api: 80, web: 3000 } }, { ...DEFAULT_CONFIG, ports: { api: 4000, web: 4000 } }, { ...DEFAULT_CONFIG, postgres: { mode: "external" } }, { ...DEFAULT_CONFIG, postgres: { mode: "managed", url: "postgres://x" } }, "str", null])
      expect(() => validateConfig(bad)).toThrow(ConfigError);
    expect(() => validateConfig({ ...DEFAULT_CONFIG, schemaVersion: 99 })).toThrow(/newer/);
    writeFileSync(p.config, "{not json"); expect(() => loadConfig(p.config)).toThrow(ConfigError); expect(readFileSync(p.config, "utf8")).toBe("{not json"); // untouched
    expect(() => ensureConfig(p.config)).toThrow(ConfigError);
  });
});

describe("process identity: a PID alone is never proof", () => {
  test("owned only with matching start time AND marker; dead, reused and foreign PIDs are not owned", () => {
    const pid = sleeper(); const id = processIdentity(pid); expect(id).not.toBeNull();
    expect(isOwnedProcess({ pid, startedAt: id!.startedAt, marker: "sleep" })).toBe(true);
    expect(isOwnedProcess({ pid, startedAt: id!.startedAt, marker: "--dispatch-instance=other" })).toBe(false); // wrong marker
    expect(isOwnedProcess({ pid, startedAt: "Mon Jan  1 00:00:00 2001", marker: "sleep" })).toBe(false);        // PID reuse (different start time)
    process.kill(pid, "SIGKILL"); const t = Date.now(); while (alive(pid) && Date.now() - t < 2000) spawnSync("sleep", ["0.05"]);
    expect(isOwnedProcess({ pid, startedAt: id!.startedAt, marker: "sleep" })).toBe(false);
    expect(processIdentity(1)).toBeNull(); expect(processIdentity(-5)).toBeNull();
  });
  test("a program that rewrites its process title (Next.js) is still recognised through its working directory, but only with the matching start time", () => {
    const pid = sleeper(); const id = processIdentity(pid)!; const cwd = "/some/dashboard/dir";
    expect(isOwnedProcess({ pid, startedAt: id.startedAt, marker: "--dispatch-instance=x", cwd }, processIdentity, () => cwd)).toBe(true);
    expect(isOwnedProcess({ pid, startedAt: id.startedAt, marker: "--dispatch-instance=x", cwd }, processIdentity, () => "/elsewhere")).toBe(false);
    expect(isOwnedProcess({ pid, startedAt: id.startedAt, marker: "--dispatch-instance=x" }, processIdentity, () => cwd)).toBe(false); // no recorded cwd: marker only
    expect(isOwnedProcess({ pid, startedAt: "Mon Jan  1 00:00:00 2001", marker: "x", cwd }, processIdentity, () => cwd)).toBe(false);
  });
});

describe("startup lock", () => {
  test("a live holder is waited for and times out; a crashed holder's lock is reclaimed; reclaim does not double-grant", async () => {
    const lock = dispatchPaths({ DISPATCH_HOME: home }).lock;
    const rel = await acquireLock(lock);
    await expect(acquireLock(lock, { timeoutMs: 300, pid: process.pid + 100000, identify: (p) => (p === process.pid ? processIdentity(p) : null) })).rejects.toBeInstanceOf(LockTimeout);
    rel(); expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, JSON.stringify({ pid: 2_000_000, startedAt: "Mon Jan  1 00:00:00 2001" })); // dead holder
    const r2 = await acquireLock(lock, { timeoutMs: 1000 }); r2();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: "Mon Jan  1 00:00:00 2001" })); // live PID but different start time = reused PID
    (await acquireLock(lock, { timeoutMs: 1000 }))();
    writeFileSync(lock, "{torn"); (await acquireLock(lock, { timeoutMs: 1000 }))();
    const holders: number[] = []; // 6 concurrent in-process contenders: at most one inside the critical section at any time
    let inside = 0, max = 0;
    await Promise.all(Array.from({ length: 6 }, async () => { const r = await acquireLock(lock, { timeoutMs: 10_000 }); inside++; max = Math.max(max, inside); holders.push(1); await new Promise((x) => setTimeout(x, 20)); inside--; r(); }));
    expect(max).toBe(1); expect(holders).toHaveLength(6);
  });
});

describe("lifecycle state machine", () => {
  test("only the documented edges are legal", () => {
    expect(transition("Stopped", "Starting")).toBe("Starting"); expect(transition("Starting", "Ready")).toBe("Ready"); expect(transition("Ready", "Stopping")).toBe("Stopping"); expect(transition("Failed", "Starting")).toBe("Starting");
    for (const [a, b] of [["Stopped", "Ready"], ["Ready", "Starting"], ["Stopping", "Ready"], ["Failed", "Ready"], ["Stopped", "Stopping"]] as const) expect(() => transition(a, b)).toThrow(IllegalTransition);
    expect(phaseOf([{ name: "a", required: true, mode: "managed", state: "ready", detail: "" }, { name: "b", required: false, mode: "managed", state: "failed", detail: "" }])).toBe("Degraded");
    expect(phaseOf([{ name: "a", required: true, mode: "managed", state: "failed", detail: "" }])).toBe("Failed");
  });
});

describe("start / attach / stop with real processes (DSP-02)", () => {
  test("two concurrent launchers (separate OS processes) produce exactly ONE service process and both report ready", async () => {
    const p = port(); const [a, b] = [helper(p), helper(p)];
    const [ra, rb] = [await ensureOk(a), await ensureOk(b)];
    expect(ra.services[0]).toMatchObject({ name: "api", state: "ready" }); expect(rb.services[0]).toMatchObject({ name: "api", state: "ready" });
    expect(new Set([ra.services[0]!.mode, rb.services[0]!.mode])).toEqual(new Set(["managed"])); // second attached to the first's owned process
    const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes("fake-service.ts") && l.includes(String(p)));
    expect(ps).toHaveLength(1);
    const st = readState(dispatchPaths({ DISPATCH_HOME: home }).state)!; spawned.push(st.services.api!.pid!);
    expect(st.phase).toBe("Ready"); expect(isOwnedProcess({ pid: st.services.api!.pid!, startedAt: st.services.api!.startedAt!, marker: st.services.api!.marker! })).toBe(true);
  });
  test("the launcher exiting (terminal closed) does not stop the service; a later launch re-attaches to the same process", async () => {
    const p = port(); const r1 = await ensureOk(helper(p)); expect(r1.phase).toBe("Ready");
    const st1 = readState(dispatchPaths({ DISPATCH_HOME: home }).state)!; const pid = st1.services.api!.pid!; spawned.push(pid);
    expect(alive(pid)).toBe(true); // helper process is gone, service survives
    const r2 = await ensureOk(helper(p)); expect(r2.services[0]!.state).toBe("ready");
    expect(readState(dispatchPaths({ DISPATCH_HOME: home }).state)!.services.api!.pid).toBe(pid);
  });
  test("a stale record (dead PID / reused PID) is discarded and never signalled; stop leaves an unrelated process that reused the PID alone", async () => {
    const paths = dispatchPaths({ DISPATCH_HOME: home }); const innocent = sleeper(); const p = port();
    writeState(paths.state, { schemaVersion: 1, instanceId: "old", phase: "Ready", services: { api: { managed: true, pid: innocent, startedAt: "Mon Jan  1 00:00:00 2001", marker: "--dispatch-instance=old", port: p } }, updatedAt: "" });
    const r = await ensureOk(helper(p)); expect(r.services[0]).toMatchObject({ state: "ready", mode: "managed" });
    expect(alive(innocent)).toBe(true); // we started a fresh service, never touched the unrelated PID
    const st = readState(paths.state)!; spawned.push(st.services.api!.pid!); expect(st.services.api!.pid).not.toBe(innocent);
    writeState(paths.state, { ...st, services: { api: { managed: true, pid: innocent, startedAt: "Mon Jan  1 00:00:00 2001", marker: "x" } } });
    const spec: ServiceSpec = { name: "api", required: true, kind: "startable", probe: async () => ({ live: false, ready: false, detail: "" }) };
    const out = await new Lifecycle([spec], { statePath: paths.state, instanceId: "i" }).stop({ confirmed: true, activeJobs: 0 });
    expect(out.results[0]!.action).toBe("stale-record-dropped"); expect(alive(innocent)).toBe(true);
  });
  test("stop: refuses with active jobs unless confirmed; stops only owned services; external services are left running", async () => {
    const paths = dispatchPaths({ DISPATCH_HOME: home }); const p = port(); const r = await ensureOk(helper(p)); expect(r.phase).toBe("Ready");
    const st = readState(paths.state)!; const pid = st.services.api!.pid!; spawned.push(pid);
    const probe = async () => { try { const x = await fetch(`http://127.0.0.1:${p}/health`); return { live: true, ready: x.ok, detail: "" }; } catch { return { live: false, ready: false, detail: "down" }; } };
    const ext = Bun.serve({ port: port(), hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const extSpec: ServiceSpec = { name: "db", required: true, kind: "startable", probe: async () => ({ live: true, ready: true, detail: "external" }) };
    const lc = new Lifecycle([extSpec, { name: "api", required: true, kind: "startable", probe }], { statePath: paths.state, instanceId: "inst-1" });
    expect(await lc.stop({ confirmed: false, activeJobs: 2 })).toMatchObject({ stopped: false, reason: "active-jobs", activeJobs: 2 }); expect(alive(pid)).toBe(true);
    const done = await lc.stop({ confirmed: true, activeJobs: 2 });
    expect(done.results).toEqual([{ name: "api", action: "stopped" }, { name: "db", action: "left-external" }]);
    const t = Date.now(); while (alive(pid) && Date.now() - t < 5000) await new Promise((x) => setTimeout(x, 50)); expect(alive(pid)).toBe(false);
    expect(readState(paths.state)!.phase).toBe("Stopped"); ext.stop(true);
  });
  test("required failure => Failed (dependents not started); optional failure => Degraded; unstartable required service reports why", async () => {
    const paths = dispatchPaths({ DISPATCH_HOME: home }); let startedApi = false;
    const down: ServiceSpec = { name: "postgres", required: true, kind: "startable", probe: async () => ({ live: false, ready: false, detail: "pg not running" }) };
    const api: ServiceSpec = { name: "api", required: true, kind: "startable", dependsOn: ["postgres"], probe: async () => ({ live: false, ready: false, detail: "" }), start: async () => { startedApi = true; return {}; } };
    const r1 = await new Lifecycle([down, api], { statePath: paths.state, instanceId: "i" }).ensure();
    expect(r1.phase).toBe("Failed"); expect(startedApi).toBe(false); expect(r1.services[0]!.detail).toMatch(/cannot be started/); expect(r1.services[1]!.detail).toMatch(/postgres is not ready/);
    const ok: ServiceSpec = { name: "api", required: true, kind: "startable", probe: async () => ({ live: true, ready: true, detail: "up" }) };
    const dash: ServiceSpec = { name: "dashboard", required: false, kind: "startable", probe: async () => ({ live: false, ready: false, detail: "off" }), start: async () => { throw new Error("next not built"); } };
    const r2 = await new Lifecycle([ok, dash], { statePath: dispatchPaths({ DISPATCH_HOME: mkdtempSync(join(tmpdir(), "dsp2-")) }).state, instanceId: "i" }).ensure();
    expect(r2.phase).toBe("Degraded"); expect(r2.services[1]).toMatchObject({ state: "failed", detail: expect.stringMatching(/next not built/) });
  });
  test("a service that never becomes ready times out as failed (bounded wait), and an external 'up but not ready' service is not started over", async () => {
    const paths = dispatchPaths({ DISPATCH_HOME: home }); let t = 0; let starts = 0;
    const slow: ServiceSpec = { name: "api", required: true, kind: "startable", readyTimeoutMs: 1000, probe: async () => ({ live: false, ready: false, detail: "booting" }), start: async () => { starts++; return {}; } };
    const r = await new Lifecycle([slow], { statePath: paths.state, instanceId: "i", now: () => (t += 400), sleep: async () => undefined }).ensure();
    expect(r.services[0]).toMatchObject({ state: "failed", detail: expect.stringMatching(/did not become ready within 1s/) }); expect(starts).toBe(1);
    const half: ServiceSpec = { name: "api", required: true, kind: "startable", probe: async () => ({ live: true, ready: false, detail: "migrating" }), start: async () => { starts++; return {}; } };
    const r2 = await new Lifecycle([half], { statePath: dispatchPaths({ DISPATCH_HOME: mkdtempSync(join(tmpdir(), "dsp3-")) }).state, instanceId: "i" }).ensure();
    expect(r2.services[0]).toMatchObject({ mode: "external", state: "degraded" }); expect(starts).toBe(1);
  });
});

describe("environment hygiene (no metered inference)", () => {
  test("model-provider credentials/base URLs are detected and never reach a child environment", () => {
    const dirty = { PATH: "/usr/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://x", CLAUDE_CODE_OAUTH_TOKEN: "t", GEMINI_API_KEY: "k", SECRET: "s" };
    expect(forbiddenEnvNames(dirty).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GEMINI_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    expect(childEnv(dirty, { PORT: "1" })).toEqual({ PATH: "/usr/bin", HOME: "/h", PORT: "1" });
  });
});

describe("paths", () => {
  test("a long home directory falls back to a short private socket directory (unix socket path limit)", () => {
    const long = dispatchPaths({ DISPATCH_HOME: "/Users/someone-with-a-very-long-account-name/Library/Application Support/Dispatch-with-extra-suffix-for-length" });
    expect(long.pgSocket).toMatch(/^\/tmp\/dispatch-\w+\/sock$/); expect(Buffer.byteLength(long.pgSocket + "/.s.PGSQL.54329")).toBeLessThan(104);
    expect(dispatchPaths({ DISPATCH_HOME: "/h" }).pgSocket).toBe("/h/pg/sock");
  });
});
