# MEM-03 evidence report — hybrid search and scoped retrieval (lexical only)

- **Status:** `verified` (local checks only). Independent review NOT done; pilot NOT run. Not accepted.
- **Date:** 2026-11-20
- **Branch:** `dev/mem-03` (stacked on `dev/mem-02`, which stacks on `dev/mem-01`; nothing merged)
- **Commit:** `bd95b4b` (code, migration 0019, tests)

## Scope decision: lexical only
The spec makes semantic retrieval optional, with lexical-only as the safe fallback. `pgvector` is not installed in this environment and there is no qualified embedding model, so no vector column or semantic path was added. Every result says so (`semantic.enabled = false`, with the reason). No hybrid fusion (RRF) is implemented, because there is only one ranker. This is recorded as a gap, not claimed as hybrid.

## Reuse / gap
| Reused | Use |
|---|---|
| MEM-01 `requireActor`, `requireProject`, `READER_ROLES`, `STEWARD_ROLES`, `memory_source_revocations`, `memory_sources` | scope, roles and the read-time provenance and revocation check |
| MEM-01 lifecycle (status changes) | the trigger that maintains the index follows the same status transitions |
| `audit_entries` | index rebuild |

| Gap (new) | Where |
|---|---|
| Full-text projection of approved memories, maintained by trigger | `migrations/0019_memory_retrieval.up.sql` (`memory_index`) |
| Append-only retrieval log | same migration (`memory_retrieval_events`) |
| Scoped search with read-time double check, and sanitized query | `packages/memory/src/retrieve.ts` |
| Rebuild path | `rebuildIndex` in `retrieve.ts` |

## Changed paths
- `migrations/0019_memory_retrieval.up.sql`, `.down.sql` (new)
- `packages/db/src/schema.ts` (Drizzle declarations for `memory_index`, `memory_retrieval_events`)
- `packages/memory/src/retrieve.ts` (new), `src/domain.ts` (`INVALID_QUERY`), `src/index.ts`
- `packages/memory/tests/retrieve.test.ts` (new), `tests/migration.test.ts` (now tracks all memory migrations instead of fixed version lists)

## Migration 0019 notes
- `memory_index`: `record_id` (PK), organization, project, `indexed_claim_hash`, `index_version`, `lexical tsvector`. GIN index on `lexical`; scope index.
- Trigger `memory_index_maintain` (AFTER UPDATE OF status on `memory_records`): approved → upsert row; any other status → delete row. Invalidation is immediate and does not depend on application code.
- `memory_retrieval_events`: append-only; stores `query_digest` (sha256 of the query), returned ids, and omitted counts by reason. Never the query text.
- Grants to `factory_control`: index SELECT/INSERT/UPDATE/DELETE (needed because the trigger runs with the status-changing role), log SELECT/INSERT. No grant to runner or supervisor.
- Rollback: the index is a rebuildable projection and is dropped freely; the log refuses to roll back while events exist.

## Behaviour
1. Actor must hold a reader role in the organization, enabled; project must belong to the organization.
2. Query: 1–200 characters, no NUL. Terms are the letter and digit runs of the query (max 20), joined with OR. No operator or SQL can reach the database through the query.
3. Candidates: index rows in the caller's organization and project, ranked by `ts_rank_cd`, then `created_at` and id. Up to 4× the limit are considered.
4. Each candidate is re-checked in this order and omitted with a count if it fails:
   - `stale_index`: indexed claim hash differs from the record, or index version is not 1;
   - `not_usable`: status is not approved, or `valid_to` is set;
   - `unsourced`: no source rows;
   - `revoked_source`: any source revoked, or its item is in `memory_source_revocations` for the project.
5. Up to `limit` hits (1–50) are returned with claim text marked as data, rank, approver, version and source ids and digests.
6. Every search writes one `memory_retrieval_events` row.
7. `rebuildIndex`: steward roles only; deletes and rebuilds the project's index from approved records in one transaction; audited.

## Commands and results (local, real PostgreSQL 17)
| Command | Result |
|---|---|
| `bun test --timeout 30000 packages/memory packages/db` | 109 pass, 0 fail |
| `bun test --timeout 30000` (full repository) | **1392 pass, 0 fail**, 85 files |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun scripts/gates-lock.ts --check` | exit 0 |
| `python3 scripts/validate_package.py` | exit 0 |
| `bun run license` | exit 0 |
| `bun run build` | not run |

Mandatory tests from the spec:
- **Cross-project canaries:** a canary in project B is not returned from project A, and the reverse; a canary is not returned to another organization; another organization's actor gets `NOT_FOUND` on a project of the first organization.
- **Stale index:** a planted stale claim hash is omitted (`stale_index: 1`); rebuild restores the hit.
- **Hybrid recall:** a memory matching more query terms ranks first; a partially matching memory is still recalled.
- **Vector version:** not applicable (no vectors). Recorded as not tested.
- **Revoked sources:** revoking the artifact removes the memory from search and removes its index row; a project-level revocation planted without a status change is still refused at read time (`revoked_source: 1`).
- **Erasure and supersession:** erased memory disappears; superseded version disappears; new approved version is returned.
- **Unauthorized access:** disabled user → `FORBIDDEN`; wrong organization → `NOT_FOUND`.
- **Prompt injection as data:** injection-shaped queries (`') OR 1=1 --`, `"; DROP TABLE …`, UNION, operator soup) return no cross-project data, raise no error, and the row count is unchanged. Claims are returned as data.
- **Durability:** a fresh connection finds the same approved memory; rebuild is reproducible (same count before and after).
- **Log:** query digest equals `digestOf({query})`; the query text does not appear in the stored event; the log is append-only.
- **Validation:** empty, over-length, NUL, limit 0 and limit 51 are refused before any read.

## Security checks
- The index is never the authority: each result is re-checked against records, sources and revocations.
- Search results contain no content from other projects or organizations (canary tests).
- The query cannot alter SQL or tsquery structure (sanitizer tests and injection tests).
- Query text is not stored; only a digest is.
- No model, no embedding, no network.

## Known limitations
- **Lexical only.** No semantic search, no hybrid fusion, no vector-version tests. The `semantic` field discloses this.
- **Ranking is `ts_rank_cd` on `simple` configuration.** No stemming and no language-specific stopwords, so Portuguese and English inflections do not match each other. Quality against a baseline has not been measured (EVALUATION.md is MEM-08).
- **Retrieval does not yet report recall or precision.** No quality benchmark exists.
- **Access is organization-role only** (operator decision): any reader in the organization can search any project in it.
- **Index is not per-actor.** This is acceptable only because access is organization-role; per-project grants would need a filter on the candidate query.
- **Erasure of index rows relies on the status trigger,** which is also what MEM-01 tests cover. Backup and snapshot purge is still an operator procedure.
- **No pilot,** and independent review is not done.

## Next task
MEM-04 (token-aware context assembly) depends on MEM-03 being accepted and on a current model router and tokenizer interface, which this repository does not provide as a qualified path. Reviewer: review `bd95b4b` after MEM-01 and MEM-02.
