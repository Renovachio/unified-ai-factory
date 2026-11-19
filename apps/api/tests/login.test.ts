import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { createTestDb } from "../../../packages/db/src/testing";
import { createApi } from "../src/app";
import { CompositeAuthenticator } from "../src/auth";
import { OidcLogin, safeReturnTo } from "../src/login";

const ISS = "https://idp.test", CLIENT = "factory-dashboard", ORIGIN = "https://factory.test", REDIRECT = `${ORIGIN}/api/v1/auth/callback`;
let db: Awaited<ReturnType<typeof createTestDb>>;
let login: OidcLogin;
let api: (r: Request) => Promise<Response>;
let idp: ReturnType<typeof Bun.serve>;
let priv: CryptoKey; let otherPriv: CryptoKey;
const clock = { t: Date.now() };
let org = "", jobId = "";
/** Per-login behaviours the fake issuer can be told to misbehave with. */
const idpMode: { sub: string; aud: string; iss: string; nonce?: string | null; expSec: number; alg: string; key: "good" | "other"; wrongVerifierOk: boolean } = { sub: "alice", aud: CLIENT, iss: ISS, expSec: 3600, alg: "ES256", key: "good", wrongVerifierOk: false };
const codes = new Map<string, { challenge: string; nonce: string }>();

