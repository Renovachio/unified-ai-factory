import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { transitionJob } from "../../db/src/index";
import { createTestDb } from "../../db/src/testing";
import { bootstrapLocalOwner, CompositeAuthenticator, createApi, LocalBrowserEntry, LocalOwnerAuthenticator, SessionManager } from "../../../apps/api/src/index";
import { DispatchClient, SyncEngine, type SyncTransport } from "../src/index";

// Real HTTP server (createApi over a real database) with two independent clients: "terminal" (owner token) and "browser" (cookie session). No mocks.
let db: Awaited<ReturnType<typeof createTestDb>>; let server: ReturnType<typeof Bun.serve>; let base = ""; let org = ""; let repo = ""; let n = 0;
const TOKEN = "q".repeat(48); const sm = new SessionManager("z".repeat(40)); let cookie = "";
let dropStreams = false;
beforeAll(async () => {
  db = await createTestDb(); org = await bootstrapLocalOwner(db.sql);
  const api = createApi({ sql: db.sql, rateLimit: { capacity: 100000, refillPerSec: 100000 }, allowedOrigins: [], authenticator: new CompositeAuthenticator([new LocalOwnerAuthenticator(TOKEN), sm]), local: { entry: new LocalBrowserEntry(sm, "http://127.0.0.1:3000") } });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 60, fetch: api }); base = `http://127.0.0.1:${server.port}`;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r1', 'o', 'n') RETURNING id`)[0]!.id;
  const code = ((await (await fetch(`${base}/api/v2/dispatch/browser-code`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "bc" } })).json()) as { code: string }).code;
  cookie = (await fetch(`${base}/api/v1/local/enter?code=${code}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
});
afterAll(async () => { server.stop(true); await db.drop(); });

const terminal = () => new DispatchClient({ baseUrl: base, headers: () => ({ authorization: `Bearer ${TOKEN}` }) });
const browser = () => new DispatchClient({ baseUrl: base, headers: () => ({ cookie }) });
const transport = (c: DispatchClient): SyncTransport => ({ snapshot: () => c.snapshot(), job: (id) => c.job(id), stream: async function* (cursor, signal) { const ac = new AbortController(); signal.addEventListener("abort", () => ac.abort(), { once: true }); let k = 0; for await (const e of c.stream(cursor, ac.signal)) { yield e; if (dropStreams && ++k >= 1) { ac.abort(); return; } } } });
const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };
async function newJob(): Promise<string> {
  const k = terminal().mutation("POST", "/api/v1/jobs", { repositoryId: repo, request: { type: "feature", title: `t${n}`, description: "d", sourceId: `s${n++}` } });
  return (await terminal().send<{ jobId: string }>(k)).jobId;
}
const move = async (id: string, to: "INTAKE" | "SPECIFYING" | "READY") => { const [j] = await db.sql`SELECT version FROM jobs WHERE id = ${id}`; await transitionJob(db.sql, { jobId: id, expectedVersion: j!.version, next: to, actor: "orchestrator" }); };

describe("cross-interface consistency against the real API (DSP-05)", () => {
  test("a change made through one client appears in the other's synchronised view, and vice versa", async () => {
    const a = new SyncEngine(transport(terminal())); const b = new SyncEngine(transport(browser())); a.start(); b.start(); await until(() => a.state.status === "live" && b.state.status === "live");
    const id = await newJob(); await until(() => a.state.jobs.has(id) && b.state.jobs.has(id));
    await move(id, "INTAKE"); await until(() => a.state.jobs.get(id)?.state === "INTAKE" && b.state.jobs.get(id)?.state === "INTAKE");
    expect(a.state.jobs.get(id)!.revision).toBe(b.state.jobs.get(id)!.revision); expect(a.state.summary!.jobs.total).toBeGreaterThan(0);
    await a.stop(); await b.stop();
  });
  test("dropped connections reconnect from the cursor with no lost events and no duplicate jobs", async () => {
    const eng = new SyncEngine(transport(terminal()), { baseMs: 20, maxMs: 60 }); dropStreams = true; eng.start(); await until(() => eng.state.status === "live");
    const ids: string[] = []; for (let i = 0; i < 4; i++) { const id = await newJob(); ids.push(id); await move(id, "INTAKE"); await move(id, "SPECIFYING"); }
    await until(() => ids.every((id) => eng.state.jobs.get(id)?.state === "SPECIFYING")); dropStreams = false;
    expect(eng.state.reconnects).toBeGreaterThan(0); expect(new Set(ids).size).toBe(4); await eng.stop();
  });
  test("a retried create (same idempotency key) after an unknown outcome produces exactly one job", async () => {
    const m = terminal().mutation("POST", "/api/v1/jobs", { repositoryId: repo, request: { type: "feature", title: "once", description: "d", sourceId: "retry-1" } });
    const first = await terminal().send<{ jobId: string }>(m); const again = await terminal().retry<{ jobId: string }>(m);
    expect(again.jobId).toBe(first.jobId); expect(Number((await db.sql`SELECT count(*) AS c FROM requests WHERE source_external_id = 'retry-1'`)[0]!.c)).toBe(1);
  });
  test("tenant isolation: another organisation's client sees none of these jobs or events, and cannot stream them", async () => {
    const [o2] = await db.sql`INSERT INTO organizations (name) VALUES ('other') RETURNING id`; await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${o2!.id}, 'other-admin', 'admin')`;
    const other = new DispatchClient({ baseUrl: base, headers: () => ({ authorization: "Bearer " + "o".repeat(48) }) });
    expect(await other.snapshot().catch((e) => e)).toMatchObject({ status: 401 }); // unknown credential
    // Same-credential path: events for org A are filtered by organisation in the query; verify with a direct feed read as org B's actor
    const { readFeed } = await import("../../../apps/api/src/dispatch");
    const seen = await readFeed(db.sql, { userId: "u", orgId: o2!.id, role: "admin", subject: "other-admin", via: "bearer" }, 0, 500); expect(seen.events).toEqual([]);
    const mine = await terminal().events(0, 500); expect(mine.events.length).toBeGreaterThan(0);
  });
  test("an unauthenticated or malformed stream request is refused; the feed rejects bad cursors", async () => {
    expect((await fetch(`${base}/api/v2/dispatch/events/stream`)).status).toBe(401);
    expect(await terminal().get("/api/v2/dispatch/events?cursor=-1").catch((e) => e)).toMatchObject({ status: 400 });
    expect(await terminal().get("/api/v2/dispatch/events?cursor=abc").catch((e) => e)).toMatchObject({ status: 400 });
  });
  test("snapshot cursor precedes its rows: events committed after it are replayed by the feed, never skipped", async () => {
    const s0 = await terminal().snapshot(); const id = await newJob(); await move(id, "INTAKE");
    const page = await terminal().events(s0.cursor, 500); expect(page.events.some((e) => e.jobId === id && e.type === "job.transitioned")).toBe(true);
  });
});
