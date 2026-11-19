import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Sql } from "@factory/db";
import { digestOf, redactString } from "@factory/telemetry";
import type { Authenticator } from "./auth";
import { ApiProblem, problems } from "./problem";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rnd = (n = 32) => randomBytes(n).toString("base64url");
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface OidcLoginConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Issuer signing keys (JWKS). */
  keys: JWTVerifyGetKey;
  scopes?: string;
  /** Production requires https and Secure cookies; tests set this to run over loopback http. */
  insecureForTests?: boolean;
  sessionTtlSec?: number;
  idleTtlSec?: number;
  rotateAfterSec?: number;
  rotationGraceSec?: number;
  loginTtlSec?: number;
  sameSite?: "Lax" | "Strict";
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/** Only same-site relative paths survive; everything else (absolute URLs, protocol-relative, backslashes, control chars) becomes "/". */
export function safeReturnTo(v: string | null | undefined): string {
  if (!v || v.length > 500 || !v.startsWith("/") || v.startsWith("//") || [...v].some((ch) => ch === "\\" || ch.charCodeAt(0) < 32) || /^\/[a-z][a-z0-9+.-]*:/i.test(v)) return "/";
  return v;
}

export interface SessionResult { subject: string; via: "session"; csrf: string; sessionId: string }
export const pendingCookies = new WeakMap<Request, string[]>();

