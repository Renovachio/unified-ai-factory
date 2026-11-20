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

## Addendum 3: second independent review (tip 84b8386) and fixes

Fixed in this round (migration 0025 edited before any release; it is still on this unmerged branch):
- Restore now requires the successor and validity window to be cleared in the database (regression from 0024; the rollback file already required it).
- A memory cannot supersede itself.
- A consolidated memory can supersede only through its approved consolidation (link present, consolidation approved).
- Existing consolidated memories are backfilled into `is_consolidation` before the guard enforces the flag. The rollback now refuses whenever any consolidation link exists.
- Idempotent proposals match kind and consolidation status. A plain proposal that clashes with a consolidation is refused (WRONG_STATE) instead of returning the consolidation.
- Documentation corrected (restore is governed by migrations 0024 and 0025).
- Tests added for each fix. Memory and db: 164 pass. Full suite: 1464 pass, 0 fail. Typecheck, lint, gates, package validation and license pass.

Open, needs an operator decision (NOT fixed here):
1. **Control role trust boundary.** The role `factory_control` can (a) INSERT transition rows with an arbitrary actor and from_status, which satisfies the commit-time transition check; and (b) UPDATE `users.role` and `users.disabled_at`, which lets it make any user an approver and then approve as them. The approver check therefore trusts a column the same role can change. Options:
   - A (recommended): column-level grants so `factory_control` cannot change `users.role` or `users.disabled_at`, and route transition writes through a definer function that derives the actor from the verified session, with the deferred check also verifying from_status, to_status and that approved_by matches the transition actor.
   - B: keep the role trusted and state that approval enforcement depends on the API layer. Weaker, and it should be recorded as a decision.
   The API may need `users` writes for user administration, so option A needs the API's user-admin path confirmed first.
2. **Ownership.** Whether `factory_control` owns the tables (which would allow DISABLE TRIGGER) was not checked against the deployed roles.

## Addendum 4: Option A, control-role boundary (migration 0026)

Operator decision: Option A. Implemented as far as the database can enforce it.
- `factory_control` loses INSERT and UPDATE on `users`. User records are written by the database owner (operator). The control plane keeps SELECT. Checked: no application path updates or inserts users through the control role (the only inserts are the local bootstrap in apps/api/src/local.ts, which runs as the owner).
- The commit-time transition check now matches from_status, to_status and record_version, and an approval's transition actor must equal the recorded approver.
- SEC-05 test (packages/scheduler/tests/roles.test.ts) changed: it asserted that the control plane can UPDATE users. That assertion contradicts Option A and is now inverted, with a comment pointing to 0026. This is the one accepted design change in this round.
- Tests: 3 new boundary tests (actor mismatch, from-status mismatch, control role cannot write users). Results: full suite 1467 pass, 0 fail. Typecheck, lint, gates, package validation and license pass.

Residual limit (NOT closed, needs a further decision): the control role can still insert a transition row naming any existing approver and approve as that approver. The database cannot tell which person a session represents. Closing this needs one of: a per-user or per-operator database identity for approvals, or a session-bound actor that the database verifies. Until then approval enforcement is only as strong as the control-plane process, and the API's approval path must be the only code that holds the control role for approvals.

## Addendum 5: third review of migration 0026 (tip a167d4b)

Verdict: 0026 is NOT safe to merge while the session path below is open.

- **High, not in the earlier residual:** `factory_control` can INSERT into `auth_sessions` for any user (0010 blanket grant; the control-plane test asserts it). A session for an enabled approver lets the control role act as that approver; the 0025/0026 approver checks then bind nothing. Disabled users are rejected at session read time in the API, not by the database. The same class exists in `approval_decisions` (0011) and `approvals` (0001, via 0010). Not fixed: closing it changes how login writes sessions, which is a decision (see the operator's options below).
- **Medium, fixed:** the stale-transition and record-version checks had no tests. Added: a transition committed in an earlier transaction does not satisfy a later change; a transition for another record_version does not satisfy the change.
- **Low, fixed:** the 0025 test no longer depends on the 0026 wording.
- **Low, open:** the control-plane test asserts that the control role CAN insert `auth_sessions`. That is the current behaviour and must change on purpose when the session path is closed.

Results: full suite 1470 pass, 0 fail, 90 files. Typecheck, lint, gates, package validation and license pass.

Open decision before merge: how sessions and approval records are written. Options: (a) a database function that creates sessions only after credential checks, executed by a login role separate from factory_control, with factory_control denied direct writes to auth_sessions, approvals and approval_decisions; (b) keep the current grants and document that the control plane is trusted for approver identity.
