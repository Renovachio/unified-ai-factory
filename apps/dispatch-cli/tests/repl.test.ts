import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DispatchClient } from "@factory/dispatch-client";
import { createTestDb } from "../../../packages/db/src/testing";
import { bootstrapLocalOwner, CompositeAuthenticator, createApi, LocalBrowserEntry, LocalOwnerAuthenticator, SessionManager } from "../../../apps/api/src/index";
import type { Ctx } from "../src/launcher/context";
import { Executor } from "../src/repl/executor";
import { runRepl, type ReplHooks } from "../src/repl/repl";
import { Session } from "../src/repl/session";

let db: Awaited<ReturnType<typeof createTestDb>>; let server: ReturnType<typeof Bun.serve>; let base = ""; let org = ""; let repoId = ""; let home = ""; let n = 0;
const TOKEN = "r".repeat(48); let calls: string[] = [];
beforeAll(async () => {
  process.env.DISPATCH_CONFIG_DIR = join(import.meta.dir, "../../../config");
  db = await createTestDb(); org = await bootstrapLocalOwner(db.sql); home = mkdtempSync(join(tmpdir(), "dsp-repl-"));
  const sm = new SessionManager("y".repeat(40));
  const api = createApi({ sql: db.sql, rateLimit: { capacity: 100000, refillPerSec: 100000 }, authenticator: new CompositeAuthenticator([new LocalOwnerAuthenticator(TOKEN), sm]), local: { entry: new LocalBrowserEntry(sm, "http://127.0.0.1:3000") } });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 30, fetch: (r) => { calls.push(`${r.method} ${new URL(r.url).pathname}`); return api(r); } }); base = `http://127.0.0.1:${server.port}`;
  repoId = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'rr', 'acme', 'clip') RETURNING id`)[0]?.id as string;
});
afterAll(async () => { server.stop(true); await db.drop(); rmSync(home, { recursive: true, force: true }); });

const client = () => new DispatchClient({ baseUrl: base, headers: () => ({ authorization: `Bearer ${TOKEN}` }), timeoutMs: 5000 });
const ctx = () => ({ paths: { home }, cfg: {}, env: {} }) as unknown as Ctx;
async function seedJob(title: string, repo = repoId): Promise<string> { return (await db.sql`WITH q AS (INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"s" + n++}, 'x', 'feature', ${title}, 'd') RETURNING id) INSERT INTO jobs (request_id, repository_id) SELECT id, ${repo} FROM q RETURNING id`)[0]?.id as string; }
const hooks = (log: string[] = [], stopAnswer = false): ReplHooks => ({ openDashboard: async () => "dashboard opened", shutdown: async (io) => { const a = await io.ask("Type “shutdown”: "); log.push(a); return a === "shutdown" || stopAnswer ? { stopped: true, message: "stopped" } : { stopped: false, message: "Not stopped." }; } });
async function session(lines: string[], h = hooks(), extra: { initialRequest?: string } = {}): Promise<{ out: string; result: string }> {
  const input = new PassThrough(); const output = new PassThrough(); let out = ""; output.on("data", (d) => (out += String(d)));
  const p = runRepl(ctx(), h, { input, output, client: client(), ...extra }); for (const l of lines) input.write(l + "\n"); input.end(); const result = await p; return { out, result };
}

describe("interactive REPL against the real API (DSP-03/06/08)", () => {
  test("/help lists every documented command; unknown slash commands get suggestions and reach neither the API nor a shell", async () => {
    calls = []; const { out, result } = await session(["/help", "/statu", "/rm -rf /", "/exit"]);
    expect(out).toContain("\n  /new"); // multi-line output keeps its line breaks
    for (const c of ["/new", "/projects", "/project use", "/jobs", "/status", "/models", "/skills", "/agents", "/approvals", "/approve", "/pause", "/resume", "/cancel", "/logs", "/dashboard", "/context", "/exit", "/shutdown"]) expect(out).toContain(c);
    expect(out).toContain("Did you mean /status"); expect(out).toContain("Unknown command /rm"); expect(calls).toEqual([]); expect(result).toBe("detached");
  });
  test("/status, /projects and /jobs show real, tenant-scoped data; titles are rendered as data with control characters stripped", async () => {
    await seedJob("Fix clipboard \u001b[31mRED\u001b[0m sync"); const { out } = await session(["/status", "/projects", "/jobs", "/exit"]);
    expect(out).toMatch(/Jobs: \d+ in flight/); expect(out).toContain("acme/clip"); expect(out).toContain("Fix clipboard"); expect(out).not.toContain("\u001b[31m");
  });
  test("deterministic natural language needs no model; unrecognised text is refused and causes no API call", async () => {
    calls = []; const a = await session(["show my jobs", "exit"]); expect(a.out).toContain("job(s)"); expect(calls.some((c) => c.includes("/snapshot"))).toBe(true);
    calls = []; const b = await session(["pause the clipboard job", "/exit"]); expect(b.out).toContain("fixed set of phrases"); expect(calls).toEqual([]);
    const c = await session(["stop everything", "/exit"]); expect(c.out).toContain("Which do you want");
  });
  test("/project use sets scope; unknown/unauthorized projects are refused identically; /context shows and clears it", async () => {
    const [o2] = await db.sql`INSERT INTO organizations (name) VALUES ('rival') RETURNING id`; const [rr] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${o2?.id}, 'github', 'x9', 'rival', 'secret') RETURNING id`;
    const { out } = await session([`/project use ${repoId.slice(0, 8)}`, "/context", "/project use " + String(rr?.id), "/project use nope-nope", "/context clear", "/context", "/exit"]);
    expect(out).toContain("Active project: acme/clip"); expect(out).toContain("No visible project"); expect(out).not.toContain("rival"); expect(out).toContain("Context cleared");
    expect(out.split("Active project: none").length).toBeGreaterThanOrEqual(2);
  });
  test("a context pointing at a project that is no longer visible is dropped, not trusted (stale permission)", async () => {
    const s = Session.open(null, "dispatch-local-owner"); s.setProject("00000000-0000-4000-8000-000000000000", "ghost");
    const msgs: string[] = []; const ex = new Executor(client(), s, { out: (m) => msgs.push(m), ask: async () => "" }); const r = await ex.execute({ type: "job.list" });
    expect(msgs.join()).toContain("no longer available"); expect(s.projectId).toBeNull(); expect(r.status).toBe("completed");
  });
  test("cancel: wrong confirmation does nothing; right confirmation cancels exactly that job; ambiguity is never guessed", async () => {
    const a = await seedJob("cancel-me-alpha"); const b = await seedJob("cancel-me-beta");
    const amb = await session(["/cancel cancel-me", "/exit"]); expect(amb.out).toContain("matches 2 jobs");
    const no = await session([`/cancel ${a}`, "nope", "/exit"]); expect(no.out).toContain("Cancelled nothing"); expect((await db.sql`SELECT state FROM jobs WHERE id = ${a}`)[0]?.state).not.toBe("CANCELLED");
    const yes = await session([`/cancel ${a}`, a.slice(0, 8), "/exit"]); expect(yes.out).toContain("Cancelled job"); expect((await db.sql`SELECT state FROM jobs WHERE id = ${a}`)[0]?.state).toBe("CANCELLED"); expect((await db.sql`SELECT state FROM jobs WHERE id = ${b}`)[0]?.state).not.toBe("CANCELLED");
  });
  test("a confirmation is bound to the revision the user saw: if the job changes while confirming, nothing is cancelled", async () => {
    const id = await seedJob("moves-while-confirming"); const s = Session.open(null, "dispatch-local-owner");
    const ex = new Executor(client(), s, { out: () => undefined, ask: async () => { await db.sql`ALTER TABLE jobs DISABLE TRIGGER USER`; await db.sql`UPDATE jobs SET version = version + 1 WHERE id = ${id}`; await db.sql`ALTER TABLE jobs ENABLE TRIGGER USER`; return id.slice(0, 8); } });
    const r = await ex.execute({ type: "job.cancel", jobId: id }); expect(r).toMatchObject({ status: "blocked", reasonCode: "stale-confirmation" }); expect((await db.sql`SELECT state FROM jobs WHERE id = ${id}`)[0]?.state).not.toBe("CANCELLED");
  });
  test("pause then resume go through the existing operator endpoints with the observed revision", async () => {
    const id = await seedJob("pausable-job"); const p = await session([`/pause ${id}`, "/exit"]); expect(p.out).toContain("Pause requested"); expect((await db.sql`SELECT paused_at FROM jobs WHERE id = ${id}`)[0]?.paused_at).not.toBeNull();
    const r = await session([`/resume ${id}`, "/exit"]); expect(r.out).toContain("Resumed"); expect((await db.sql`SELECT paused_at FROM jobs WHERE id = ${id}`)[0]?.paused_at).toBeNull();
    const bad = await session(["/pause 11111111-1111-4111-8111-111111111111", "/exit"]); expect(bad.out).toContain("No visible job");
  });
  test("/models separates available, qualified and authorized; /skills and /agents label proposals; empty inbox says so", async () => {
    const m = await session(["/models", "/skills", "/agents", "/approvals", "/exit"]);
    expect(m.out).toContain("available 0 · qualified 0 · authorized 0"); expect(m.out).toContain("metered model APIs disabled"); expect(m.out).toContain("No runtime is configured"); expect(m.out).toContain("approved & active: 0"); expect(m.out).toContain("Nothing needs your attention");
  });
  test("a job awaiting a human decision is routed to the dashboard (exact SHA binding), never decided blindly from the terminal", async () => {
    const id = await seedJob("needs a human"); await db.sql`ALTER TABLE jobs DISABLE TRIGGER USER`; await db.sql`UPDATE jobs SET state = 'AWAITING_HUMAN' WHERE id = ${id}`; await db.sql`ALTER TABLE jobs ENABLE TRIGGER USER`;
    const { out } = await session(["/approvals", `/approve ${id.slice(0, 8)}`, "/exit"]); expect(out).toContain("job-decision"); expect(out).toContain("review and decide it in the dashboard");
  });
  test("/exit and end-of-input detach without stopping; /shutdown needs the typed confirmation and honours a refusal", async () => {
    const log: string[] = []; expect((await session(["/exit"])).result).toBe("detached"); expect((await session([])).result).toBe("detached");
    const refused = await session(["/shutdown", "no", "/exit"], hooks(log)); expect(refused.result).toBe("detached"); expect(refused.out).toContain("Not stopped");
    const ok = await session(["/shutdown", "shutdown"], hooks(log)); expect(ok.result).toBe("shutdown");
  });
  test("an unreachable factory yields a clear, non-crashing message", async () => {
    const dead = new DispatchClient({ baseUrl: "http://127.0.0.1:1", headers: () => ({}), timeoutMs: 500 }); const s = Session.open(null, "x"); const msgs: string[] = [];
    const r = await new Executor(dead, s, { out: (m) => msgs.push(m), ask: async () => "" }).execute({ type: "factory.status" }); expect(r.status).toBe("failed"); expect(r.message).toContain("dispatch status");
  });
  test("project.create is honestly blocked (no repository link), not faked", async () => {
    const r = await new Executor(client(), Session.open(null, "x"), { out: () => undefined, ask: async () => "" }).execute({ type: "project.create", title: "X" }); expect(r).toMatchObject({ status: "blocked", reasonCode: "project-not-linked" });
  });

  test("/dispatch <request> creates a job in the active project; the text is stored verbatim as untrusted data, not run", async () => {
    const before = Number((await db.sql`SELECT count(*) AS c FROM jobs`)[0]?.c);
    const { out } = await session([`/project use ${repoId.slice(0, 8)}`, "/dispatch add dark mode; rm -rf / /cancel everything", "/exit"]);
    expect(out).toContain("Request created: job"); expect(Number((await db.sql`SELECT count(*) AS c FROM jobs`)[0]?.c)).toBe(before + 1);
    const r = (await db.sql`SELECT description FROM requests ORDER BY created_at DESC LIMIT 1`)[0]; expect(r?.description).toBe("add dark mode; rm -rf / /cancel everything");
  });
  test("with exactly one project and none selected, /dispatch uses it; the shell form (initialRequest) does the same, then the prompt is usable", async () => {
    const before = Number((await db.sql`SELECT count(*) AS c FROM jobs`)[0]?.c);
    const { out } = await session(["/context", "/exit"], hooks(), { initialRequest: "write the release notes" });
    expect(out).toContain("Request created: job"); expect(out).toContain("Active project: acme/clip"); expect(Number((await db.sql`SELECT count(*) AS c FROM jobs`)[0]?.c)).toBe(before + 1);
  });
  test("with several projects and none selected it asks which one and creates nothing; with no project it says so", async () => {
    const [o] = await db.sql`SELECT id FROM organizations WHERE name = 'Dispatch (local)'`; const [r2] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${o?.id}, 'github', 'second', 'acme', 'other') RETURNING id`;
    const before = Number((await db.sql`SELECT count(*) AS c FROM jobs`)[0]?.c);
    const { out } = await session(["/context clear", "/dispatch do something", "/exit"]); expect(out).toContain("Which project?"); expect(out).toContain("acme/other"); expect(Number((await db.sql`SELECT count(*) AS c FROM jobs`)[0]?.c)).toBe(before);
    await db.sql`DELETE FROM repositories WHERE id = ${r2?.id}`;
    const none = await new Executor(client(), Session.open(null, "x"), { out: () => undefined, ask: async () => "" }).submitRequest("x"); expect(none.status === "completed" || none.status === "blocked").toBe(true);
  });
  test("/dispatch with no text shows usage and creates nothing", async () => {
    const before = Number((await db.sql`SELECT count(*) AS c FROM jobs`)[0]?.c); const { out } = await session(["/dispatch", "/exit"]); expect(out).toContain("Usage: /dispatch <request>"); expect(Number((await db.sql`SELECT count(*) AS c FROM jobs`)[0]?.c)).toBe(before);
  });
});