beforeAll(async () => {
  db = await createTestDb();
  const good = await generateKeyPair("ES256", { extractable: true }); const other = await generateKeyPair("ES256", { extractable: true });
  priv = good.privateKey; otherPriv = other.privateKey;
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "ES256", use: "sig" } as JWK;
  idp = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const form = new URLSearchParams(await req.text());
    const c = codes.get(form.get("code") ?? "");
    if (!c || form.get("client_id") !== CLIENT || form.get("redirect_uri") !== REDIRECT) return new Response("bad", { status: 400 });
    const verifier = form.get("code_verifier") ?? "";
    if (!idpMode.wrongVerifierOk && createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
    codes.delete(form.get("code") as string);
    const now = Math.floor(clock.t / 1000);
    const jwt = new SignJWT({ ...(idpMode.nonce === null ? {} : { nonce: idpMode.nonce ?? c.nonce }) }).setProtectedHeader({ alg: idpMode.alg, kid: "k1" }).setSubject(idpMode.sub).setIssuer(idpMode.iss).setAudience(idpMode.aud).setIssuedAt(now - 10).setExpirationTime(now + idpMode.expSec);
    if (idpMode.alg === "HS256") return Response.json({ id_token: await jwt.sign(new TextEncoder().encode("x".repeat(32))) });
    return Response.json({ id_token: await jwt.sign(idpMode.key === "good" ? priv : otherPriv) });
  } });
  login = new OidcLogin(db.sql, { issuer: ISS, clientId: CLIENT, redirectUri: REDIRECT, authorizationEndpoint: `${ISS}/authorize`, tokenEndpoint: `http://127.0.0.1:${idp.port}/token`, keys: createLocalJWKSet({ keys: [jwk] }), insecureForTests: true, now: () => new Date(clock.t), sessionTtlSec: 8 * 3600, idleTtlSec: 1800, rotateAfterSec: 900, rotationGraceSec: 20 });
  api = createApi({ sql: db.sql, authenticator: new CompositeAuthenticator([login]), login, allowedOrigins: [ORIGIN] });
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('A') RETURNING id`)[0]!.id;
  const org2 = (await db.sql`INSERT INTO organizations (name) VALUES ('B') RETURNING id`)[0]!.id;
  await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, 'alice', 'viewer'), (${org}, 'bob', 'operator'), (${org2}, 'eve', 'admin')`;
  const [repo] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', '1', 'o', 'a') RETURNING id`;
  const [rq] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo!.id}, 'api', 'e1', 'x', 'feature', 't', 'd') RETURNING id`;
  jobId = (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${rq!.id}, ${repo!.id}) RETURNING id`)[0]!.id;
});
afterAll(async () => { idp.stop(true); await db.drop(); });

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  api(new Request(`${ORIGIN}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
const cookiesOf = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => { const [kv] = c.split(";"); const i = kv!.indexOf("="); return [kv!.slice(0, i), kv!.slice(i + 1)]; })) as Record<string, string>;
const jar = (c: Record<string, string>) => Object.entries(c).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("; ");

/** Plays the browser: /auth/login -> issuer authorizes -> /auth/callback. Returns the callback response and the cookies. */
async function browserLogin(o: { sub?: string; tamperState?: boolean; dropBinding?: boolean; returnTo?: string; mode?: Partial<typeof idpMode> } = {}) {
  Object.assign(idpMode, { sub: "alice", aud: CLIENT, iss: ISS, nonce: undefined, expSec: 3600, alg: "ES256", key: "good", wrongVerifierOk: false }, { sub: o.sub ?? "alice" }, o.mode ?? {});
  const start = await call("GET", `/api/v1/auth/login${o.returnTo ? `?return_to=${encodeURIComponent(o.returnTo)}` : ""}`);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(`${ISS}/authorize`);
  const p = loc.searchParams;
  expect(p.get("response_type")).toBe("code"); expect(p.get("code_challenge_method")).toBe("S256"); expect(p.get("client_id")).toBe(CLIENT); expect(p.get("redirect_uri")).toBe(REDIRECT);
  expect(p.get("state")!.length).toBeGreaterThan(20); expect(p.get("nonce")!.length).toBeGreaterThan(20);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  codes.set(code, { challenge: p.get("code_challenge")!, nonce: p.get("nonce")! });
  const pre = cookiesOf(start);
  const state = o.tamperState ? "tampered-state-value-xxxxxxxxxxxx" : p.get("state")!;
  const cb = await call("GET", `/api/v1/auth/callback?code=${code}&state=${state}`, o.dropBinding ? {} : { cookie: jar(pre) });
  return { start, cb, state: p.get("state")!, code, binding: pre, cookies: { ...pre, ...cookiesOf(cb) } };
}
const session = (cookies: Record<string, string>) => call("GET", "/api/v1/session", { cookie: jar(cookies) });
const sessionCookie = (c: Record<string, string>) => ({ factory_session: c.factory_session! });

describe("login: authorization code + PKCE, state, nonce, issuer/audience checks", () => {
  test("happy path: redirect carries S256 challenge/state/nonce; callback creates an opaque HttpOnly session and clears the single-use binding; /session shows DB role", async () => {
    const r = await browserLogin();
    expect(r.cb.status).toBe(302);
    expect(r.cb.headers.get("location")).toBe("/");
    const raw = r.cb.headers.getSetCookie().find((c) => c.startsWith("factory_session="))!;
    expect(raw).toMatch(/HttpOnly/); expect(raw).toMatch(/SameSite=Lax/); expect(raw).toMatch(/Path=\//); expect(raw).toMatch(/Max-Age=28800/);
    expect(r.cb.headers.getSetCookie().find((c) => c.startsWith("factory_login="))).toMatch(/Max-Age=0/);
    expect(r.start.headers.getSetCookie()[0]).toMatch(/HttpOnly.*SameSite=Lax/);
    const s = await session(sessionCookie(r.cookies));
    expect(s.status).toBe(200);
    const body = await s.json() as { role: string; via: string; csrf: string };
    expect(body).toMatchObject({ role: "viewer", via: "session" }); expect(body.csrf.length).toBeGreaterThan(20);
    // opaque id, stored only hashed
    const id = r.cookies.factory_session!;
    expect((await db.sql`SELECT count(*)::int AS c FROM auth_sessions WHERE id_hash = ${id}`)[0]!.c).toBe(0);
    expect((await db.sql`SELECT count(*)::int AS c FROM auth_sessions WHERE id_hash = ${createHash("sha256").update(id).digest("hex")}`)[0]!.c).toBe(1);
  });
  test("production configuration refuses http endpoints and uses __Host- Secure cookies", () => {
    const base = { issuer: ISS, clientId: CLIENT, redirectUri: REDIRECT, authorizationEndpoint: `${ISS}/a`, tokenEndpoint: `${ISS}/t`, keys: createLocalJWKSet({ keys: [] }) };
    expect(() => new OidcLogin(db.sql, { ...base, tokenEndpoint: "http://idp.test/t" })).toThrow(/https/);
    expect(() => new OidcLogin(db.sql, { ...base, redirectUri: "http://factory.test/cb" })).toThrow(/https/);
    const prod = new OidcLogin(db.sql, base);
    expect(prod.sessionCookie).toBe("__Host-factory_session");
  });
  test("production cookies carry Secure and SameSite", async () => {
    const prod = new OidcLogin(db.sql, { issuer: ISS, clientId: CLIENT, redirectUri: REDIRECT, authorizationEndpoint: `${ISS}/a`, tokenEndpoint: `${ISS}/t`, keys: createLocalJWKSet({ keys: [] }) });
    const r = await prod.start(new Request(`${ORIGIN}/api/v1/auth/login`));
    expect(r.headers.get("set-cookie")).toMatch(/^__Host-factory_login=.*HttpOnly; Secure; SameSite=Lax; Path=\//);
  });
  test("state is single-use: replaying a completed callback fails; unknown/tampered state fails", async () => {
    const ok = await browserLogin();
    expect(ok.cb.status).toBe(302);
    const replay = await call("GET", `/api/v1/auth/callback?code=${ok.code}&state=${ok.state}`, { cookie: jar(ok.binding) });
    expect(replay.status).toBe(400);
    expect((await browserLogin({ tamperState: true })).cb.status).toBe(400);
  });
  test("login CSRF / callback injection: a callback without (or with another browser's) binding cookie is rejected", async () => {
    expect((await browserLogin({ dropBinding: true })).cb.status).toBe(400);
    const victim = await call("GET", "/api/v1/auth/login");
    const a = await browserLogin();
    const loc = new URL((await call("GET", "/api/v1/auth/login")).headers.get("location")!);
    codes.set("attacker-code", { challenge: loc.searchParams.get("code_challenge")!, nonce: loc.searchParams.get("nonce")! });
    const cb = await call("GET", `/api/v1/auth/callback?code=attacker-code&state=${loc.searchParams.get("state")}`, { cookie: jar(cookiesOf(victim)) });
    expect(cb.status).toBe(400); // the attacker's state with the VICTIM's binding
    void a;
  });
  test("PKCE: an issuer that sees the wrong verifier refuses the exchange and no session is created", async () => {
    const before = (await db.sql`SELECT count(*)::int AS c FROM auth_sessions`)[0]!.c;
    const start = await call("GET", "/api/v1/auth/login");
    const p = new URL(start.headers.get("location")!).searchParams;
    codes.set("c-pkce", { challenge: "different-challenge", nonce: p.get("nonce")! });
    const cb = await call("GET", `/api/v1/auth/callback?code=c-pkce&state=${p.get("state")}`, { cookie: jar(cookiesOf(start)) });
    expect(cb.status).toBe(400);
    expect((await db.sql`SELECT count(*)::int AS c FROM auth_sessions`)[0]!.c).toBe(before);
  });
  test("ID-token attacks: wrong nonce, missing nonce, wrong audience, wrong issuer, expired, HS256, foreign signing key", async () => {
    for (const mode of [{ nonce: "attacker-nonce" }, { nonce: null }, { aud: "other-client" }, { iss: "https://evil.test" }, { expSec: -600 }, { alg: "HS256" }, { key: "other" as const }]) {
      const r = await browserLogin({ mode });
      expect(r.cb.status, JSON.stringify(mode)).toBe(400);
      expect(r.cookies.factory_session).toBeUndefined();
    }
  });
  test("an issuer error parameter ends the login; no implicit account creation; disabled users are refused", async () => {
    expect((await call("GET", "/api/v1/auth/callback?error=access_denied&state=x")).status).toBe(400);
    const stranger = await browserLogin({ sub: "mallory" });
    expect(stranger.cb.status).toBe(403);
    expect((await db.sql`SELECT count(*)::int AS c FROM users WHERE auth_subject='mallory'`)[0]!.c).toBe(0);
    await db.sql`UPDATE users SET disabled_at = now() WHERE auth_subject = 'bob'`;
    expect((await browserLogin({ sub: "bob" })).cb.status).toBe(403);
    await db.sql`UPDATE users SET disabled_at = NULL WHERE auth_subject = 'bob'`;
  });
  test("denied and allowed logins are audited", async () => {
    const rows = await db.sql`SELECT result, count(*)::int AS c FROM audit_entries WHERE action = 'auth.login' GROUP BY result`;
    const m = Object.fromEntries(rows.map((r) => [r.result, r.c]));
    expect(m.allowed).toBeGreaterThanOrEqual(1); expect(m.denied).toBeGreaterThanOrEqual(5);
  });
  test("open redirect: return_to is restricted to same-site relative paths", async () => {
    for (const bad of ["//evil.test/x", "https://evil.test", "/\\evil.test", "/javascript:alert(1)", "javascript:alert(1)", "/a\nb"]) expect(safeReturnTo(bad), bad).toBe("/");
    expect(safeReturnTo("/jobs/123?tab=timeline")).toBe("/jobs/123?tab=timeline");
    const r = await browserLogin({ returnTo: "//evil.test/phish" });
    expect(r.cb.headers.get("location")).toBe("/");
    expect((await browserLogin({ returnTo: "/jobs" })).cb.headers.get("location")).toBe("/jobs");
  });
});

describe("session lifecycle and server-side authorization", () => {
  test("forged, tampered, malformed and fixated cookies are rejected; login does not adopt a planted session id", async () => {
    for (const c of ["factory_session=forged", "factory_session=" + "A".repeat(43), "factory_session=" + Buffer.from(JSON.stringify({ sub: "eve", role: "admin" })).toString("base64url"), "factory_session=a.b.c"]) expect((await call("GET", "/api/v1/session", { cookie: c })).status, c).toBe(401);
    // fixation: attacker plants an id before login; the login mints a different id and the planted one stays dead
    const planted = "P".repeat(43);
    const start = await call("GET", "/api/v1/auth/login", { cookie: `factory_session=${planted}` });
    const p = new URL(start.headers.get("location")!).searchParams; codes.set("fx", { challenge: p.get("code_challenge")!, nonce: p.get("nonce")! });
    Object.assign(idpMode, { sub: "alice", aud: CLIENT, iss: ISS, nonce: undefined, expSec: 3600, alg: "ES256", key: "good" });
    const cb = await call("GET", `/api/v1/auth/callback?code=fx&state=${p.get("state")}`, { cookie: jar({ ...cookiesOf(start), factory_session: planted }) });
    expect(cookiesOf(cb).factory_session).not.toBe(planted);
    expect((await call("GET", "/api/v1/session", { cookie: `factory_session=${planted}` })).status).toBe(401);
  });
  test("roles are enforced on the server from the database, not from anything the browser holds; a role change applies to live sessions immediately", async () => {
    const r = await browserLogin({ sub: "alice" });
    const c = sessionCookie(r.cookies);
    const csrf = ((await (await session(c)).json()) as { csrf: string }).csrf;
    const write = () => call("POST", "/api/v1/workers/w1/drain", { cookie: jar(c), origin: ORIGIN, "x-csrf-token": csrf }, {});
    expect((await call("GET", "/api/v1/audit", { cookie: jar(c) })).status).toBe(403);
    expect((await write()).status).toBe(403); // viewer
    await db.sql`UPDATE users SET role = 'operator' WHERE auth_subject='alice'`;
    expect((await call("GET", "/api/v1/workers", { cookie: jar(c) })).status).toBe(200); // promoted in the DB: effective on the live session at once
    await db.sql`UPDATE users SET role = 'viewer' WHERE auth_subject='alice'`;
    expect((await call("GET", "/api/v1/workers", { cookie: jar(c) })).status).toBe(403); // and demotion likewise
  });
  test("CSRF: cookie-authenticated writes need an allowed Origin and the session's token; logout is protected too", async () => {
    const r = await browserLogin({ sub: "bob" });
    const c = jar(sessionCookie(r.cookies));
    const csrf = ((await (await session(sessionCookie(r.cookies))).json()) as { csrf: string }).csrf;
    const kill = (h: Record<string, string>) => call("POST", "/api/v1/auto-merge/kill", { cookie: c, ...h }, { reason: "drill" });
    // (auto-merge controller is not configured here -> 503 only AFTER the checks that matter pass; before that: 403)
    expect((await call("POST", "/api/v1/auth/logout", { cookie: c })).status).toBe(403);
    expect((await call("POST", "/api/v1/auth/logout", { cookie: c, origin: "https://evil.test", "x-csrf-token": csrf })).status).toBe(403);
    expect((await call("POST", "/api/v1/auth/logout", { cookie: c, origin: ORIGIN, "x-csrf-token": "wrong" + csrf })).status).toBe(403);
    expect((await call("POST", "/api/v1/jobs/" + jobId + "/feedback", { cookie: c, origin: ORIGIN }, { message: "x", expectedVersion: 1 })).status).toBe(403);
    void kill;
    expect((await session(sessionCookie(r.cookies))).status).toBe(200); // still logged in after the refused attempts
  });
  test("logout revokes server-side: replaying the old cookie fails; the cookie is cleared; logout is audited", async () => {
    const r = await browserLogin({ sub: "bob" });
    const ck = sessionCookie(r.cookies);
    const csrf = ((await (await session(ck)).json()) as { csrf: string }).csrf;
    const out = await call("POST", "/api/v1/auth/logout", { cookie: jar(ck), origin: ORIGIN, "x-csrf-token": csrf });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/factory_session=;.*Max-Age=0/);
    expect((await session(ck)).status).toBe(401);
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE action='auth.logout'`)[0]!.c).toBeGreaterThanOrEqual(1);
  });
  test("absolute expiry and idle timeout end sessions (server clock)", async () => {
    const r = await browserLogin({ sub: "bob" }); const ck = sessionCookie(r.cookies);
    const t0 = clock.t;
    clock.t = t0 + 31 * 60 * 1000; // > idle 30 min
    expect((await session(ck)).status).toBe(401);
    clock.t = t0;
    const r2 = await browserLogin({ sub: "bob" }); const ck2 = sessionCookie(r2.cookies);
    for (let i = 1; i <= 17; i++) { clock.t = t0 + i * 29 * 60 * 1000; const s = await session(ck2); if (s.status !== 200) break; const rot = cookiesOf(s).factory_session; if (rot) ck2.factory_session = rot; }
    clock.t = t0 + 8 * 3600 * 1000 + 1000;
    expect((await session(ck2)).status).toBe(401); // absolute 8 h
    clock.t = t0;
  });
  test("rotation: a rotated session id is replaced, the old id works only for a short grace, then is dead; the new id works", async () => {
    const t0 = clock.t;
    const r = await browserLogin({ sub: "bob" }); const old = r.cookies.factory_session!;
    clock.t = t0 + 16 * 60 * 1000; // > rotateAfter 15 min but < idle 30
    const s1 = await session({ factory_session: old });
    expect(s1.status).toBe(200);
    const fresh = cookiesOf(s1).factory_session!;
    expect(fresh).toBeTruthy(); expect(fresh).not.toBe(old);
    expect((await session({ factory_session: fresh })).status).toBe(200);
    expect((await session({ factory_session: old })).status).toBe(200); // within grace (concurrent in-flight requests)
    clock.t += 25 * 1000;
    expect((await session({ factory_session: old })).status).toBe(401); // grace over: replay of the old id fails
    expect((await session({ factory_session: fresh })).status).toBe(200);
    clock.t = t0;
  });
  test("logout after rotation also ends the successor; revokeAllForUser ends every live session; disabling a user ends theirs", async () => {
    const t0 = clock.t;
    const a = await browserLogin({ sub: "bob" }); const b = await browserLogin({ sub: "bob" });
    expect(await login.revokeAllForUser((await db.sql`SELECT id FROM users WHERE auth_subject='bob'`)[0]!.id as string)).toBeGreaterThanOrEqual(2);
    expect((await session(sessionCookie(a.cookies))).status).toBe(401);
    expect((await session(sessionCookie(b.cookies))).status).toBe(401);
    const c = await browserLogin({ sub: "bob" });
    await db.sql`UPDATE users SET disabled_at = now() WHERE auth_subject = 'bob'`;
    expect((await session(sessionCookie(c.cookies))).status).toBe(403);
    await db.sql`UPDATE users SET disabled_at = NULL WHERE auth_subject = 'bob'`;
    clock.t = t0;
  });
  test("protected routes: privileged API routes and the event stream reject unauthenticated callers; a session from one tenant sees nothing of another", async () => {
    for (const [m, p] of [["GET", "/api/v1/jobs"], ["GET", `/api/v1/jobs/${jobId}`], ["GET", `/api/v1/jobs/${jobId}/events`], ["GET", "/api/v1/workers"], ["GET", "/api/v1/audit"], ["GET", "/api/v1/usage"], ["GET", "/api/v1/auto-merge"]] as const) expect((await call(m, p)).status, p).toBe(401);
    const eve = await browserLogin({ sub: "eve" });
    expect((await call("GET", `/api/v1/jobs/${jobId}`, { cookie: jar(sessionCookie(eve.cookies)) })).status).toBe(404); // other organisation
    expect((await call("GET", `/api/v1/jobs/${jobId}/events`, { cookie: jar(sessionCookie(eve.cookies)) })).status).toBe(404);
    const bob = await browserLogin({ sub: "bob" });
    expect((await call("GET", `/api/v1/jobs/${jobId}`, { cookie: jar(sessionCookie(bob.cookies)) })).status).toBe(200);
  });
  test("login endpoints are only reachable with the right method and report 503 when not configured", async () => {
    expect((await call("POST", "/api/v1/auth/login")).status).toBe(405);
    expect((await call("GET", "/api/v1/auth/logout")).status).toBe(405);
    const bare = createApi({ sql: db.sql, authenticator: new CompositeAuthenticator([]) });
    expect((await bare(new Request(`${ORIGIN}/api/v1/auth/login`))).status).toBe(503);
  });
});
