import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readState } from "@factory/dispatch-core";
import { apiCall, getSummary } from "../src/launcher/api";
import { makeCtx } from "../src/launcher/context";
import { startFactory } from "../src/commands/lifecycle";

// Real database/process startup is slow on a busy machine; give each test generous headroom (the CLI --timeout would otherwise cap it).
setDefaultTimeout(180_000);

// Real managed PostgreSQL + real API process (own OS processes), driven through the same code the `dispatch` command uses. No mocks.
let home = ""; let apiPort = 0; const env = () => ({ PATH: process.env.PATH ?? "", HOME: home, DISPATCH_HOME: home, DISPATCH_SELF_MAIN: join(import.meta.dir, "../src/main.ts"), DISPATCH_DASHBOARD_DIR: join(home, "no-dashboard") });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "dsp-stack-")); apiPort = 30000 + Math.floor(Math.random() * 20000); writeFileSync(join(home, "config.json"), JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", ports: { api: apiPort, web: apiPort + 1 }, postgres: { mode: "managed" }, browser: { open: false } })); });
afterAll(async () => { try { await makeCtx({ create: false, env: env() }).lifecycle.stop({ confirmed: true, activeJobs: 0 }); } catch { /* best effort */ } rmSync(home, { recursive: true, force: true }); });

describe("real managed stack (DSP-01/02 integration)", () => {
  let apiPid = 0; let pgPid = 0;
  test("first start creates the database + schema, starts the API, reports Degraded only because no dashboard exists; secrets are private", async () => {
    const c = makeCtx({ create: true, env: env() }); const r = await startFactory(c, { quiet: true });
    expect(r.ok).toBe(true); expect(r.phase).toBe("Degraded");
    const by = Object.fromEntries(r.services.map((s) => [s.name, s]));
    expect(by.postgres).toMatchObject({ state: "ready", mode: "managed" }); expect(by.api).toMatchObject({ state: "ready", mode: "managed" }); expect(by.dashboard).toMatchObject({ state: "failed", detail: expect.stringMatching(/dashboard build not found/) });
    expect(statSync(c.paths.token).mode & 0o777).toBe(0o600); expect(statSync(join(c.paths.secrets, "session-secret")).mode & 0o777).toBe(0o600);
    const st = readState(c.paths.state)!; apiPid = st.services.api!.pid!; pgPid = st.services.postgres!.pid!; expect(alive(apiPid)).toBe(true); expect(alive(pgPid)).toBe(true);
  });
  test("the API accepts the local owner token (RBAC applies) and rejects a wrong one, no token, and a model-provider-style header", async () => {
    const c = makeCtx({ create: false, env: env() });
    const ok = await getSummary(c.cfg, c.paths); expect(ok).toMatchObject({ ok: true, data: { jobs: { inFlight: 0 }, projects: 0 } });
    const base = `http://127.0.0.1:${apiPort}/api/v2/dispatch/summary`;
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { headers: { authorization: "Bearer " + "x".repeat(43) } })).status).toBe(401);
    expect((await fetch(base, { headers: { "x-api-key": "sk-ant-whatever", authorization: "Bearer nope" } })).status).toBe(401);
  });
  test("one-time browser code: becomes a session cookie once, never twice; only the local owner token can mint it", async () => {
    const c = makeCtx({ create: false, env: env() }); const base = `http://127.0.0.1:${apiPort}`;
    expect((await fetch(`${base}/api/v2/dispatch/browser-code`, { method: "POST", headers: { "idempotency-key": "k1" } })).status).toBe(401);
    const m = await apiCall<{ code: string }>(c.cfg, c.paths, "/api/v2/dispatch/browser-code", { method: "POST", key: "k2" }); expect(m.ok).toBe(true);
    const code = (m as { data: { code: string } }).data.code;
    const e1 = await fetch(`${base}/api/v1/local/enter?code=${code}`, { redirect: "manual" });
    expect(e1.status).toBe(302); expect(e1.headers.get("location")).toBe(`http://127.0.0.1:${apiPort + 1}`); const cookie = e1.headers.get("set-cookie")!; expect(cookie).toMatch(/^factory_session=/); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
    expect((await fetch(`${base}/api/v1/local/enter?code=${code}`, { redirect: "manual" })).status).toBe(401); // single use
    expect((await fetch(`${base}/api/v1/local/enter?code=bogus`, { redirect: "manual" })).status).toBe(401);
    const asBrowser = await fetch(`${base}/api/v2/dispatch/summary`, { headers: { cookie: cookie.split(";")[0]! } }); expect(asBrowser.status).toBe(200); // the cookie session works like the token
    const browserMint = await fetch(`${base}/api/v2/dispatch/browser-code`, { method: "POST", headers: { cookie: cookie.split(";")[0]!, "idempotency-key": "k3", origin: `http://127.0.0.1:${apiPort + 1}`, "x-csrf-token": "x" } });
    expect([401, 403]).toContain(browserMint.status); // a cookie session cannot mint further codes
  });
  test("a second launch attaches to the same processes (no duplicate API or database)", async () => {
    const c = makeCtx({ create: true, env: env() }); const r = await startFactory(c, { quiet: true }); expect(r.ok).toBe(true);
    const st = readState(c.paths.state)!; expect(st.services.api!.pid).toBe(apiPid); expect(st.services.postgres!.pid).toBe(pgPid);
    const ps = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes("__serve api") && l.includes(st.instanceId)); expect(ps).toHaveLength(1);
  });
  test("a crashed API (SIGKILL) is detected as down, and the next launch restarts only it, reusing the database", async () => {
    process.kill(apiPid, "SIGKILL"); const t = Date.now(); while (alive(apiPid) && Date.now() - t < 3000) await new Promise((x) => setTimeout(x, 50));
    const c = makeCtx({ create: false, env: env() }); const down = await c.lifecycle.status(); expect(down.services.find((s) => s.name === "api")!.state).toBe("stopped");
    const r = await startFactory(makeCtx({ create: true, env: env() }), { quiet: true }); expect(r.services.find((s) => s.name === "api")).toMatchObject({ state: "ready", mode: "managed" });
    const st = readState(c.paths.state)!; expect(st.services.api!.pid).not.toBe(apiPid); expect(st.services.postgres!.pid).toBe(pgPid); apiPid = st.services.api!.pid!;
  });
  test("an existing database with pending migrations is NOT migrated silently: the factory refuses to come up and says how", async () => {
    const c = makeCtx({ create: false, env: env() });
    await c.lifecycle.stop({ confirmed: true, activeJobs: 0 }); // stop owned services, keep the data directory
    const url = `postgres://dispatch@localhost/dispatch?host=${encodeURIComponent(c.paths.pgSocket)}&port=54329`;
    const r0 = await startFactory(makeCtx({ create: true, env: env() }), { quiet: true }); expect(r0.ok).toBe(true);
    const { default: postgres } = await import("postgres"); const sql = postgres(url, { max: 1 });
    await sql`DELETE FROM schema_migrations WHERE version = '0013'`; await sql.end();
    await makeCtx({ create: false, env: env() }).lifecycle.stop({ confirmed: true, activeJobs: 0 });
    const r = await startFactory(makeCtx({ create: true, env: env() }), { quiet: true });
    expect(r.ok).toBe(false); expect(r.services.find((s) => s.name === "postgres")).toMatchObject({ state: "failed", detail: expect.stringMatching(/pending migration.*dispatch migrate/) });
    expect(r.services.find((s) => s.name === "api")!.detail).toMatch(/not started/);
  });
  test("stop with in-flight jobs requires confirmation; confirmed stop leaves no process, listener or lock behind", async () => {
    const c = makeCtx({ create: false, env: env() });
    const refused = await c.lifecycle.stop({ confirmed: false, activeJobs: 3 }); expect(refused).toMatchObject({ stopped: false, reason: "active-jobs" });
    const done = await c.lifecycle.stop({ confirmed: true, activeJobs: 3 }); expect(done.stopped).toBe(true);
    const t = Date.now(); while ((alive(apiPid) || alive(pgPid)) && Date.now() - t < 5000) await new Promise((x) => setTimeout(x, 100));
    expect(alive(apiPid)).toBe(false); expect(readState(c.paths.state)!.phase).toBe("Stopped");
    expect((await fetch(`http://127.0.0.1:${apiPort}/api/v1/health/live`).catch(() => null))).toBeNull();
    expect(() => readFileSync(c.paths.lock)).toThrow();
  });
});
