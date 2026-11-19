// Dispatch local single-user mode (v2.3). Enabled ONLY by the launcher on a loopback bind. A per-install random token authenticates the local CLI;
// the browser gets a normal cookie session through a one-time, 60-second code. All RBAC/approval rules still apply to this identity like any other.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Sql } from "@factory/db";
import type { Authenticator } from "./auth";
import { SessionManager } from "./auth";
import { problems } from "./problem";

export const LOCAL_OWNER_SUBJECT = "dispatch-local-owner";
const sha = (s: string) => createHash("sha256").update(s).digest();

export class LocalOwnerAuthenticator implements Authenticator {
  private readonly want: Buffer;
  constructor(token: string) {
    if (token.length < 32) throw new Error("local owner token must be at least 32 characters");
    this.want = sha(token);
  }
  static fromFile(path: string): LocalOwnerAuthenticator { return new LocalOwnerAuthenticator(readFileSync(path, "utf8").trim()); }
  async authenticate(req: Request) {
    const h = req.headers.get("authorization");
    const m = h ? /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/.exec(h) : null;
    if (!m) return null; // not ours: let the next authenticator (OIDC) look at it
    const got = sha(m[1] as string);
    return got.length === this.want.length && timingSafeEqual(got, this.want) ? { subject: LOCAL_OWNER_SUBJECT, via: "bearer" as const } : null;
  }
}

/** Idempotent: ensures the local organisation and its owner account (role admin; self-approval rules still apply). Returns the org id. */
export async function bootstrapLocalOwner(sql: Sql): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(7426002)`;
    const [org0] = await tx<{ id: string }[]>`SELECT o.id FROM organizations o JOIN users u ON u.organization_id = o.id WHERE u.auth_subject = ${LOCAL_OWNER_SUBJECT} LIMIT 1`;
    if (org0) return org0.id;
    const [org] = await tx<{ id: string }[]>`INSERT INTO organizations (name) VALUES ('Dispatch (local)') RETURNING id`;
    await tx`INSERT INTO users (organization_id, auth_subject, role) VALUES (${(org as { id: string }).id}, ${LOCAL_OWNER_SUBJECT}, 'admin')`;
    return (org as { id: string }).id;
  });
}

/** One-time browser entry codes: single use, 60 s, in memory only, never logged. The code is exchanged for a cookie session, then forgotten. */
export class LocalBrowserEntry {
  private readonly codes = new Map<string, number>();
  constructor(private readonly sessions: SessionManager, private readonly dashboardUrl: string, private readonly now: () => number = Date.now) {
    const u = new URL(dashboardUrl); if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") throw new Error("local dashboard URL must be http://127.0.0.1:<port>");
  }
  mint(): string { for (const [c, exp] of this.codes) if (exp < this.now()) this.codes.delete(c); const c = randomBytes(24).toString("base64url"); this.codes.set(c, this.now() + 60_000); return c; }
  enter(req: Request): Response {
    const code = new URL(req.url).searchParams.get("code") ?? "";
    const exp = this.codes.get(code); this.codes.delete(code); // single use even when expired
    if (exp === undefined || exp < this.now()) throw problems.unauthorized("invalid or expired entry code");
    const { cookie } = this.sessions.issue(LOCAL_OWNER_SUBJECT, 8 * 3600, this.now(), false);
    return new Response(null, { status: 302, headers: { location: this.dashboardUrl, "set-cookie": cookie, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
}
