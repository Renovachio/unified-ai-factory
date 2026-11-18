# SCH-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-18
- **Candidate SHA:** 6c48f56f42254b9796a709eb740250cecd6a75a7 (branch dev/sch-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44423391235
- **Test totals:** 
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
- `bun.lock`
- `packages/scheduler/package.json`
- `packages/scheduler/src/index.ts`
- `packages/scheduler/tests/scheduler.test.ts`
- `packages/scheduler/tsconfig.json`

## Notes
- `@factory/scheduler`: DB-backed claim queue (`claimTask`: FOR UPDATE SKIP LOCKED, priority order, worker capacity 1, one active builder per job, skips paused/terminal jobs and non-active workers), lease TTL 45s / heartbeat 10s, strictly monotonic fencing tokens from `fencing_token_seq`, `expireLeases` (requeue with backoff and attempt+1, or fail when the 3-attempt budget is spent), `heartbeatTask` / `reportTaskEvent` / `completeTask` guarded by a fence check (owner + token + unexpired), `revokeJobLeases` (idempotent cancellation).
- Rejected stale writers are audited (`fencing.rejected`) and never mutate task state or the event log.
- Tests: 20 concurrent workers vs 5 tasks -> exactly 5 leases with unique tokens; stale worker rejected on heartbeat, event report and completion after a new attempt; expired lease rejected even before reclaim; expiry detected within one TTL (<90s SLO); retry budget exhaustion fails the task; cancellation fences out the worker.
- Not in scope: process supervision and sandboxing (RUN-001). Next: RUN-001.
