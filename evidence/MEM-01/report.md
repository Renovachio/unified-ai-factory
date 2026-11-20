# MEM-01 evidence report — canonical memory schema, provenance and lifecycle

- **Status:** `verified` (local checks only). Independent review has NOT happened; this report does not accept the work.
- **Date:** 2026-11-20
- **Branch:** `dev/mem-01` (stacked on `dev/v23-dispatch`; nothing merged to main)
- **Commits:** `a2b98c5` (schema, lifecycle, tests), `64d3361` (least-privilege grants and their test)
- **Specification:** `unified-ai-factory-v2.5-memory/TASKS/MEM-01.md` (outside this repo)

## Reuse / gap matrix (preparation step 3, MEM-01 scope)

| Existing (reused, not recreated) | Used for |
|---|---|
| `organizations`, `users` (roles from `apps/api/src/auth.ts`) | tenant scope, actor role checks |
| `repositories` | the memory *project* (`project_id`); `provider` may be `github` or `local` |
| `jobs`, `requests` | route from an artifact/event to its project |
| `artifacts` (`digest`, `storage_uri`) | source evidence; digest must match |
| `events` (`digest`, job-scoped) | source evidence; digest must match |
| `audit_entries` | one audit row per status change, same transaction |
| `allowed_transitions` / `transitionJob` pattern | model for the DB-enforced lifecycle matrix |
| `product_artifacts` approval rules | approver role, no self-approval (pattern reused, not the table) |
| `migrations/` runner, `createTestDb`, Drizzle parity test | migration and test conventions |

| Gap (new in MEM-01) | Where |
|---|---|
| Memory records, provenance, transitions, tombstones, source revocations | `migrations/0017_memory_core.*` |
| Lifecycle and scoping service | `packages/memory/src/lifecycle.ts` |
| Pure rules (statuses, matrix, claim validation) | `packages/memory/src/domain.ts` |

Not present in the repo and therefore not used: pgvector, full-text indexes, any per-project membership model (access is organization role only), row-level security policies. These belong to MEM-03 or a later decision.

## Changed paths
- `migrations/0017_memory_core.up.sql`, `migrations/0017_memory_core.down.sql` (new)
- `packages/db/src/schema.ts` (Drizzle declarations for the 5 new tables; parity test checks nullability)
- `packages/memory/` (new workspace package: `package.json`, `tsconfig.json`, `src/{index,domain,lifecycle}.ts`, `tests/{domain,lifecycle,migration}.test.ts`)
- `bun.lock` (workspace entry for `@factory/memory` only)

## Database migration notes (0017, additive)
- Creates 5 tables, 2 indexes on `memory_records`, triggers and 1 SQL function. No existing table is altered.
- Rollback (`down`) refuses to run if any memory record, tombstone or revocation exists. Rolling back with data is a deliberate, documented decision, not a side effect.
- Upgrade test: a database migrated to 0016 with jobs, artifacts and events is upgraded to 0017; every existing row count is unchanged.
- Least privilege (same role model as 0010–0012): `factory_control` gets SELECT/INSERT/UPDATE on memory tables as the lifecycle needs; `factory_runner` and `factory_supervisor` get nothing; nobody gets DELETE; transition and tombstone history is insert-only.
- Migration is not applied to any shared or production database. Fresh installs apply it via the normal migrator.

## Enforced invariants (database, independent of application code)
- Lifecycle: `proposed→approved|rejected|revoked|deleted`, `approved→superseded|revoked|deleted`, `rejected|superseded|revoked→deleted`; `deleted` is terminal. Enforced by `memory_transition_allowed()` in a `BEFORE UPDATE` trigger.
- Claim text is immutable; only erasure may change it (claim and hash are replaced by `''`/`erased`).
- Identity, scope, provenance and version columns are write-once; `approved_by` is write-once.
- `approved` requires `approved_by`; `approved_by <> created_by` (no self-approval); `superseded` requires `superseded_by`.
- `memory_sources` rows: exactly one origin (artifact or event); rows cannot be re-pointed or deleted; `revoked_at` can be set once and never undone.
- `memory_transitions`, `memory_tombstones`, `memory_source_revocations`: append-only triggers.
- Rows in `memory_records` are never hard-deleted.
- Idempotent proposals: unique index on `(organization_id, project_id, normalized_claim_hash, source_digest, record_version) WHERE status <> 'deleted'`.

