import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../packages/db/src/testing";
import { bootstrapLocalOwner, CompositeAuthenticator, createApi, LOCAL_OWNER_SUBJECT, LocalBrowserEntry, LocalOwnerAuthenticator, SessionManager } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>; let api: (r: Request) => Promise<Response>; let now = Date.now();
const TOKEN = "t".repeat(48); const sm = new SessionManager("s".repeat(40));
let orgId = ""; let n = 0;
beforeAll(async () => {
  db = await createTestDb();
  orgId = await bootstrapLocalOwner(db.sql);
  api = createApi({ sql: db.sql, rateLimit: { capacity: 10000, refillPerSec: 10000 }, allowedOrigins: ["http://127.0.0.1:3000"], authenticator: new CompositeAuthenticator([new LocalOwnerAuthenticator(TOKEN), sm]), local: { entry: new LocalBrowserEntry(sm, "http://127.0.0.1:3000", () => now) } });
});
afterAll(async () => { await db.drop(); });
const call = (path: string, o: { method?: string; token?: string | null; headers?: Record<string, string> } = {}) =>
  api(new Request(`http://api.test${path}`, { method: o.method ?? "GET", headers: { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }), ...(o.method === "POST" ? { "idempotency-key": `k${++n}` } : {}), ...(o.headers ?? {}) } }));
async function job(org: string, state: string) {
  const [repo] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', ${"x" + n++}, 'o', 'r') RETURNING id`;
  const [rq] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo!.id}, 'api', ${"s" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  await db.sql`ALTER TABLE jobs DISABLE TRIGGER USER`;
  await db.sql`INSERT INTO jobs (request_id, repository_id, state) VALUES (${rq!.id}, ${repo!.id}, ${state})`;
  await db.sql`ALTER TABLE jobs ENABLE TRIGGER USER`;
}

describe("Dispatch local mode (DSP-01/02 API side)", () => {
  test("the local owner token authenticates as the bootstrapped admin; bootstrap is idempotent", async () => {
    expect(await bootstrapLocalOwner(db.sql)).toBe(orgId);
    expect((await db.sql`SELECT count(*) AS c FROM users WHERE auth_subject = ${LOCAL_OWNER_SUBJECT}`)[0]!.c).toBe("1");
    const r = await call("/api/v1/session"); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ role: "admin", via: "bearer" });
  });
  test("wrong, short-prefix, missing and malformed tokens are rejected; a short configured token is refused at construction", async () => {
    for (const t of ["x".repeat(48), TOKEN.slice(0, 47), TOKEN + "x"]) expect((await call("/api/v1/session", { token: t })).status).toBe(401);
    expect((await call("/api/v1/session", { token: null })).status).toBe(401);
    expect((await call("/api/v1/session", { headers: { authorization: "Basic abc" }, token: null })).status).toBe(401);
    expect(() => new LocalOwnerAuthenticator("short")).toThrow(/at least 32/);
  });
  test("summary counts only this organisation's jobs, separating in-flight from waiting-on-human", async () => {
    await job(orgId, "BUILDING"); await job(orgId, "GATING"); await job(orgId, "AWAITING_HUMAN"); await job(orgId, "DONE");
    const [other] = await db.sql`INSERT INTO organizations (name) VALUES ('other') RETURNING id`; await job(other!.id, "BUILDING"); await job(other!.id, "AWAITING_HUMAN");
    const s = await (await call("/api/v2/dispatch/summary")).json();
    expect(s).toMatchObject({ jobs: { inFlight: 2, waitingOnHuman: 1, total: 4 }, approvals: { pending: 1, jobDecisions: 1, capabilityApprovals: 0 }, projects: 4 });
  });
  test("browser codes: minted only by the owner bearer token, single-use, expire after 60 s, produce a non-Secure loopback cookie that works as a session", async () => {
    expect((await call("/api/v2/dispatch/browser-code", { method: "POST", token: null })).status).toBe(401);
    const code = ((await (await call("/api/v2/dispatch/browser-code", { method: "POST" })).json()) as { code: string }).code;
    const e = await api(new Request(`http://api.test/api/v1/local/enter?code=${code}`)); expect(e.status).toBe(302);
    expect(e.headers.get("location")).toBe("http://127.0.0.1:3000"); const cookie = e.headers.get("set-cookie")!; expect(cookie).not.toContain("Secure"); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
    expect((await api(new Request(`http://api.test/api/v1/local/enter?code=${code}`))).status).toBe(401);
    expect((await call("/api/v2/dispatch/summary", { token: null, headers: { cookie: cookie.split(";")[0]! } })).status).toBe(200);
    const sess = await call("/api/v2/dispatch/browser-code", { method: "POST", token: null, headers: { cookie: cookie.split(";")[0]!, origin: "http://127.0.0.1:3000" } }); expect(sess.status).toBe(403); // sessions cannot mint codes
    const c2 = ((await (await call("/api/v2/dispatch/browser-code", { method: "POST" })).json()) as { code: string }).code; now += 61_000;
    expect((await api(new Request(`http://api.test/api/v1/local/enter?code=${c2}`))).status).toBe(401); // expired
  });
  test("the dashboard URL must be loopback http; without local mode the local routes do not exist", async () => {
    expect(() => new LocalBrowserEntry(sm, "https://evil.example")).toThrow(/127\.0\.0\.1/); expect(() => new LocalBrowserEntry(sm, "http://localhost:3000")).toThrow();
    const plain = createApi({ sql: db.sql, authenticator: new CompositeAuthenticator([new LocalOwnerAuthenticator(TOKEN)]) });
    expect((await plain(new Request("http://api.test/api/v1/local/enter?code=x"))).status).toBe(404);
    expect((await plain(new Request("http://api.test/api/v2/dispatch/browser-code", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "z" } }))).status).toBe(404);
  });
});
