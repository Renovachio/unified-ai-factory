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

## Addendum 6: login session boundary (migration 0027, option a)

Change:
- Login sessions are created or rotated only by `create_auth_session()` (SECURITY DEFINER). It refuses unknown or disabled users.
- Login runs on its own role, `factory_login`, granted only what login needs: read users, read/update sessions, consume login transactions, write audit rows. Its connection is `DATABASE_LOGIN_URL`, required whenever `OIDC_CLIENT_ID` is set.
- `factory_control` loses INSERT, UPDATE and DELETE on `auth_sessions`. It keeps SELECT.
- Migration down restores the 0010 session grant and removes the role and function; covered by a round-trip test.

Deployment step (operator): create a LOGIN role, grant it `factory_login`, and set `DATABASE_LOGIN_URL` for the API process. Without it the API refuses to start when OIDC login is enabled.

Results: full suite 1474 pass, 0 fail. Typecheck, lint, gates, package validation and license pass.

Still open:
- approvals (0001/0010) and approval_decisions (0011) are written by the control role. Approver identity there is bound by the API session check, not by the database. Session-bound approval functions are the next change if the operator wants the database to enforce approver identity.
- Whether the operator's deployed roles match this model is not verified; this is a repository check only.

## Addendum 7: approval role separation (migration 0028)

Change:
- `factory_approval` (NOLOGIN group, granted to a LOGIN role by the operator) writes approval records: approvals, approval_decisions, plus the writes the two approval entry points make (job transitions, events and their outbox rows, audit, idempotency keys, skill version state). It reads broadly, but has no access to auth_sessions, auth_login_transactions or integrations.
- `factory_control` loses INSERT, UPDATE and DELETE on approvals and approval_decisions. It keeps SELECT and the `consumed_at` column on approval_decisions, which skill activation needs.
- The API uses `DATABASE_APPROVAL_URL` for the job decision route and the skill decision route. It is required whenever local owner mode is off. Local mode (one owner, loopback) shares the main connection, as stated.
- Defect found and fixed during this change: revoking table-level UPDATE also removed the 0011 `consumed_at` column grant. The migration now restores that column.

Verification: the 7 job-decision API tests and 12 registry API tests run with approval writes through factory_approval, so the grants are exercised by real approval paths, not just by privilege checks.

Limits (stated, not closed):
- Separation is by database connection, not by process. The same API process still holds the control connection, so a compromised process can still reach the approval connection. Splitting into a separate process is the next step if the operator wants it.
- The approver identity is the one the API resolved from the request. The database checks the approver is an enabled user of the organization, not which person made the request. Token binding covers only OIDC database sessions; bearer tokens and the HMAC cookie create no database session.
- Product artifact approval (packages/product, approveArtifact) records approved_by on product_artifacts through the control role. It is outside this migration and remains open.

Deployment (operator): create a LOGIN role, grant it factory_approval, and set DATABASE_APPROVAL_URL for multi-user API processes. Login uses DATABASE_LOGIN_URL (migration 0027).

Results: full suite 1475 pass, 0 fail. Typecheck, lint, gates, package validation and license pass.

## Addendum 8: product artifact approval (migration 0029)

- Approving or superseding a product artifact, and setting approved_by, is allowed only from factory_approval or a superuser (trigger `product_artifacts_approval_role`). A trigger is needed because control and approval both write the `state` column; column grants cannot separate them.
- factory_control can still submit a draft for review (draft to in_review).
- The product approve route uses the approval connection.
- Tests: a direct control-role approval is refused and the artifact stays in_review; the approval role approves the exact digest; the existing product suite still passes (15 tests).
- Limit: the approver identity is still the one the API resolved; the existing CHECK ensures approver is not the author.

Results: full suite 1477 pass, 0 fail. Typecheck, lint, gates, package validation and license pass.

Not done in this round: a fresh independent review of migrations 0026 to 0029. Recommended before merge; it needs a reviewer run that the operator has not yet authorized in this round.

## Addendum 9: independent review of 0026-0029 (tip 7fcddff) and fixes

Verdict of the review: not safe to merge as it stood. Findings and fixes (all on dev/mem-05; migrations 0026-0029 are unmerged, so they were corrected in place):
- HIGH-1 (product artifacts): the approval trigger fired only on UPDATE, so factory_control could INSERT a row already approved. Fixed: the trigger is BEFORE INSERT OR UPDATE (migration 0029). Test: control insert refused.
- HIGH-2 (sessions): create_auth_session used SET search_path = public, so a temp table named users could shadow the enabled-user check and create a live session for a disabled account. Fixed: search_path ends with pg_temp last (migration 0027, pg_catalog, public, pg_temp). Mutation check: removing the fix makes the test fail.
- MEDIUM-1 (approval records): nothing checked the approver on approvals rows or on product approvals. Fixed: approvals_actor_guard (migration 0030) requires an enabled approver or admin of the job organization; the product trigger checks approved_by is an enabled approver or admin of the artifact organization, when it is set or changes. Superusers are exempt in both, as in the existing guards.
- MEDIUM-2 (0028 down): the rollback widened control's grants (full UPDATE on approval_decisions). Fixed: the down restores INSERT/UPDATE on approvals, INSERT on approval_decisions, and UPDATE(consumed_at) on approval_decisions. Test: round trip checks the restored privileges.
- LOW-1: 0028 comments corrected (the column-grant observation is a probe result, not a documented PostgreSQL behavior).
- Not changed: LOW-2 (factory_approval keeps UPDATE on skill_versions): the rejection path in decideApproval needs it; control has had the same write since 0011; activation still requires a decision row.
- Not changed, documented: local owner mode shares the control connection (DATABASE_URL). If that role is a superuser or owner, the grants do not apply. The launcher's role was not verified in this review. Multi-user deployments fail closed without DATABASE_APPROVAL_URL.

