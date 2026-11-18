import { createSign } from "node:crypto";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** GitHub App JWT (RS256, max 10 minutes). Signing happens in the control plane only. */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Separation of duties: the credential used to push branches can never merge, and vice versa. */
export type TokenRole = "read" | "branch_write" | "merge";

export const ROLE_PERMISSIONS: Readonly<Record<TokenRole, Readonly<Record<string, "read" | "write">>>> = {
  read: { metadata: "read", contents: "read", pull_requests: "read", checks: "read", statuses: "read" },
  branch_write: { metadata: "read", contents: "write", pull_requests: "write" },
  merge: { metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read" },
};

export interface TokenProvider {
  token(role: TokenRole, repo: { owner: string; name: string }): Promise<string>;
}

export interface InstallationTokenOptions {
  apiBase: string;
  appId: string;
  privateKeyPem: string;
  installationId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Short-lived, installation-scoped, repository-narrowed tokens; cached until shortly before expiry. */
export class InstallationTokenProvider implements TokenProvider {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  constructor(private readonly o: InstallationTokenOptions) {}

  async token(role: TokenRole, repo: { owner: string; name: string }): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    const key = `${role}:${repo.owner}/${repo.name}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - 60_000 > now) return hit.token;
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(`${this.o.apiBase}/app/installations/${encodeURIComponent(this.o.installationId)}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createAppJwt(this.o.appId, this.o.privateKeyPem, Math.floor(now / 1000))}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ repositories: [repo.name], permissions: ROLE_PERMISSIONS[role] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`installation token request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof json.token !== "string" || typeof json.expires_at !== "string") throw new Error("installation token response malformed");
    this.cache.set(key, { token: json.token, expiresAt: Date.parse(json.expires_at) });
    return json.token;
  }
}
