# MEM-02 evidence report — evidence-based ingestion and extraction

- **Status:** `verified` (local checks only). Independent review NOT done; pilot NOT run. Not accepted.
- **Date:** 2026-11-20
- **Branch:** `dev/mem-02` (stacked on `dev/mem-01`; nothing merged)
- **Commit:** `85320ba` (code, migration, tests)
- **Depends on:** MEM-01 (`a2b98c5`, `64d3361`, `5afdb83`), which is itself unaccepted.

## Reuse / gap (MEM-02 scope)
| Reused | Use |
|---|---|
| `artifacts` (`digest`, `storage_uri`, `redaction_status`) | source text; bytes re-hashed to the stored digest |
| `events` (`digest`, `payload_redacted`) | source text for allow-listed event types; upstream `redact()` already applied in `appendEvent` |
| `FileArtifactStore` layout (orchestrator) | same content-addressed scheme, read directly; no new dependency |
| MEM-01 `proposeMemory`, `requireActor`, `requireProject`, `sourceInProject`, `memory_source_revocations` | every memory goes through the MEM-01 lifecycle |
| `audit_entries` | ingest success and refusal |

| Gap (new) | Where |
|---|---|
| Ingestion run and span-link tables | `migrations/0018_memory_ingestion.*` |
| Deterministic extractor, secret and injection detectors | `packages/memory/src/extract.ts` |
| Ingestion service | `packages/memory/src/ingest.ts` |

## Changed paths
- `migrations/0018_memory_ingestion.up.sql`, `.down.sql` (new)
- `packages/db/src/schema.ts` (Drizzle declarations for the two new tables)
- `packages/memory/src/{extract,ingest,domain,lifecycle,index}.ts` (new/changed; `domain.ts` gains 4 error codes; `lifecycle.ts` exports 3 helpers)
- `packages/memory/tests/{extract,ingest,migration}.test.ts` (new / changed)

## Migration 0018 notes
- Two tables, both append-only triggers, insert and select only for `factory_control`.
- Unique key `(project_id, source_kind, source_id, source_digest, extractor_id)` gives idempotency.
- Check constraint: `proposed + dropped_secret + dropped_injection = candidates_total`.
- Rollback refuses while any run exists (same policy as 0017).
- The MEM-01 migration test was made version-aware (it previously hard-coded `["0017"]`).

## Behaviour
1. Actor must hold a proposer role in the organization; project must belong to the organization.
2. Source metadata is scoped to organization and project. Other project or organization → `SCOPE_MISMATCH` / `NOT_FOUND`.
3. Consent is checked before any content is read: `purpose: project_memory`, `grantedBy` an enabled member of the organization; transcripts and recordings also need `recordingConsent: true`. Otherwise `CONSENT_REQUIRED`.
4. Artifacts must be `redaction_status = clean`, with a `file://` URI. Bytes are hashed; a mismatch → `SOURCE_UNVERIFIED`. Over 800 KB on disk or 200 000 characters → `SOURCE_TOO_LARGE`.
5. Events must be an allow-listed type (`human.note`, `intake.message`) with a text payload; otherwise `NOT_INGESTIBLE`.
6. Revoked sources are refused (`SOURCE_REVOKED`).
7. Existing run for the same content → returned as `reused`, nothing new written.
8. Extraction: sentences with an explicit marker only (`must not`/`cannot` → constraint; `must`/`shall`/`needs to` → requirement; `decided`/`we will`/`agreed` → decision). At most 200 candidates, 12–400 characters each.
9. A candidate containing a secret pattern is dropped (counted). A candidate with instruction-like text is dropped (counted). The rest are proposed through `proposeMemory`, each with `extraction_method: deterministic`, the artifact or event digest, and a `{start,end}` span.
10. Run row and span links are written in one transaction with the audit entry.
11. Every refusal writes an audit row `memory.ingest` with `result = refused` and the error code.

## Commands and results (local, real PostgreSQL 17)
| Command | Result |
|---|---|
| `bun test --timeout 30000 packages/memory packages/db` | 92 pass, 0 fail |
| `bun test --timeout 30000` (full repository) | **1375 pass, 0 fail**, 84 files |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun scripts/gates-lock.ts --check` | exit 0 |
| `python3 scripts/validate_package.py` | exit 0 |
| `bun run license` | exit 0 |
| `bun run build` | not run |

Test coverage of the mandatory items:
- **Source fixtures:** a transcript with decisions, requirements and a constraint; each candidate's span equals the claim text.
- **Prompt injection:** instruction-like sentence dropped; benign sentence still proposed; nothing approved. Detector tested on negatives ("decided to approve the budget" is not flagged).
- **Redaction:** raw artifact containing an AWS key → claim dropped, key absent from `memory_records`. Event path: the key is already absent in `events.payload_redacted` (upstream redaction) and in the ingested claims.
- **Duplicate events / re-ingestion:** same event twice → one run, same memory ids; same artifact → same run.
- **Consent:** missing, non-member, disabled-member, wrong purpose, and transcript without recording consent → `CONSENT_REQUIRED`; refusals are audited.
- **Unauthorized access:** viewer → `FORBIDDEN`; other project's source → `SCOPE_MISMATCH`; other organization's project → `NOT_FOUND`; cross-organization actor → `NOT_FOUND`.
- **Source verification:** pending redaction → `SOURCE_UNVERIFIED`; tampered file → `SOURCE_UNVERIFIED`; missing file → `SOURCE_UNVERIFIED`; oversized file → `SOURCE_TOO_LARGE`; non-ingestible type → `NOT_INGESTIBLE`.
- **Revoked source:** `SOURCE_REVOKED`.
- **Acceptance invariants:** every ingested memory has a span-bearing source; none is approved by ingestion (the single approved one is the one an approver approved); proposals are `proposed` and not usable.
- **Restart:** fresh connection reads the run (consent, counts) and the memory status.

## Security checks
- Content is read only after consent and scope checks pass.
- Artifact bytes must match the stored digest before any text is extracted.
- Secrets never reach a stored claim; detection is applied to every candidate before proposal.
- Instruction-like text cannot create approvals: ingestion has no approval path, and MEM-01 blocks approval without a human approver.
- No model is called; no paid or metered API; no network.

## Known limitations
- **Deterministic extraction only.** The `candidate_llm` extraction method is allowed by the schema but not implemented: no qualified model exists in this environment. Precision is prioritised over recall.
- **Consent is asserted by the caller.** The system checks that `grantedBy` is an enabled member, but it does not run a per-participant consent workflow. This must be designed before meeting transcripts from real people are ingested.
- **Secret and injection detection are pattern-based.** They are defence in depth, not a complete filter. Event payloads are additionally redacted upstream by the existing `redact()`.
- **Event integrity is anchored on the stored event digest.** The event payload is not re-hashed, because the stored digest is computed over structured fields rather than the text alone.
- **Only `file://` artifacts are readable.** Other storage backends are not supported.
- **Refusals are audited but not stored in a dedicated table.** Review screens (MEM-07) will need a query over `audit_entries`.
- **No pilot.** Tested with fixtures, not with a real authorized project or real meeting data.
- **Independent review not done.**

## Next task
MEM-03 (hybrid search and scoped retrieval) depends on MEM-01 and MEM-02 being accepted. Reviewer: review `85320ba` and the MEM-01 commits first.
