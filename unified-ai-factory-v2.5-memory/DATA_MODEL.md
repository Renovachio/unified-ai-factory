# PostgreSQL Data Model and Migration Guidance

**Proposed logical schema, not ready-to-run migrations.** Adapt table/column names and types to real ORM conventions after inspecting existing jobs, product artifacts, permissions, audit and project tables. Use additive migrations and migrate in expand/backfill/verify/contract stages. Do not duplicate existing artifact or approval stores.

| Table | Required data / invariants |
|---|---|
| `memory_records` | id, tenant_id, project_id, kind, text_ref, normalized_claim, status, sensitivity, owner, created_at, valid_from, valid_to, superseded_by, source_digest, record_version; immutable verified claims require version replacement |
| `memory_sources` | memory_id, source_artifact_id, source_span, source_version/digest, extraction_method, authorizing_event_id, original_acl_digest; direct traceability |
| `memory_edges` | subject_record, predicate, object_record, evidence_id, effective dates, status; never infer approvals via graph edges |
| `memory_indexes` | record_id, lexical_document, embedding_version, vector_ref / vector, indexed_digest, indexed_at, deletion_marker; rebuildable projection |
| `memory_summaries` | summary_id, scope, source_record_ids/digests, generated_text_ref, generator_id, summary_version, validated_at, status; version lineage |
| `memory_retrieval_events` | request_id, actor scope, selected/filtered ids, context_pack_digest, rank config version, token accounting, test category, timing, redacted logs |
| `memory_feedback` | event_id, memory_id, actor/project, kind, verified_outcome_ref, error type, recorded_at, resolution status; feedback does not mutate approvals |
| `memory_tombstones` | record_id, deletion reason, requested_by, timestamp, purge status per projection, minimal non-content audit receipt |
| `context_packs` | pack_id, job_id, project scope, selected version pins/digests, allocations, token counts and omissions; immutable evidence |

## Indexes and constraints
Composite `(tenant_id, project_id, status, valid_from)` B-tree; GIN full-text index scoped by safe server predicates; optional HNSW/IVFFlat for qualified pgvector version; uniqueness or dedupe by `(tenant_id, project_id, normalized_claim_hash, source_digest)` where semantically appropriate, **never** across unrelated tenants. Foreign keys to approved existing project/artifact entities. Row-level security where repo policy expects it, with server-side ACL always enforced.

## Deletion
Erase canonical content and indexed vector/keyword projections, snapshots where user policy requires, summaries derived solely from deleted source, caches/context lookup entries, and scheduled exports. Invalidate summaries derived from mixed sources and rebuild from still-authorized sources. Backups obey documented encryption, retention and recovery-deletion procedure; never claim instant physical removal from immutable backups. Minimize tombstone content.

## Migration testing
- Fresh database install and old-state migration.
- Repeated migration and safe rollback strategy (forward-only corrective migration where rollback could lose user data).
- Tenant/project leakage checks and concurrent reads during supersession.
- Restore from backup, replay outbox and index rebuild determinism.
- Retain existing `apps/api` DB connection and migration ownership.
