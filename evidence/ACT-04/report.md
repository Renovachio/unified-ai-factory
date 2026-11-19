# ACT-04 — Dashboard authentication (v2.1)

**Status: `in_progress` — server-side flow verified against a local fake issuer; NOT verified against a real OIDC provider or in a real browser.**
Host: macOS 27.2.1, Bun 1.4.4, Postgres 17 (temp cluster).

## Baseline
v2.0 had bearer-token verification (`OidcAuthenticator`), a stateless HMAC cookie (`SessionManager`: no server-side revocation, no logout, no rotation), RBAC matrix + org scoping, CSRF double-submit + Origin check, approval binding to actor/SHA/policy (migration 0007). Missing: login/callback/logout flow and session lifecycle.

## Implemented
- Migration `0009_auth_sessions` (up/down) + Drizzle schema: `auth_login_transactions`, `auth_sessions` (ids and state stored only as SHA-256 hashes).
- `apps/api/src/login.ts` `OidcLogin`: authorization-code + **PKCE S256**, single-use `state`, `nonce`, browser-binding cookie (login-CSRF / callback injection), ID-token verification (signature via JWKS, asymmetric algs only, issuer, audience, exp, nonce, azp), no implicit user provisioning, disabled users refused, same-site-only `return_to`.
- Sessions: opaque 256-bit ids, `HttpOnly; SameSite=Lax; Path=/` (+ `Secure` and `__Host-` prefix in production; production config refuses non-https endpoints), 8 h absolute expiry, 30 min idle timeout, rotation every 15 min with a 20 s grace for in-flight requests (**rotation keeps the original absolute expiry**), logout revokes the session and its rotation chain, `revokeAllForUser`, disabled-user revocation, role re-read from the database on every request.
- Routes `GET /api/v1/auth/login`, `GET /api/v1/auth/callback`, `POST /api/v1/auth/logout` (CSRF-protected). Wired in `server.ts` when `OIDC_CLIENT_ID` etc. are set (legacy stateless cookie otherwise).
- Dashboard: `/login` page, **Sign out** server action (revokes server-side, drops cookies).
- Auth events audited (`auth.login` allowed/denied, `auth.logout`).

## Real defects found by the new tests and fixed
1. Session rotation silently extended the absolute lifetime indefinitely.
2. Auto-merge routes revealed configuration state (503) to unauthenticated callers before authenticating (now 401 first).
3. (RT-05, separate package) audit events leaked short file contents — fixed in ACT-01.

## Tests: `apps/api/tests/login.test.ts` (19) — all pass; `bun test apps` 74 pass; lint/typecheck clean; `next build` succeeds
PKCE mismatch, state replay/tamper, login CSRF (missing/foreign binding), nonce missing/wrong, wrong audience/issuer, expired token, HS256 token, foreign signing key, issuer error param, unknown/disabled accounts, open-redirect corpus, forged/tampered/malformed cookies, session fixation, role changes effective on live sessions, CSRF (missing/foreign Origin/wrong token), logout replay, idle/absolute expiry, rotation grace, revoke-all, disabled user, unauthenticated access to every privileged route incl. the event stream, cross-organisation isolation.

## Acceptance criteria
- [~] Login/logout/expiry work "through the real UI" — **not demonstrated**: tested at the HTTP level with a fake issuer; no browser run.
- [x] Unauthenticated/unauthorised requests receive 401/403/404 as appropriate.
- [x] Cookie attributes HttpOnly/SameSite/Secure(prod)/__Host- verified in tests.
- [x] Approvals require the correct role and are audited (existing 0007/API tests + new role tests).
- [ ] Browser-level E2E — **not done**.

## Blockers / open risks
- Needs real OIDC provider details (issuer, client id/secret, endpoints, redirect URI). Owner: operator.
- Anonymous endpoints (`/auth/login`, `/auth/callback`) are not rate limited per IP.
- `SameSite=Lax` chosen so links into the dashboard work; set `Strict` via config if the deployment allows.
