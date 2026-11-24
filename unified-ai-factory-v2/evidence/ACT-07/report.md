# ACT-07 — Operational reliability (v2.1)

**Status: `in_progress` — dead letter, diagnostics, post-merge watcher and a crash test added; remaining gaps below.** Nothing below was run under real production conditions.

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

## Added in this work package (tested locally; `packages/db/tests/reliability.test.ts`, `packages/scm/tests/postmerge.test.ts`)
- **Dead letter** (migration 0013): outbox rows stop retrying after `maxAttempts` (default 10), keep `last_error`, are listed by `listDeadLetters` and restored by `requeueDeadLetter`; other jobs are unaffected. Rollback returns dead rows to pending.
- **Diagnostics bundle** (`diagnosticsBundle`, `bun scripts/diagnostics.ts`): migration state, job/outbox/task/worker counts, alerts (dead letters, stale outbox, expired leases, pending/unknown migrations). Counts and ids only, redacted; a test asserts no request text appears.
- **Post-merge CI watcher** (`watchPostmerge`): reads the merge commit's CI status through an injected port and records the outcome once through the existing `recordPostmerge` (so failures trip the auto-merge breaker). Failure, timeout, unknown merge sha or an unreachable status API all fail closed; pending within the window waits.
- **Crash mid-delivery**: killing the consumer's DB backend mid-batch leaves all rows pending and redelivery completes (at-least-once, consumers dedupe by sequence).

## Remaining gaps (not done)
- The watcher has no GitHub adapter (the `CiStatusPort` is injected); nothing schedules it or the dead-letter alert; verified only with fakes, not live GitHub.
- No automatic **rebase** when the base branch moves; no backup/restore procedure or test; no real Postgres server restart or multi-process (worker SIGKILL mid-gate, network partition) injection - the crash test terminates a backend inside one process.
- Real OpenTelemetry export is not wired.
- Privileged components still run in one process unless the operator provisions per-component LOGIN roles (see ACT-05).
