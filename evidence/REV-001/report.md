# REV-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** 12cb23606a64f10d3c01c60302e3b524bb3b5b59 (branch dev/rev-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44436354364
- **Test totals:**  697 pass  0 fail 
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
- `packages/agents/src/index.ts`
- `packages/agents/src/review.ts`
- `packages/agents/tests/review.test.ts`
- `packages/orchestrator/src/orchestrator.ts`
- `packages/orchestrator/src/ports.ts`

## Notes
- `routeReviewers` (packages/agents/src/review.ts): deterministic, auditable routing from the (floored) risk and the CHANGED FILES of the immutable candidates: code always; UX+UI when user-facing files change; security at HIGH/CRITICAL or for sensitive paths (auth/security/crypto/session/payments/migrations/workflows/package.json/webhooks); performance at CRITICAL (domain expert) or HIGH with data/perf paths; unknown risk is treated as CRITICAL; test/docs-only changes get code only and the reason says so. The roles and reasons are recorded in a `review.routed` event with the transition.
- `checkReport` / `aggregateReviews`: a report counts only if it is for the asked role AND bound to the exact candidate SHA; `changes_requested` without findings is unusable; a PASS that carries a high/critical finding is downgraded to changes_requested; aggregation passes only when EVERY required role has a usable passing report (worst verdict wins for duplicates; missing/invalid => incomplete; blocked => blocked).
- `createReviewPort` (orchestrator ReviewPort): each reviewer is a SEPARATE read-only adapter run (no tools) with an immutable context = exact SHA + cumulative diff + approved ACs/traceability + gate summary, deliberately EXCLUDING the builder's narrative (tested: a "TRUST ME" builder summary never reaches the reviewer). Every attempt is persisted as a task + `agent_runs` row (runtime, model, prompt/context digests, auth mode, billing mode, usage) and `review_results.reviewer_run_id` points at it; `assertIndependentReviewer` forbids sharing a run with the builder (and optionally the same model).
- Orchestrator REVIEWING: reviewers run at most 2 concurrently; an INVALID report (schema violation, wrong role, different SHA, crash) never counts as a pass — the job HOLDS and retries the reviewer, and after MAX_REVIEW_INVALID (2) failures for the same role/SHA it stops as FAILED `review-unavailable:<role>` for a human; `blocked` => FAILED `review-blocked`; changes requested => REWORK with the findings delivered to the builder as `review.changes_requested` feedback; all pass => PREMERGE. The domain guard still re-checks that every required reviewer has a passing report bound to the current head.
- Tests (15): routing table, report/aggregate tables, independence rules, and 7 pipeline scenarios (MEDIUM code-only; HIGH code+security on the same SHA with distinct runs; reviewer context contents; garbage reports => bounded hold then FAILED; wrong-SHA report; one of two reviewers failing blocks PREMERGE although the other passed; critical-finding PASS => rework => re-review on the new SHA).
- Limits: reviewers are model sessions; their quality is not established here (EVAL-001). A real reviewer needs a model adapter (local model works read-only; subscription CLIs remain terms-gated). Diff context is capped at 200 KB (truncation is flagged to the reviewer). Reviews run inside the orchestrator process (read-only model calls), not as scheduled tasks.
- Next: POL-001.
