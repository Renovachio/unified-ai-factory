# ORC-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** 2b119831235afb148940d0f5a6762881fda785bf (branch dev/orc-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44427929948
- **Test totals:**  593 pass  0 fail 
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
- `apps/runner/src/index.ts`
- `bun.lock`
- `packages/domain/src/guards.test.ts`
- `packages/domain/src/guards.ts`
- `packages/orchestrator/package.json`
- `packages/orchestrator/src/artifacts.ts`
- `packages/orchestrator/src/executor.ts`
- `packages/orchestrator/src/index.ts`
- `packages/orchestrator/src/mock-ports.ts`
- `packages/orchestrator/src/orchestrator.ts`
- `packages/orchestrator/src/pipeline.ts`
- `packages/orchestrator/src/ports.ts`
- `packages/orchestrator/tests/orchestrator.test.ts`
- `packages/orchestrator/tsconfig.json`
- `packages/scheduler/src/index.ts`

## Notes
- `@factory/orchestrator` (new package; architecture lists no orchestrator folder — noted as a small deviation): `Orchestrator.tick(jobId)` does ONE unit of progress and is safe to repeat, race and replay. All progress is durable in Postgres: tasks (scheduler), content-addressed artifacts (`FileArtifactStore`, digest computed server-side, integrity re-verified on read), gate/review/policy evidence rows, `job_transitions`, events, outbox, audit. Side effects behind idempotent ports (`ScmPort`, `GatePort`, `ReviewPort`, `PolicyPort`); evidence writes are committed in the SAME transaction as the state transition (`transitionJob` guard hook) and domain guards are evaluated from durable rows.
- Pipeline (`pipeline.ts`, declarative): INTAKE(intake) -> SPECIFYING(analyst, architect, spec) -> READY -> PROVISIONING -> BUILDING(builder, tester; per-round artifacts) -> GATING -> REVIEWING -> PREMERGE -> AWAITING_HUMAN (pilot: every merge manual; the orchestrator never merges). Gate failure / requested changes -> REWORK -> new round and new candidate SHA; budget exhaustion escalates to a human; task-budget exhaustion fails the job and revokes leases; FAILED/QUARANTINED are recovery-only; cancel revokes leases first and is idempotent.
- `agentTaskExecutor`: runner executor that runs an `AgentRuntimeAdapter`, validates and stores output as an artifact, and succeeds only once the artifact is durably recorded.
- **Fault-injection proof**: the clean run exposes the fault points (before/after every transition, after each port call, after enqueue); the test then crashes (and "restarts" with a fresh orchestrator) at the FIRST and LAST occurrence of EVERY point and asserts the identical legal 9-step history, exactly 6 tasks (all succeeded once), 6 artifacts, 1 gate row, 1 review row, 1 policy decision, contiguous event sequences and exactly 9 transition events/audit rows.
- Also tested: worker dies mid-task (lease expiry -> attempt 2 by another worker; the dead worker's late completion is rejected), concurrent orchestrators+workers on one job, rework loops (per-round artifacts, per-SHA evidence), reviewer-requested changes re-run gates and reviews on the new SHA, invalid transitions rejected at orchestrator/transitionJob/raw-SQL layers, pause/resume.
- Changes to earlier tasks made here: `enqueueTask` is now idempotent per (job, stage, role) irrespective of the attempt counter (the scheduler bumps attempts in place); domain rework-budget guard now bounds leaving REWORK for another build round (entering REWORK is always allowed so a human can be reached) with updated tests; runner gained `leaseTtlMs`.
- Scope limit: gates, reviewers, risk/policy and real SCM are mock ports here; they are implemented by GAT-001, REV-001, POL-001, BLD-001/SCM-001/MRJ-001.
- Next: API-001.
