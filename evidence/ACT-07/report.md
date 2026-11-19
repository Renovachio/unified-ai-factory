# ACT-07 — Operational reliability (v2.1)

**Status: `in_progress` — audit done, gaps recorded; no new reliability work was performed for this work package.** Nothing below was run under real production conditions.

## What already exists (v2.0/v2.1) and is covered by tests
| Area | Where | Test evidence |
|---|---|---|
| Leases, fencing tokens, stale-worker rejection, heartbeat | `packages/scheduler` | `scheduler.test.ts`, `roles.test.ts` (real runner DB role) |
| Transactional outbox, redelivery, crash between commit and publish | `packages/db` | `events.test.ts` |
| Orchestrator restart/idempotent resume | `packages/orchestrator` | `orchestrator.test.ts` |
| Merge crash/reconciliation, post-merge recording | `packages/agents` merge | `merge.test.ts`, `auto-merge.test.ts` |
| Duplicate webhook delivery | `packages/scm` | `scm.test.ts` |
| Sandbox timeout/kill/containment, fail-closed self-test | `packages/sandboxes`, runner enrollment | `adversarial.test.ts`, `runner.test.ts` |
| Idempotent API writes | `apps/api` | `api.test.ts` |
| v2.2 registry: concurrent identical activations, revocation mid-run, stale CAS | `packages/skills` | `registry.test.ts` ("recovery and revocation mid-run") |

## Gaps (not done)
- No **post-merge CI watcher** (only `recordPostmerge`); no automatic **rebase** on base-branch movement.
- No **dead-letter** handling or alerting for poisoned outbox rows; no retention/backup/restore procedure or test; no database-restart fault-injection test.
- No **diagnostics bundle** command (redacted logs + versions + migration state); real OpenTelemetry export is not wired.
- No end-to-end **failure-injection suite** across processes (worker SIGKILL mid-gate, DB restart mid-activation, partitioned callbacks). Single-process crash tests exist; multi-process ones do not.
- Privileged components still run in one process unless the operator provisions per-component LOGIN roles (see ACT-05).

## Next
Implement the four gaps above in priority order: dead-letter + alert, diagnostics bundle, restart fault injection (Postgres + worker), CI watcher. Re-run this audit and flip to `verified` only with evidence from those runs.