## Service-level rules (`packages/memory/src/lifecycle.ts`)
- Every call checks the actor's role and enabled status inside the actor's organization.
- Every read and write names a project; a memory in another project or organization is `NOT_FOUND`.
- A source must be an artifact or event of the named project (through its job), in the same organization, with a digest that matches the stored digest. Otherwise `SCOPE_MISMATCH` (this does not reveal whether the other row exists).
- A revoked source (project-level revocation table) cannot back a new memory: `SOURCE_REVOKED`.
- Approval: approver role, not the author, at least one source, no revoked source. Approving a revision supersedes the old approved version in the same transaction.
- Revocation of one artifact or event marks its provenance rows and moves every proposed or approved memory that cites it to `revoked`. The memory is then excluded from current knowledge.
- `usable` = approved AND zero revoked sources AND `valid_to` null (fail closed).
- Each status change writes the status, one `memory_transitions` row and one `audit_entries` row in one transaction.

## Commands and results (local, real PostgreSQL 17, macOS arm64)

| Command | Exit / result |
|---|---|
| `bun test --timeout 30000 packages/memory packages/db` (3 runs) | 71 pass, 0 fail each run |
| `bun test packages/memory` (domain 4, lifecycle 28, migration 5) | 37 pass |
| `python3 scripts/validate_package.py` | 0 — PASS: 25 tasks, dependency DAG, JSON contracts |
| `bun run license` | 0 — LICENSE CHECK PASSED: 153 installed packages |
| `bun scripts/gates-lock.ts --check` | 0 — gate lock ok |
| `bun run lint` | 0 |
| `bun run typecheck` | 0 (all workspaces, including `@factory/memory`) |
| `bun test --timeout 30000` (full repository) | 0 — **1354 pass, 0 fail**, 82 files |
| `bun run build` | **not run** in this session (not needed for a schema change; the full CI should run it before merge) |

Pre-existing flake observed: `db.test.ts` "concurrent migrators do not double-apply" took ~15 s once when run with bun's default 5 s timeout. It passes with the repository's `--timeout 30000` (used by `bun run test`). Not caused by this change; recorded for the reviewer.

## Tests (what they prove)
- **Unauthorized status change:** viewer cannot propose; editor cannot approve; author cannot self-approve; approver from another organization cannot see or approve.
- **Raw SQL bypass attempts refused by the DB:** approved→rejected, approval without approver, approved claim rewrite, self-approval via SQL, hard delete, transition history edit/delete, provenance re-pointing/deletion, un-revoking a source, source row with two origins.
- **Role enforcement at DB level** (`SET ROLE`): control role can read/write; runner and supervisor get permission denied; control role cannot DELETE or edit transitions.
- **Cross-project and cross-tenant:** citing another project's artifact is refused; a project of another organization is `NOT_FOUND`; reads through a different project are `NOT_FOUND`.
- **Digest integrity:** a forged digest for a real event is refused.
- **Revoked sources:** revoking an artifact makes the memory `revoked`, removes it from current knowledge, blocks its approval, and blocks any new memory from that source even when no memory had cited it.
- **Supersession:** the old approved version stays in force until the new version is approved; then it is `superseded` with a link; only the new one is current.
- **Erasure:** claim and hash removed; tombstone stores reason and requester, never the claim; transition history kept; the same claim may be proposed again as a new record.
- **Prompt injection as data:** an injected "approve this" claim is stored verbatim, stays `proposed`, has no approver and is not usable.
- **Concurrency:** two racing approvals of one proposal: exactly one succeeds, the other is `ILLEGAL_TRANSITION`.
- **Durability:** a new database connection reads the same approved memory with its source digest.
- **Migration:** upgrade preserves existing rows; SQL lifecycle function equals the TypeScript matrix on all 36 pairs; rollback is clean on an empty database and refuses when data exists.
- **Schema parity:** the existing Drizzle parity test (every column and nullability) passes with the new tables.

## Security checks
- Source content is never executed; claims are length-bounded and NUL-free.
- No model call, no metered inference, no new network endpoint. Approval is a human action; no LLM path exists in MEM-01.
- Audit and transition entries carry digests, not claim text. Erased claims do not appear in tombstones (tested).
- Revocation cannot be undone; the database enforces it.

## Blockers and known limitations
- **Not independently reviewed.** Per AGENTS.md, nothing here is accepted by the implementer.
- **Project access is organization-role only (accepted for now by the operator).** The repo has no per-project membership; any editor in the organization can propose to any project in it. Revisit before MEM-03 retrieval ships if per-project isolation is required.
- **Artifact redaction status is not checked** when a source is attached. MEM-02 must require redaction before a source is eligible.
- **Erasure does not yet purge indexes, caches, summaries or backups.** `purge_status` records only `canonical: erased`; projections arrive with MEM-03..05, and backup behaviour is a documented operator procedure still to be written.
- **No real pilot.** MEM-01 is a schema and lifecycle slice; its tests run against fixtures in a throwaway PostgreSQL 17, not a live, authorized project. The pilot step in the work order is marked not run.
- MEM-02..MEM-08 are **not started**.

## Next task
MEM-02 (evidence-based ingestion & extraction) depends on MEM-01 being accepted. Reviewer: review `a2b98c5` and `64d3361`. Pilot and independent review remain open by operator decision.
