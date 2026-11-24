# API-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** d6bf1f149984d7961d4ce65f29a3348143911bfd (branch dev/api-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44429033785
- **Test totals:**  620 pass  0 fail 
- **Accepted by:** operator, via instruction to continue following the plan to completion (2026-11-18); no separate human code review has occurred.

## Local commands (clean frozen install)
| Command | Exit |
|---|---|
| `bun install --frozen-lockfile` | 0 |
| `python3 scripts/validate_package.py` | 0 |
| `bun run license` | 0 |
| `bun run lint` | 0 |
| `bun run typecheck` | 0 |
| `bun test` | 0 |
| `bun run build` | 0 |

## Files changed in this task
- `CONTRACTS/openapi.yaml`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/auth.ts`
- `apps/api/src/body.ts`
- `apps/api/src/index.ts`
- `apps/api/src/jobs.ts`
- `apps/api/src/problem.ts`
- `apps/api/src/ratelimit.ts`
- `apps/api/src/server.ts`
- `apps/api/tests/api.test.ts`
- `apps/api/tsconfig.json`
- `bun.lock`
- `licenses/allowlist.yaml`

## Notes
- `@factory/api` (apps/api): framework-free `createApi(config) => (Request) => Response` (mounted by `server.ts` with Bun.serve; tests call it directly). Routes: `POST/GET /api/v1/jobs`, `GET /jobs/:id` (ETag + If-None-Match 304), `GET /jobs/:id/events` (cursor), `GET /jobs/:id/events/stream` (SSE, Last-Event-ID resume), `POST /jobs/:id/cancel` (expectedVersion + Idempotency-Key), `GET /health/live|ready`, `POST /integrations/github/webhook` (HMAC, delivery dedupe). `CONTRACTS/openapi.yaml` expanded and checked by a test.
- Authentication: OIDC bearer verification (asymmetric algs only — `none`/HS*/alg-confusion rejected; issuer, audience, expiry; https issuer unless explicitly allowed) and HMAC-signed server-issued session cookies (HttpOnly/Secure/SameSite=Strict) with Origin allowlist + double-submit CSRF token for cookie-authenticated writes. A verified identity must map to an enabled local user (no implicit signup): unknown/disabled => 403.
- Authorization: deny-by-default role->permission matrix (viewer/editor/operator/approver/admin/security_officer), tested route-by-route for every role; tenant isolation via organisation scoping on every query (other tenants' jobs/repos/events/streams are 404, not 403).
- Idempotency: key row and job are created in ONE transaction, so 12 concurrent identical requests produce exactly one job and replay the stored 202; same key + different body = 409; keys are scoped per actor and route; duplicate `sourceId` per repository = 409.
- Limits and validation: strict JSON schema from `CONTRACTS/job-create.schema.json` (422 with error list), JSON content type (415), streaming body cap incl. no Content-Length (413), description cap, `limit` 1..100, cursor validation, per-actor token-bucket rate limit (429 + Retry-After). RFC 9457 Problem Details everywhere; unexpected errors are a generic 500 with a request id and the detail kept in server logs only. Requester-supplied text is returned marked `trust: "untrusted"`.
- `server.ts` refuses to start if model-provider credentials are in the environment (tested by spawning it).
- Not in this task: approval decisions endpoint (MRJ-001), resume/feedback endpoints, worker endpoints (claim/heartbeat over HTTP), OIDC login flow in the dashboard (OBS-001). Production OIDC/JWKS against a real IdP is unverified (tests use a local JWKS); needs an operator-provided issuer/audience.
- Dependency added: `jose` 6.2.18 (MIT) — approval label "PROPOSED by agent"; operator ratification pending.
- Next: INT-001.
