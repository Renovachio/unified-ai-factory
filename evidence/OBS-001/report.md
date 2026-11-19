# OBS-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** 5a2324ddadc4a8b7f74caafcc64713782ef1c2a7 (branch dev/obs-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44442328484
- **Test totals:**  777 pass  0 fail 
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
- `apps/api/src/app.ts`
- `apps/api/src/auth.ts`
- `apps/api/src/index.ts`
- `apps/api/src/operator.ts`
- `apps/api/src/readmodels.ts`
- `apps/web/app/actions.ts`
- `apps/web/app/audit/page.tsx`
- `apps/web/app/globals.css`
- `apps/web/app/inbox/page.tsx`
- `apps/web/app/jobs/[id]/page.tsx`
- `apps/web/app/jobs/page.tsx`
- `apps/web/app/layout.tsx`
- `apps/web/app/page.tsx`
- `apps/web/app/policies/page.tsx`
- `apps/web/app/usage/page.tsx`
- `apps/web/app/workers/page.tsx`
- `apps/web/lib/api.ts`
- `apps/web/lib/view.tsx`
- `apps/web/package.json`
- `apps/web/tests/render.test.tsx`
- `apps/web/tsconfig.json`
- `apps/web/tsconfig.tsbuildinfo`
- `packages/agents/tests/merge-fixture.ts`
- `packages/agents/tests/merge.test.ts`
- `packages/agents/tests/obs.test.ts`
- `packages/telemetry/src/index.ts`
- `packages/telemetry/src/logger.ts`
- `packages/telemetry/src/telemetry.test.ts`
- `packages/telemetry/src/trace.ts`

## Notes
- **Read models** (`apps/api/src/readmodels.ts`): `GET /jobs/:id/timeline` reconstructs the COMPLETE history from 13 durable sources (transitions, events, tasks, agent runs, artifacts, candidates, gate/review/policy evidence, approvals, PRs, merge intents, audit), chronologically ordered (causal tie-breaks by event sequence / transition version), cursor-paged; redacted and stripped of billing-style keys on the way out; artifact storage paths are never exposed (digests only). Test: a fully merged job -> the state path equals the DB transitions exactly, every source is present with row counts EQUAL to the database, paging reproduces the single-page list, a raw secret planted in an audit row never leaves the API. Also `GET /jobs/:id/artifacts` (paged, kind filter), `GET /jobs/:id/policy` (risk, required reviewers + routing reasons, gates, merge eligibility + reasons), `GET /audit` (admin/security officer, org-scoped, paged), `GET /workers`, `GET /session`.
- **Usage & capacity** (`GET /usage`, operator/admin/security officer): job counts by state, per runtime/model/auth-mode/usage-source runs and compute seconds, optional token COUNTS for capacity analysis, per-role averages, pressure signals (rate-limit events, expired leases, invalid review reports, rework, gate failures), worker/lease capacity and host CPU/RAM. **No monetary, price, cost or per-token-cost fields exist**: asserted by scanning every response key (usage, timeline, workers) against a billing-term pattern; labels are limited to subscription/local modes.
- **Operator actions**: pause/resume (stops NEW claims, running leases finish at their safe boundary; audited; idempotent), quarantine job (capabilities revoked FIRST, then QUARANTINED; only legal where the state machine allows it — AWAITING_HUMAN has no such edge, tested), release (security officer/admin only, only to FAILED/CANCELLED), worker drain/quarantine/activate (quarantine expires held leases so the sweeper requeues with a NEW fencing token and the worker is fenced out; re-activating a quarantined worker needs security officer/admin). New RBAC permissions: `job:pause`, `job:quarantine`, `worker:manage`, `usage:read`.
- **Redacted logs and traces** (`@factory/telemetry`): `createLogger` (JSON lines, redacted, billing-style keys dropped) and `Tracer` (OpenTelemetry-shaped trace/span ids with parentage; attributes redacted and billing keys stripped at span END so nothing sensitive reaches an exporter). Real OpenTelemetry SDK/exporters are NOT added (dependency/licence review pending) — this is a compatible minimal tracer.
- **Dashboard** (`apps/web`, Next.js, server components): Overview, Jobs, Job detail (policy + full timeline), Inbox (approval forms bound to the exact head/base/policy digest/version via a server action that calls the decisions API with the viewer's session cookie + CSRF token), Workers, Policies, Usage & capacity, Audit. Presentational components are unit-tested: untrusted request text and event data are escaped and labelled "untrusted input", only http(s) URLs become links, tables have captions/scoped headers, errors use `role=alert`, usage/policy views contain no money terms. `next build` passes; a live `next start` smoke shows /policies rendering and /usage degrading to an explicit "API unreachable" alert.
- Also: test fixture refactor (`merge-fixture.ts`) so full-pipeline tests share one setup.
- Limits / operator actions: (1) the dashboard cannot log anyone in yet — the OIDC login/callback that issues the session cookie needs an operator-provided IdP (issuer, audience, client); the API verifies bearer tokens and session cookies but the redirect flow is not implemented. (2) No browser-level (e2e/visual/a11y-tool) test was run; accessibility is covered structurally only. (3) Overview/usage use a 7-day default window. (4) Post-merge CI watching is not implemented (only `recordPostmerge`). (5) Pause does not interrupt a running lease.
- Next: AGT-002 / AGT-003 (subscription CLI adapters; terms-gated), then CLD-001, EVAL-001, AUTO-001.
