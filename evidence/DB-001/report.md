# DB-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-18
- **Candidate SHA:** 2beaffd74027f443c2faef64e84b3380c9957624 (branch dev/db-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44422216828
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
- `.github/workflows/ci.yml`
- `bun.lock`
- `bunfig.toml`
- `eslint.config.mjs`
- `licenses/allowlist.yaml`
- `migrations/0001_core.down.sql`
- `migrations/0001_core.up.sql`
- `migrations/0002_idempotency.down.sql`
- `migrations/0002_idempotency.up.sql`
- `packages/db/package.json`
- `packages/db/src/client.ts`
- `packages/db/src/ids.ts`
- `packages/db/src/index.ts`
- `packages/db/src/migrate.ts`
- `packages/db/src/schema.ts`
- `packages/db/src/testing.ts`
- `packages/db/tests/db.test.ts`
- `packages/db/tests/setup-db.ts`
- `packages/db/tsconfig.json`

## Notes
- `@factory/db`: Drizzle schema (`src/schema.ts`), reversible SQL migrations (`migrations/0001_core`, `0002_idempotency`, each with `.down.sql`), transactional migrator with advisory lock + checksum tamper detection + atomic rollback.
- DB-level guards: `allowed_transitions` seeded from the domain matrix (test asserts parity with `@factory/domain`), trigger rejecting illegal state transitions / version skips / identity mutation; append-only triggers on events, audit_entries, approvals, job_transitions, gate_results, review_results; artifact content immutability; CHECKs for SHAs, digests, roles, billing modes (no billing/price columns exist — tested), `policy_decisions` cannot mark HIGH/CRITICAL eligible.
- Uniqueness per blueprint §9 tested incl. 12-way concurrent duplicate insert (exactly one wins) and rollback atomicity.
- Mapping of spec nouns: "attempts" = `tasks.attempt` + `agent_runs`; "leases" = `tasks.lease_owner/lease_expiry/fencing_token` with global `fencing_token_seq`.
- Tests need Postgres: CI uses a postgres:17 service (DATABASE_URL); locally the bun test preload starts a throwaway cluster (needs Postgres binaries) and removes it on exit. Tests fail (not skip) if no database is available.
- Rollback note: 0001 down drops all data; use only in disposable environments. Never roll back destructively in production (blueprint §18).
- Drift test: Drizzle schema vs information_schema columns/nullability.
- Next: API-001 / EVT-001 / SCH-001 (all depend on DB-001).
- ESLint: `no-non-null-assertion` relaxed for test files only.
