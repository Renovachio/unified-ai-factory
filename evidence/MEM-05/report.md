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
