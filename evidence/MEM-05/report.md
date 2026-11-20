# MEM-05 evidence: consolidation and supersession (partial)

Status: **implemented in part, local checks only.** Not independently reviewed. No pilot. Retention and stale priority are NOT built: they need a retention policy from the operator. Reversal of consolidation is NOT built: the lifecycle matrix forbids it and changing that is a decision.

## Audit (reuse vs gap)
- Reused: `proposeMemory`, `insertProposal`, `verifySources`, `approveMemory` (single-revision supersession already existed), `rejectMemory`, `revokeSource`, `searchMemories`, the transition log, role constants.
- Gap: the schema links one predecessor (`supersedes_id`). Consolidation needs many originals to one successor. Solved with an append-only link table `memory_consolidations`, not by changing `memory_records`.
- Gap: no duplicate or conflict review. Added as a read-only report.

## What was built
- Migration `0023_memory_consolidation` (up/down): append-only `memory_consolidations`, unique link per pair, database trigger that refuses a link across organizations or projects, grants insert/select to the control role. Down refuses while links exist.
- `proposeConsolidation`: 2..20 distinct approved originals of one kind in one project; sources verified like any proposal; no original may belong to another pending consolidation; the proposal is idempotent and refuses a different original set for an identical claim and sources. Originals are not changed by proposing.
- `approveMemory` (extended): approving a consolidated memory supersedes each original in the same transaction, with `superseded_by` set and a transition reason `consolidated into <id>`. It refuses (WRONG_STATE) if any original is no longer approved; nothing changes in that case.
- `findReviewCandidates`: read-only. Exact duplicates among approved memories, and same-kind pairs with token overlap at or above 0.5. Returns ids and similarity only, never claim text. Makes no decision.
- New error code `INVALID_CONSOLIDATION`. Authorization runs before input-shape checks.

## Tests (`packages/memory/tests/consolidate.test.ts`, 15 tests)
- Proposing changes no original; consolidated memory not retrievable until approved.
- Refusals: size bounds, duplicate originals, mixed kinds, missing sources, cross-project originals, unapproved originals, viewers, cross-organization, revoked source.
- Pending-consolidation lock; the author cannot approve their own consolidation (approver proposes, same approver tries to approve: SELF_APPROVAL).
- Approval supersedes all originals atomically with lineage; retrieval shows the consolidated memory and not the originals.
- Revoked original after proposal: approval refused, nothing changes.
- Rejection frees originals; identical claim with a different original set is refused.
- Revoking the consolidated memory later does NOT restore its originals (asserted, so the behaviour is visible).
- Durability: lineage read from a fresh connection. Injection-as-data: hostile claim stored verbatim and never self-approves. Review report exposes no claim text and changes no status. Disabled and cross-organization users refused.

## Results
- `packages/memory` and `packages/db`: 149 pass, 0 fail.
- Full suite: 1449 pass, 0 fail, 90 files. Typecheck, lint, gates lock, package validation and license all exit 0.

## Risks and gaps (must be decided before activation)
1. **Irreversible supersession.** Once a consolidation is approved, the originals stay superseded. Revoking the consolidated memory leaves the originals out of retrieval. A safe reversal needs a new lifecycle transition (superseded to approved, under human approval) and a decision on whether it is allowed. Until then, consolidation is a one-way step.
2. **Retention not built.** Needs an operator-set period and a rule for what may be deleted. Erasure already exists (`eraseMemory`, steward only); no automatic deletion is added.
3. **Stale priority not built.** No ranking change for age or staleness.
4. **Conflicts are detected, not resolved.** Token overlap is not contradiction. Each flagged pair needs human judgement.
5. **Backup:** no separate backup procedure was tested. Durability of the lineage across connections is tested; a full dump-and-restore drill is not.
6. Independent review and real pilot remain open.

## Addendum: restore after consolidation ended (migration 0024)

- `restoreConsolidation` (approver only): originals of a consolidated memory return to approved only if that consolidated memory is now revoked or erased, every original is still superseded by it, and no original has a revoked source (directly or via a project revocation). All or nothing, in one transaction. Each restore writes a transition with reason `restored after consolidation <id> ended`.
- Guard change (migration 0024): one exception in `memory_records_guard`. Superseded to approved is allowed only when `memory_restore_allowed` holds (the original's successor is a consolidated memory that is now revoked or erased). The generic matrix (TypeScript and SQL, checked by the parity test) is unchanged. Down restores the 0017 guard and refuses if any restore has happened.
- Tests (6 new, 21 in the file): refused while the consolidated memory is approved; restore after revocation with retrieval and transition evidence; refused for viewers and disabled users; all-or-nothing on a revoked source; raw-SQL loophole checks (a superseded plain revision stays unrecoverable even when its successor is revoked; a consolidation original cannot be restored by SQL while its consolidated memory is approved).
- Results: full suite 1455 pass, 0 fail, 90 files. Typecheck, lint, gates lock, package validation and license all exit 0.
- Remaining decision: the restore rule is narrow but is a real change to the lifecycle guard. Independent review of migration 0024 is required before it is merged.

## Addendum 2: independent review fixes (migration 0025)

Fixes for the findings of the independent review of dev/mem-01..dev/mem-05 (tip 6f1296e):

- **High, superseded_by not enforced:** `superseded_by` changes only by supersession (approved to superseded, successor in the same organization and project) and by restore. Re-pointing or clearing a live supersession is refused. Test: raw SQL on a live consolidation's original.
- **High, approval not enforced by the database:** `approved_by` is set once, on proposed to approved, by an enabled approver or admin of the same organization. Viewers and other-organization approvers are refused. Every row is born proposed, with no approver, successor or validity window. Tests cover each case.
- **Medium, transition trail skippable:** every status change and every insert needs a `memory_transitions` row in the same transaction, checked at commit (deferred constraint trigger). Test: a raw status change with no transition is refused.
- **Medium, links to a plain memory:** `is_consolidation` is set at creation and immutable. Links attach only to a proposed consolidated memory of the same kind whose originals are approved. An identical claim and source set that already exists as a plain memory is refused by the service, and raw links to it are refused by the database.
- **Medium, rollback bypass:** the 0025 rollback refuses if any restore or consolidated memory exists. The 0024 guard is restored exactly on rollback.
- **Low, current memories without sources:** `listCurrentMemories` requires at least one source.

Not changed (documented, not fixed in this round):
- `restoreConsolidation` keeps the original approver on the row. The restoring approver is recorded in `memory_transitions`.
- `resolveContextPack` selects by pack id only. It is a system path and is not reachable in this build (no adapter is wired). It must be project-scoped before any adapter uses it.
- Consent for ingestion is caller-asserted (the grantor must be an enabled organization member; the grant is not verified).
- Ingestion writes each proposal in its own transaction before its run record. A retry is idempotent.

Results: `packages/memory` and `packages/db`: 160 pass, 0 fail. Full suite: 1460 pass, 0 fail, 90 files. Typecheck, lint, gates lock, package validation and license all exit 0.
Remaining: a fresh independent review of migration 0025 and its tests is required before merge.
