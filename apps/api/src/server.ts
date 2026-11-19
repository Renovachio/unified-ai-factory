// Production entrypoint. Refuses to start with model credentials in the environment (SECURITY.md).
import { connect } from "@factory/db";
import { assertEnvAllowed } from "@factory/sandboxes";
import { createRemoteJWKSet } from "jose";
import { createApi } from "./app";
import { OidcLogin } from "./login";
import { CompositeAuthenticator, OidcAuthenticator, SessionManager, type Authenticator } from "./auth";

const env = process.env;
// The API legitimately holds DB/OIDC/webhook secrets, so only MODEL-provider credentials are refused here.
assertEnvAllowed(Object.fromEntries(Object.entries(env).filter(([k]) => /^(ANTHROPIC|OPENAI|GOOGLE_API|GEMINI|MISTRAL|COHERE)_/i.test(k))));
const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`missing required environment variable ${k}`); return v; };

const sql = connect(need("DATABASE_URL"));
const auths: Authenticator[] = [new OidcAuthenticator({ issuer: need("OIDC_ISSUER"), audience: need("OIDC_AUDIENCE"), ...(env.OIDC_JWKS_URI ? { jwksUri: env.OIDC_JWKS_URI } : {}) })];
// Interactive dashboard login: server-side sessions replace the stateless HMAC cookie when the client registration is configured.
let login: OidcLogin | undefined;
if (env.OIDC_CLIENT_ID) {
  const issuer = need("OIDC_ISSUER");
  login = new OidcLogin(sql, {
    issuer, clientId: env.OIDC_CLIENT_ID, ...(env.OIDC_CLIENT_SECRET ? { clientSecret: env.OIDC_CLIENT_SECRET } : {}),
    redirectUri: need("OIDC_REDIRECT_URI"), authorizationEndpoint: need("OIDC_AUTHORIZATION_ENDPOINT"), tokenEndpoint: need("OIDC_TOKEN_ENDPOINT"),
    keys: createRemoteJWKSet(new URL(env.OIDC_JWKS_URI ?? `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`)),
  });
  auths.push(login);
} else if (env.SESSION_SECRET) auths.push(new SessionManager(env.SESSION_SECRET));
const api = createApi({
  sql, authenticator: new CompositeAuthenticator(auths), ...(login ? { login } : {}),
  allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
  ...(env.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET } : {}),
  log: (l) => console.error(JSON.stringify(l)),
});
const server = Bun.serve({ port: Number(env.PORT ?? 8787), hostname: env.HOST ?? "127.0.0.1", fetch: api, idleTimeout: 60 });
console.log(`factory api listening on ${server.hostname}:${server.port}`);
