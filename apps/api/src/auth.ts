import { createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Sql } from "@factory/db";
import { problems } from "./problem";

export const ROLES = ["viewer", "editor", "operator", "approver", "admin", "security_officer"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "job:read" | "job:create" | "job:feedback" | "job:cancel" | "job:resume" | "job:decide" | "job:pause" | "job:quarantine" | "worker:read" | "worker:manage" | "job:quarantine-release" | "audit:read" | "usage:read" | "automerge:read" | "automerge:kill" | "automerge:configure" | "job:hold-auto"
  | "skill:read" | "skill:import" | "skill:disable" | "capability:match" | "approval:request" | "approval:decide" | "activation:write" | "improvement:read" | "improvement:experiment" | "product:write" | "product:handoff";

/** Deny-by-default permission matrix (blueprint section 10 / 14). */
export const PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  viewer: new Set(["job:read"]),
  editor: new Set(["job:read", "job:create", "job:feedback", "skill:read", "skill:import", "capability:match", "improvement:read", "product:write"]),
  operator: new Set(["job:read", "job:create", "job:feedback", "job:cancel", "job:resume", "job:pause", "job:quarantine", "worker:read", "worker:manage", "usage:read", "automerge:read", "automerge:kill", "job:hold-auto", "skill:read", "skill:import", "skill:disable", "capability:match", "approval:request", "activation:write", "improvement:read", "improvement:experiment", "product:write", "product:handoff"]),
  approver: new Set(["job:read", "job:decide", "job:hold-auto", "automerge:read", "skill:read", "capability:match", "approval:decide", "improvement:read"]),
  admin: new Set(["job:read", "job:create", "job:feedback", "job:cancel", "job:resume", "job:decide", "job:pause", "job:quarantine", "worker:read", "worker:manage", "audit:read", "usage:read", "automerge:read", "automerge:kill", "automerge:configure", "job:hold-auto", "skill:read", "skill:import", "skill:disable", "capability:match", "approval:request", "approval:decide", "activation:write", "improvement:read", "improvement:experiment", "product:write", "product:handoff"]),
  security_officer: new Set(["job:read", "job:cancel", "job:quarantine", "job:quarantine-release", "worker:read", "worker:manage", "audit:read", "usage:read", "automerge:read", "automerge:kill", "automerge:configure", "job:hold-auto", "skill:read", "skill:disable", "approval:decide", "improvement:read"]),
};

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
  subject: string;
  via: "bearer" | "session";
  /** For cookie sessions: the CSRF token bound to the session. */
  csrf?: string;
}

export interface Authenticator {
  /** Returns the verified subject (and how it was verified) or null when no credentials are present. Throws ApiProblem on bad ones. */
  authenticate(req: Request): Promise<{ subject: string; via: "bearer" | "session"; csrf?: string } | null>;
}

export const can = (a: Actor, p: Permission): boolean => PERMISSIONS[a.role].has(p);
export function require_(a: Actor, p: Permission): void {
  if (!can(a, p)) throw problems.forbidden(`role ${a.role} may not ${p}`);
}

export interface OidcOptions {
  issuer: string;
  audience: string;
  /** Override for tests; production uses the issuer's JWKS over HTTPS. */
  keys?: JWTVerifyGetKey;
  jwksUri?: string;
  /** Tests only: permit http:// issuers. */
  allowInsecureIssuer?: boolean;
}

/** Verifies OIDC access/ID tokens: asymmetric algs only (never `none`/HS*), issuer, audience, exp/nbf with 30 s tolerance. */
export class OidcAuthenticator implements Authenticator {
  private readonly keys: JWTVerifyGetKey;
  constructor(private readonly o: OidcOptions) {
    if (!o.allowInsecureIssuer && !o.issuer.startsWith("https://")) throw new Error("OIDC issuer must be https://");
    this.keys = o.keys ?? createRemoteJWKSet(new URL(o.jwksUri ?? `${o.issuer.replace(/\/$/, "")}/.well-known/jwks.json`));
  }
  async authenticate(req: Request) {
    const h = req.headers.get("authorization");
    if (!h) return null;
    const m = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/.exec(h);
    if (!m) throw problems.unauthorized("malformed Authorization header");
    try {
      const { payload } = await jwtVerify(m[1] as string, this.keys, { issuer: this.o.issuer, audience: this.o.audience, algorithms: ["RS256", "ES256", "EdDSA"], clockTolerance: 30 });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("no sub");
      return { subject: payload.sub, via: "bearer" as const };
    } catch {
      throw problems.unauthorized("invalid or expired token");
    }
  }
}

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

/** Server-side-issued, HMAC-signed session cookie (after the dashboard completes OIDC login). */
export class SessionManager implements Authenticator {
  constructor(private readonly secret: string, private readonly cookieName = "factory_session") {
    if (secret.length < 32) throw new Error("session secret must be at least 32 characters");
  }
  private sig(body: string) { return createHmac("sha256", this.secret).update(body).digest(); }
  issue(subject: string, ttlSec = 8 * 3600, now = Date.now()): { cookie: string; csrf: string } {
    const csrf = b64(crypto.getRandomValues(new Uint8Array(24)));
    const body = b64(JSON.stringify({ sub: subject, exp: Math.floor(now / 1000) + ttlSec, csrf }));
    return { cookie: `${this.cookieName}=${body}.${b64(this.sig(body))}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ttlSec}`, csrf };
  }
  async authenticate(req: Request) {
    const raw = /(?:^|;\s*)factory_session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    if (!raw) return null;
    const [body, sig] = raw.split(".");
    if (!body || !sig) throw problems.unauthorized("invalid session");
    const expected = this.sig(body);
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw problems.unauthorized("invalid session");
    let p: { sub?: unknown; exp?: unknown; csrf?: unknown };
    try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { throw problems.unauthorized("invalid session"); }
    if (typeof p.sub !== "string" || typeof p.exp !== "number" || typeof p.csrf !== "string" || p.exp * 1000 < Date.now()) throw problems.unauthorized("session expired");
    return { subject: p.sub, via: "session" as const, csrf: p.csrf };
  }
}

/** Tries each authenticator in order. */
export class CompositeAuthenticator implements Authenticator {
  constructor(private readonly list: Authenticator[]) {}
  async authenticate(req: Request) {
    for (const a of this.list) { const r = await a.authenticate(req); if (r) return r; }
    return null;
  }
}

/** Resolve a verified subject to an enabled local user (no implicit account creation). */
export async function resolveActor(sql: Sql, id: { subject: string; via: "bearer" | "session"; csrf?: string }): Promise<Actor> {
  const rows = await sql<{ id: string; organization_id: string; role: Role; disabled_at: Date | null }[]>`SELECT id, organization_id, role, disabled_at FROM users WHERE auth_subject = ${id.subject}`;
  if (rows.length !== 1) throw problems.forbidden("no active account for this identity");
  const u = rows[0] as (typeof rows)[number];
  if (u.disabled_at) throw problems.forbidden("account disabled");
  return { userId: u.id, orgId: u.organization_id, role: u.role, subject: id.subject, via: id.via, ...(id.csrf ? { csrf: id.csrf } : {}) };
}

/** Cookie-authenticated browser writes need a matching Origin and the double-submit CSRF token. */
export function assertCsrf(req: Request, actor: Actor, allowedOrigins: readonly string[]): void {
  if (actor.via !== "session") return;
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) throw problems.forbidden("origin not allowed");
  const token = req.headers.get("x-csrf-token");
  if (!token || !actor.csrf || token.length !== actor.csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(actor.csrf))) throw problems.forbidden("missing or invalid CSRF token");
}
