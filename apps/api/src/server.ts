// Production entrypoint. Refuses to start with model credentials in the environment (SECURITY.md).
import { readFileSync } from "node:fs";
import { connect } from "@factory/db";
import { assertEnvAllowed } from "@factory/sandboxes";
import { createRemoteJWKSet } from "jose";
import { createApi } from "./app";
import { OidcLogin } from "./login";
import { CompositeAuthenticator, OidcAuthenticator, SessionManager, type Authenticator } from "./auth";
import { bootstrapLocalOwner, LOCAL_AGENT_SUBJECT, LocalBrowserEntry, LocalOwnerAuthenticator } from "./local";

const env = process.env;
// The API legitimately holds DB/OIDC/webhook secrets, so only MODEL-provider credentials are refused here.
assertEnvAllowed(Object.fromEntries(Object.entries(env).filter(([k]) => /^(ANTHROPIC|OPENAI|GOOGLE_API|GEMINI|MISTRAL|COHERE)_/i.test(k))));
const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`missing required environment variable ${k}`); return v; };

const sql = connect(need("DATABASE_URL"));
// Dispatch local mode (launcher-managed, loopback only): a per-install owner token replaces the OIDC provider; the whole RBAC/approval model still applies.
const localTokenFile = env.DISPATCH_LOCAL_TOKEN_FILE;
if (localTokenFile && (env.HOST ?? "127.0.0.1") !== "127.0.0.1") throw new Error("Dispatch local mode requires HOST=127.0.0.1");
// Approval records are written only through this connection (factory_approval, migration 0028). Required for multi-user
// deployments. Local mode is one owner on loopback, so it shares the main connection there (stated in evidence/MEM-05).
const approvalUrl = env.DATABASE_APPROVAL_URL;
if (!approvalUrl && !localTokenFile) throw new Error("missing required environment variable DATABASE_APPROVAL_URL (multi-user deployments need the approval role)");
const approvalSql = approvalUrl ? connect(approvalUrl) : undefined;
const auths: Authenticator[] = localTokenFile ? [LocalOwnerAuthenticator.fromFile(localTokenFile)] : [new OidcAuthenticator({ issuer: need("OIDC_ISSUER"), audience: need("OIDC_AUDIENCE"), ...(env.OIDC_JWKS_URI ? { jwksUri: env.OIDC_JWKS_URI } : {}) })];
if (localTokenFile && env.DISPATCH_LOCAL_AGENT_TOKEN_FILE) auths.push(LocalOwnerAuthenticator.fromFile(env.DISPATCH_LOCAL_AGENT_TOKEN_FILE, LOCAL_AGENT_SUBJECT));
let local: { entry: LocalBrowserEntry } | undefined;
if (localTokenFile) {
  await bootstrapLocalOwner(sql);
  const sm = new SessionManager(env.DISPATCH_SESSION_SECRET_FILE ? readFileSync(env.DISPATCH_SESSION_SECRET_FILE, "utf8").trim() : need("SESSION_SECRET"));
  auths.push(sm);
  local = { entry: new LocalBrowserEntry(sm, need("DISPATCH_DASHBOARD_URL")) };
}
// Interactive dashboard login: server-side sessions replace the stateless HMAC cookie when the client registration is configured.
let login: OidcLogin | undefined;
if (env.OIDC_CLIENT_ID) {
  const issuer = need("OIDC_ISSUER");
  // Login runs on its own database role (factory_login, migration 0027): it can create sessions only through create_auth_session.
  const loginSql = connect(need("DATABASE_LOGIN_URL"));
  login = new OidcLogin(loginSql, {
    issuer, clientId: env.OIDC_CLIENT_ID, ...(env.OIDC_CLIENT_SECRET ? { clientSecret: env.OIDC_CLIENT_SECRET } : {}),
    redirectUri: need("OIDC_REDIRECT_URI"), authorizationEndpoint: need("OIDC_AUTHORIZATION_ENDPOINT"), tokenEndpoint: need("OIDC_TOKEN_ENDPOINT"),
    keys: createRemoteJWKSet(new URL(env.OIDC_JWKS_URI ?? `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`)),
  });
  auths.push(login);
} else if (env.SESSION_SECRET && !localTokenFile) auths.push(new SessionManager(env.SESSION_SECRET));
const api = createApi({
  sql, ...(approvalSql ? { approvalSql } : {}), authenticator: new CompositeAuthenticator(auths), ...(login ? { login } : {}), ...(local ? { local } : {}),
  allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
  ...(env.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET } : {}),
  log: (l) => console.error(JSON.stringify(l)),
});
const server = Bun.serve({ port: Number(env.PORT ?? 8787), hostname: env.HOST ?? "127.0.0.1", fetch: api, idleTimeout: 60 });
console.log(`factory api listening on ${server.hostname}:${server.port}`);