/** OIDC authorization-code + PKCE login, server-side sessions (opaque ids, hashed at rest), rotation, logout and revocation. */
export class OidcLogin implements Authenticator {
  readonly sessionCookie: string; readonly bindingCookie: string;
  private readonly secure: boolean;
  constructor(private readonly sql: Sql, private readonly c: OidcLoginConfig) {
    this.secure = !c.insecureForTests;
    if (this.secure) for (const [k, u] of [["issuer", c.issuer], ["authorizationEndpoint", c.authorizationEndpoint], ["tokenEndpoint", c.tokenEndpoint], ["redirectUri", c.redirectUri]] as const) if (!u.startsWith("https://")) throw new Error(`OIDC ${k} must be https:// (cookies are Secure)`);
    this.sessionCookie = this.secure ? "__Host-factory_session" : "factory_session";
    this.bindingCookie = this.secure ? "__Host-factory_login" : "factory_login";
  }
  private now() { return this.c.now?.() ?? new Date(); }
  private cookie(name: string, value: string, maxAge: number, sameSite: "Lax" | "Strict") {
    return `${name}=${value}; HttpOnly; ${this.secure ? "Secure; " : ""}SameSite=${sameSite}; Path=/; Max-Age=${maxAge}`;
  }
  private readCookie(req: Request, name: string): string | undefined {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("="); }
    return undefined;
  }
  private audit(orgId: string | null, actor: string, action: string, resource: string, result: string, reason: string) {
    return this.sql`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest) VALUES (${orgId}, ${actor}, ${action}, ${resource}, ${result}, ${redactString(reason).slice(0, 500)}, ${digestOf({ action, resource, actor, reason, at: this.now().toISOString(), n: rnd(6) })})`;
  }

  /** GET /auth/login: creates the login transaction (state, nonce, PKCE verifier, browser binding) and redirects to the issuer. */
  async start(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const state = rnd(), nonce = rnd(), verifier = rnd(48), binding = rnd();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expires = new Date(this.now().getTime() + (this.c.loginTtlSec ?? 600) * 1000);
    await this.sql`DELETE FROM auth_login_transactions WHERE expires_at < now() - interval '1 day'`;
    await this.sql`INSERT INTO auth_login_transactions (state_hash, nonce, code_verifier, return_to, browser_binding_hash, expires_at) VALUES (${sha(state)}, ${nonce}, ${verifier}, ${safeReturnTo(url.searchParams.get("return_to"))}, ${sha(binding)}, ${expires})`;
    const a = new URL(this.c.authorizationEndpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: this.c.clientId, redirect_uri: this.c.redirectUri, scope: this.c.scopes ?? "openid", state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) a.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: a.toString(), "set-cookie": this.cookie(this.bindingCookie, binding, this.c.loginTtlSec ?? 600, "Lax"), "cache-control": "no-store" } });
  }

  /** GET /auth/callback: single-use state, browser binding, PKCE code exchange, ID-token verification (issuer, audience, signature, exp, nonce). */
  async callback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const fail = async (why: string, status = 400): Promise<never> => { await this.audit(null, "anonymous", "auth.login", "oidc", "denied", why); throw new ApiProblem({ status, code: "login-failed", title: status === 403 ? "Forbidden" : "Bad Request", detail: "login could not be completed" }); };
    if (url.searchParams.get("error")) return fail(`issuer error ${url.searchParams.get("error")}`);
    const state = url.searchParams.get("state"), code = url.searchParams.get("code"), binding = this.readCookie(req, this.bindingCookie);
    if (!state || !code || !binding || code.length > 2000) return fail("missing state, code or browser binding");
    // consume atomically: replays and concurrent callbacks lose
    const [tx] = await this.sql<{ nonce: string; code_verifier: string; return_to: string; browser_binding_hash: string; expires_at: Date }[]>`UPDATE auth_login_transactions SET consumed_at = now() WHERE state_hash = ${sha(state)} AND consumed_at IS NULL RETURNING nonce, code_verifier, return_to, browser_binding_hash, expires_at`;
    if (!tx) return fail("unknown or already used state");
    if (tx.expires_at.getTime() < this.now().getTime()) return fail("login transaction expired");
    if (!eq(tx.browser_binding_hash, sha(binding))) return fail("browser binding mismatch (possible login CSRF / callback injection)");
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.c.redirectUri, client_id: this.c.clientId, code_verifier: tx.code_verifier, ...(this.c.clientSecret ? { client_secret: this.c.clientSecret } : {}) });
    let idToken: string;
    try {
      const r = await (this.c.fetchImpl ?? fetch)(this.c.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!r.ok) return fail(`token endpoint HTTP ${r.status}`);
      const j = (await r.json()) as { id_token?: unknown };
      if (typeof j.id_token !== "string") return fail("no id_token in token response");
      idToken = j.id_token;
    } catch (e) { if (e instanceof ApiProblem) throw e; return fail("token exchange failed"); }
    let sub: string;
    try {
      const { payload } = await jwtVerify(idToken, this.c.keys, { issuer: this.c.issuer, audience: this.c.clientId, algorithms: ["RS256", "ES256", "EdDSA"], clockTolerance: 30, ...(this.c.now ? { currentDate: this.c.now() } : {}) });
      if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no sub");
      if (typeof payload.nonce !== "string" || !eq(payload.nonce, tx.nonce)) throw new Error("nonce mismatch");
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.c.clientId) throw new Error("azp mismatch");
      sub = payload.sub;
    } catch (e) { return fail(`id_token rejected: ${e instanceof Error ? e.message : "invalid"}`); }
    const users = await this.sql<{ id: string; organization_id: string; disabled_at: Date | null }[]>`SELECT id, organization_id, disabled_at FROM users WHERE auth_subject = ${sub}`;
    const u = users.length === 1 ? users[0] : undefined;
    if (!u || u.disabled_at) return fail("no active account for this identity", 403); // never auto-provisions
    const { cookieValue } = await this.createSession(u.id);
    await this.audit(u.organization_id, u.id, "auth.login", "oidc", "allowed", "login completed");
    const headers = new Headers({ location: safeReturnTo(tx.return_to), "cache-control": "no-store" });
    headers.append("set-cookie", this.cookie(this.sessionCookie, cookieValue, this.c.sessionTtlSec ?? 8 * 3600, this.c.sameSite ?? "Lax"));
    headers.append("set-cookie", this.cookie(this.bindingCookie, "", 0, "Lax")); // binding is single-use
    return new Response(null, { status: 302, headers });
  }

  /** `inheritExpiry`: a rotated successor keeps the ORIGINAL absolute expiry (rotation must never extend a session's lifetime). */
  private async createSession(userId: string, replacing?: string, inheritExpiry?: Date): Promise<{ cookieValue: string; csrf: string }> {
    const id = rnd(32), csrf = rnd(24);
    const now = this.now();
    await this.sql`INSERT INTO auth_sessions (id_hash, user_id, csrf, created_at, last_seen_at, rotated_at, expires_at) VALUES (${sha(id)}, ${userId}, ${csrf}, ${now}, ${now}, ${now}, ${inheritExpiry ?? new Date(now.getTime() + (this.c.sessionTtlSec ?? 8 * 3600) * 1000)})`;
    if (replacing) await this.sql`UPDATE auth_sessions SET revoked_at = ${now}, revoke_reason = 'rotated', replaced_by = ${sha(id)} WHERE id_hash = ${replacing} AND revoked_at IS NULL`;
    return { cookieValue: id, csrf };
  }

  /** Authenticator: opaque cookie -> live (not revoked/expired/idle) session; rotates the id periodically (old id accepted only for a short grace). */
  async authenticate(req: Request) {
    const raw = this.readCookie(req, this.sessionCookie);
    if (!raw) return null;
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) throw problems.unauthorized("invalid session");
    const now = this.now();
    const h = sha(raw);
    const [s] = await this.sql<{ user_id: string; csrf: string; last_seen_at: Date; rotated_at: Date; expires_at: Date; revoked_at: Date | null; revoke_reason: string | null }[]>`SELECT user_id, csrf, last_seen_at, rotated_at, expires_at, revoked_at, revoke_reason FROM auth_sessions WHERE id_hash = ${h}`;
    if (!s) throw problems.unauthorized("invalid session");
    const grace = (this.c.rotationGraceSec ?? 20) * 1000;
    const rotatedOk = s.revoke_reason === "rotated" && s.revoked_at !== null && now.getTime() - s.revoked_at.getTime() <= grace;
    if (s.revoked_at && !rotatedOk) throw problems.unauthorized("session ended");
    if (s.expires_at.getTime() <= now.getTime()) throw problems.unauthorized("session expired");
    if (now.getTime() - s.last_seen_at.getTime() > (this.c.idleTtlSec ?? 1800) * 1000) { await this.revoke(h, "idle-timeout"); throw problems.unauthorized("session idle timeout"); }
    const [u] = await this.sql<{ disabled_at: Date | null }[]>`SELECT disabled_at FROM users WHERE id = ${s.user_id}`;
    if (!u || u.disabled_at) { await this.revoke(h, "user-disabled"); throw problems.forbidden("account disabled"); }
    const [subj] = await this.sql<{ auth_subject: string }[]>`SELECT auth_subject FROM users WHERE id = ${s.user_id}`;
    if (!subj) throw problems.unauthorized("invalid session");
    let csrf = s.csrf;
    if (!s.revoked_at) {
      await this.sql`UPDATE auth_sessions SET last_seen_at = ${now} WHERE id_hash = ${h}`;
      if (now.getTime() - s.rotated_at.getTime() > (this.c.rotateAfterSec ?? 900) * 1000) {
        const n = await this.createSession(s.user_id, h, s.expires_at);
        csrf = n.csrf;
        pendingCookies.set(req, [...(pendingCookies.get(req) ?? []), this.cookie(this.sessionCookie, n.cookieValue, Math.max(1, Math.floor((s.expires_at.getTime() - now.getTime()) / 1000)), this.c.sameSite ?? "Lax")]);
      }
    }
    return { subject: subj.auth_subject, via: "session" as const, csrf, sessionId: h };
  }

  private async revoke(idHash: string, reason: string) { await this.sql`UPDATE auth_sessions SET revoked_at = now(), revoke_reason = ${reason} WHERE id_hash = ${idHash} AND revoked_at IS NULL`; }

  /** POST /auth/logout (caller has passed the CSRF check): revokes this session and all of its rotation successors; clears the cookie. */
  async logout(req: Request, actorId: string, orgId: string): Promise<Response> {
    const raw = this.readCookie(req, this.sessionCookie);
    if (raw) {
      let h: string | null = sha(raw);
      for (let i = 0; h && i < 10; i++) { const cur: string = h; const [row] = await this.sql<{ replaced_by: string | null }[]>`SELECT replaced_by FROM auth_sessions WHERE id_hash = ${cur}`; await this.sql`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, 'logout') WHERE id_hash = ${cur}`; h = row?.replaced_by ?? null; }
    }
    await this.audit(orgId, actorId, "auth.logout", "session", "allowed", "logout");
    return new Response(null, { status: 204, headers: { "set-cookie": this.cookie(this.sessionCookie, "", 0, this.c.sameSite ?? "Lax"), "cache-control": "no-store" } });
  }

  /** Incident / offboarding: end every live session of a user. */
  async revokeAllForUser(userId: string, reason = "admin-revoked"): Promise<number> {
    const r = await this.sql`UPDATE auth_sessions SET revoked_at = now(), revoke_reason = ${reason} WHERE user_id = ${userId} AND revoked_at IS NULL RETURNING 1`;
    return r.length;
  }
}