Results: full suite 1482 pass, 0 fail. Typecheck, lint, gates, package validation and license pass.

## Addendum 10: retention policy (operator decision)

Policy as decided:
- Proposed memory: erased after 90 days (age from creation).
- Rejected memory: erased after 30 days (age from the rejection, updated_at).
- Approved memory: never expires automatically. Erasure only by a steward. The rule "expire when a new approval conflicts and the user accepts the erasure" is NOT built yet: it needs a conflict detector and a user-acceptance step, which are separate work.
- Pack text (rendered context that copies claims): deleted after 30 days. Pack rows keep ids and digests only, so they remain as an audit trail.
- Erasure runs as a named steward (STEWARD_ROLES), so every erasure is attributed in the transition record and tombstone. No separate system identity was created.

What was built (packages/memory/src/retention.ts):
- eraseMemoryText: erases one memory (content, index row through the existing trigger) and deletes every stored pack text that selected it. Idempotent: a retry after a failed blob deletion removes the remaining text.
- runRetention: applies the policy to one project. Requires a steward. Safe to run repeatedly.
- PackTextStore and FileArtifactStore gained delete (idempotent; the file's read-only mode is cleared before unlinking).
- Retrieval events store digests only (checked), so they need no erasure.

Not built (stated):
- The scheduler that runs runRetention. Nothing calls it yet; it must be run by an operator or a scheduled job.
- Backup expiry: the operator's backup retention is outside the repository. Deleted content can persist in backups until they expire; this must be documented in the operator's runbook.
- Conflict-driven erasure of approved memory (see first bullet).

Results: full suite 1489 pass, 0 fail (7 new retention tests). Typecheck, lint, gates, package validation and license pass.

## Addendum 11: scheduler and conflict-driven erasure

Operator decisions implemented:
- Approved memory expires only when a new approval conflicts with it AND the approver accepts erasing it.

Conflict detection (packages/memory/src/lifecycle.ts: conflictsOf):
- Approved memories in the same project and kind, with a different normalized claim, whose word overlap (Jaccard) is at least 0.5 (the same threshold the review tooling uses).
- Claims with fewer than 5 distinct words are never conflicts (short claims overlap by chance too easily; this is a judgment call, stated here).
- Consolidation originals and the memory a revision replaces are excluded: they are the same knowledge.
- This is a textual signal only. It does not decide whether two claims contradict; a human decides.

Approval (packages/memory/src/conflict-approval.ts):
- approveMemory refuses any memory that overlaps approved memory (CONFLICT_UNRESOLVED), so the rule cannot be bypassed by the plain path.
- approveWithErasure(…, acceptErasureOf): the approver must name EXACTLY the overlapping memories. Each is erased (content, index, pack text) and the new memory is approved, in one transaction. Pack text is removed after commit; the sweep repairs any blob left behind.
- The acceptance is the approver's, recorded in each erasure reason. The author of the erased memory is not asked (decision to confirm).

Scheduler (packages/memory/src/retention-sweep.ts and scripts/memory-retention.ts):
- runRetentionSweep: runs the retention policy for every project of the named steward's organization, repairs pack text left by failed deletions, and writes one audit row (action memory.retention) attributed to the steward.
- The steward must be an enabled steward (approver, admin or security_officer); otherwise FORBIDDEN.
- Operator entry point: DATABASE_URL, DISPATCH_ARTIFACT_ROOT (the same root as the pack text store), DISPATCH_RETENTION_STEWARD_ID. One run by default; --every-hours N repeats in the foreground.
- Example cron (daily at 03:00):
  0 3 * * * cd /path/to/unified-ai-factory-v2 && DATABASE_URL=... DISPATCH_ARTIFACT_ROOT=... DISPATCH_RETENTION_STEWARD_ID=... /path/to/bun scripts/memory-retention.ts >> /var/log/dispatch-retention.log 2>&1

Tests:
- 8 tests for approval conflicts and erasure decisions (refusal, exact-set requirement, unrelated memory kept, erasure with pack text removal, revision not a conflict, no-overlap approval).
- 2 tests for the sweep (steward required; per-project report, audit row, repair of a failed blob deletion).
- Existing memory tests whose fixtures overlapped were given distinct wording (lifecycle claim helper; retrieval and context pack claims; consolidation pairs), and one legacy-overlap review test writes its overlapping pair as legacy state. Overlap between approved memories can no longer arise through approval; the review tooling still reports it for memories that predate the rule.

Not verified or not done:
- The sweep and erasure are tested with the superuser connection, not as factory_control. Memory writes were granted to factory_control (migrations 0017, 0019, 0021, 0023); that was checked by reading the grants, not by a role-scoped run.
- Concurrent approvals of overlapping memories can race (the conflict check reads approved rows without a lock on them).
- The CLI is not run in an automated environment here; the cron line is documented, not installed.
- Backup expiry remains an operator runbook item.

Results: full suite 1497 pass, 0 fail (92 files). Typecheck, lint, gates, package validation, license and the script typecheck pass.
