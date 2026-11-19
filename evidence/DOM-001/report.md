# DOM-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-18
- **Candidate SHA:** 3c002680a5ad819332f773ebb8337936a2bbfce0 (branch dev/dom-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44421470351
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
- `packages/domain/src/binding.ts`
- `packages/domain/src/guards.test.ts`
- `packages/domain/src/guards.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/risk.ts`
- `packages/domain/src/states.ts`
- `packages/domain/src/transitions.test.ts`

## Notes
- `@factory/domain`: 20-state machine with the blueprint §5 matrix, risk enums with deterministic-floor escalation, evidence binding (8-field approval key) with stale detection, transition guards (candidate SHA, fresh gate, every required reviewer on exact SHA, fresh human approval before MERGING, rework budget, pause invariant) and head-SHA-change invalidation.
- Tests: all 400 state pairs table-driven against an independent copy of the spec; each of the 8 binding fields individually invalidates an approval; head change returns GATING and invalidates gate/reviews/approval.
- No network calls in the package. Next: DB-001.
