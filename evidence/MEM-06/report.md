# MEM-06 — Feedback and SAI-11 integration: partial (slice 1)

Status: implemented_partial. Not complete. The work order's pilot, failure taxonomy, improvement hypotheses and candidate evaluation triggers are not built.

## Audit: reuse vs gap

- **SAI-11 (reuse).** `packages/improvements` (supervisor, engine, store) exists. Its proposal pipeline runs on capability signals (`improvement_signals`, written by `packages/capabilities/src/gaps.ts` `recordSignal`). `evidence/SAI/report.md` lists SAI-11 as `in_progress`.
- **Signal intake (reuse).** `recordSignal` already enforces opt-in and anonymisation, normalises intent so raw text is never stored, and keeps only evidence digests. Memory feedback reuses these rules instead of creating a second intake.
- **Memory side (new).** No feedback store existed. Added `memory_feedback` (migration 0031).
- **Dependency choice.** `@factory/memory` does not depend on `@factory/capabilities`. The feedback function takes a `SignalSink` parameter, so the memory package stays free of that dependency. The composition root (API or worker) must supply a sink that calls `recordSignal` with `optedIn` set. That wiring is not done yet.

## Built

- Migration 0031 (`up`/`down`): append-only `memory_feedback` with verdict (`useful`, `wrong`, `stale`, `missing`) and signal state (`not_requested`, `sent`, `failed`). No free-text column. `factory_control` gets SELECT and INSERT only.
- `packages/memory/src/feedback.ts`: `recordRetrievalFeedback`. Reader roles only. Project scope checked, memory must belong to the org and project (otherwise NOT_FOUND). Non-useful verdicts with consent go to the sink as kind (`low_quality`, `user_correction`, `uncovered_request`), an intent (never stored), and evidence `memoryId:verdict` only. A sink failure is recorded as `failed` and does not fail the request.
- Drizzle schema declares `memory_feedback` (required by the schema test).
- Tests: `packages/memory/tests/feedback.test.ts`, 8 tests.

## Mandatory cases (from the work order)

| Case | Test | Result |
|---|---|---|
| No self-activation: feedback changes no status, approves nothing | useful verdict; poisoned feedback (pending memory stays `proposed`, approved memory stays `approved`) | pass |
| Poisoned feedback: instructions in the intent are data | poisoned intent test; `memory_feedback` has no intent/comment column | pass |
| SAI-11 unavailable: graceful degradation, verdict kept, no silent loss | sink throws; state `failed`, row stored | pass |
| Unauthorized project access | other-org user; memory from another project | NOT_FOUND, pass |
| Leakage: claim text not sent | evidence and intent checked for claim text | pass |
| Append-only storage | UPDATE refused | pass |
| No consent, nothing sent | no-consent test | pass |

Not verified: revoked sources (feedback does not read sources), durable restart beyond the stored row, and role-scoped behaviour of the signal write (`improvement_signals` grants to the connecting role; tested as superuser only).

## Results

- Full suite: 1509 pass, 0 fail (93 files) after the final edits.
- Lint, typecheck, API typecheck, gates lock, package validation and license pass.
- Mutation check: not run for this slice.

## Not built (remaining MEM-06 scope)

- Failure taxonomy beyond the four verdicts.
- Improvement hypotheses and candidate evaluation triggers, which would go through SAI-11's existing supervisor and its human approval.
- Production wiring of the sink to `recordSignal` in an app.
- Real authorized pilot: none exists in this repository (see MEM-08 blocker), so the pilot cannot be run.
- Independent review of this slice.

## Risks

- A sink supplied with `optedIn: true` while the user has not consented would send signals. The module trusts the caller's consent flag; the wiring must derive it from the project's setting.
- Signal volume is not rate-limited here; recordSignal dedupes exact repeats only.

## Addendum: wiring and role-scoped signal write

- **Wiring (library level).** `packages/orchestrator/src/memory-feedback.ts`: `sai11SignalSink` sends each gap signal through SAI-11's existing capability intake (`recordSignal`), which enforces opt-in, anonymisation, intent normalisation and digest-only evidence. `feedbackWithSignals` is the composed entry point. The orchestrator gained a workspace dependency on `@factory/capabilities` (bun.lock: one line).
- **Role-scoped signal write.** Tested as `factory_control` (the production control role): a wrong verdict with consent writes one `improvement_signals` row (kind `low_quality`, digest-only evidence, claim text absent). Without consent nothing is written. An intent the intake rejects (no usable content) is recorded as `failed` and does not fail the request.
- **Not wired:** no HTTP route, UI or app calls `feedbackWithSignals`, because none exists for memory. No project-level consent setting exists; the caller supplies `optedIn`. Both are product decisions still open.
- **Pilot:** still not run. No authorized pilot project exists (see MEM-08).
- Tests: `packages/orchestrator/tests/memory-feedback.test.ts`, 3 tests. Full suite 1512 pass, 0 fail.

## Addendum 2: independent review of 3895aa8, fixes and corrections

Reviewer: separate subagent, read-only. Verdict at review: not safe to merge. Verified by reading and by running (the reviewer ran both suites and one consent mutation: removing the consent gate made the "without consent" test fail).

Fixed:
- **Partial write (signal kept, row lost).** The signal was sent before the row was inserted. Now the feedback row and the signal share one transaction. The signal runs in a savepoint: if it fails, only its write is undone and the row records `failed`; if the row cannot be stored, the signal is rolled back too. Test: a sink that fails inside the database leaves the row stored as `failed`.
- **Consent enforced only by the caller.** The sink hard-coded `optedIn: true` and `anonymized: true`, so the intake's checks did nothing. The sink now passes the consent value it receives, so SAI-11's intake refuses when consent is false. The memory function still decides whether to call the sink.
- **Consent given but no intake wired** was recorded as `not_requested`, which contradicts the consent. Now recorded as `failed`.
- **Intent leakage.** Free-text intent was normalised, but names and project terms survived (for example "Carlos Soares" and "Acme Corp" became "carlo", "acm" and "corp" keys). The free-text intent is removed. The signal subject is now a fixed label from the memory kind ("memory retrieval fact"). This loses request-level clustering. Restoring it needs a privacy-reviewed intent source, which is an open decision.
- **Ambiguous `failed` state.** With no free text, the intake's validation rejections cannot be triggered from this path, so `failed` now means the signal did not reach SAI-11. Failed signals are not queued or retried. The verdict is kept, but the signal is lost unless someone re-sends it.
- **Malformed memory id** returned a driver error. Now NOT_FOUND.
- **Cross-project merging in SAI-11.** Signals were written to the default workspace, so all projects in an organization shared one bucket. Each project now uses its own workspace (its project id). The SAI-11 supervisor reads only a named workspace, so it must be pointed at these workspaces before they are used.
- **Organization id bug found during this fix.** The first version of the adapter passed an empty organization id to the intake. Caught by typecheck; the sink now receives the organization from the feedback function.

Corrections to the earlier report:
- The leakage check did not cover the intent path. Now the subject is claim-free by construction and the test checks it.
- "Role-scoped" covered one table (`improvement_signals`) under `factory_control`, in the orchestrator test only. The memory test runs as the database owner.
- The poisoned-feedback test passes because feedback has no text channel; it is not a test of an intent path.
- The earlier text "the module trusts the caller's consent flag" is still true for the decision to call the sink; the intake now also checks the value.
- The mutation check was run by the reviewer, not by me.
- The suite count was 1512 at the wiring commit and 1515 after this fix.

Still open (decisions for the operator):
1. Where project telemetry consent is stored. The caller still supplies it.
2. Whether signals need request-level detail for SAI-11 clustering, and if so, a privacy-reviewed source for it.
3. Retry or queueing for failed signals. None exists; a failed signal is lost.
4. The SAI-11 supervisor must be pointed at the per-project workspaces.
5. Pilot: not run (no authorized pilot project).

## Addendum 3: retry of failed gap signals (migration 0032)

- Failed signals were lost (addendum 2, open item 3). Now `retryFailedSignals` (memory) and `retryFeedbackSignals` (orchestrator) re-send them.
- A retry is a NEW append-only row with `retry_of` pointing at the failed row. The failed row is never changed. A unique index on `retry_of` lets only one retry exist per row.
- At most once: a retry that fails again is final. Retries need consent; without it nothing is sent.
- A concurrent second retry hits the unique index and rolls back its own signal.
- Tests: memory suite (retry linked and once, failed retry final, no consent sends nothing, other project untouched, cross-organization refused); orchestrator suite as `factory_control` (failure forced by a real database error, retry reaches the real intake once, second retry is empty).
- Mutation check: removing the "already retried" condition makes the final-retry test fail. The condition was restored afterwards.
- Not covered: a crash between the send and the insert inside the same transaction is rolled back by the database; no test kills a process mid-transaction.
- Still open: nothing runs the retry automatically. An operator or a job must call it.

## Addendum 4: consent is stored, not asserted (migration 0033)

- The caller's `optedIn` flag is removed from feedback and retries. Consent is a per-project, append-only setting (`memory_telemetry_consent`), set by `setTelemetryConsent`, which requires the approver or admin role. The latest row wins; no row means not opted in.
- Feedback and retries read the setting inside their transaction. The SAI-11 intake still receives `optedIn: true`, but only after the memory function has read consent from the database, and the intake checks that value.
- Tests: viewer refused to change consent; latest setting wins (on then off sends nothing); no row means off; the sink-related tests set consent explicitly.
- Not decided: who may revoke consent beyond approvers, and whether consent should also be recorded per user. The operator should confirm the approver-only rule.
- Full suite: 1523 pass, 0 fail.

## Addendum 5: independent review of 5f9082c and a9997fe, and fixes (migration 0034)

Reviewer verdict at review: not safe to merge. Fixed:
- **Control role could not write consent** (the consent sequence had no grant). Fixed with a sequence grant in migration 0034. Because that grant alone would let any control-role connection write consent, migration 0034 also adds a database guard: the granting user must be an enabled approver or admin of the same organization, and the project must belong to that organization. The guard is tested with a direct insert as `factory_control` by a viewer, which is refused.
- **Consent read once for a whole batch.** Retries now read consent per row, inside that row's transaction, under a share lock on the project row. If consent is off when a row is reached, the batch stops.
- **Consent race.** A consent change takes the same project row with NOWAIT: it fails at once while a send holds the lock, instead of waiting on a send that could be waiting on it. Test: a change during a locked send is refused.
- **Concurrent retries.** A duplicate from the unique index is now counted as `skipped` and no longer aborts the batch. Test: two concurrent retries produce one retry row.
- **Cross-project retry.** A composite key and foreign key now tie `retry_of` to the same project and memory. Test: a retry pointing at another project's row is refused.
- **Schema drift.** The drizzle schema now declares the consent sequence as bigserial and the indexes and composite key that the migrations create.
- **Test cluster hygiene.** Every test that enables a database role now turns it back off in its cleanup.

Not fixed:
- The 0032 and 0033 down migrations are not clean restorations: the retry rows become ordinary rows after 0032 down, and 0033 down deletes the consent history. Both are expected for a rollback in an unreleased branch; the operator must not roll back past these in production without a backup.
- A sink that calls setTelemetryConsent during a send gets an immediate error instead of a wait. This is by design, but no test covers a sink calling it.
- The unique index against concurrent retries is covered by the race test; removing the index was reasoned to fail that test but was not run as a mutation.

Results: full suite 1527 pass, 0 fail. Typecheck, lint, gates, package validation and license pass.

## Addendum 6: second independent review of 89081c9, and fixes

Reviewer verdict: not safe to merge as is. Fixed and verified:
- **Retry consent-off path untested.** The old test never produced a failed row, so removing the loop's consent check passed everything. The test now records a failed row, turns consent off, and requires the retry to stop with `stoppedOnConsent: true` and send nothing. Mutation check (removing the check) now fails that test.
- **Consent change blocked by ordinary writes.** The row lock on the project conflicted with foreign-key inserts, so a change could fail with no send in progress, and the message blamed a send. Consent now uses a transaction advisory lock: a send takes the shared lock, a change tries the exclusive lock without waiting. A test shows a consent change succeeds while a foreign-key-style lock on the project is held.
- **Guard refusal surfaced as a raw error.** It now maps to `FORBIDDEN`.
- **Guard branches untested.** Tests now cover a granter from another organization, a disabled approver, a project outside the organization, and a valid insert as the control role (which exercises the sequence grant).

Not fixed, and not fixable in the database as designed:
- **Who is connected.** The guard checks the recorded granter, not the connected person. Any control-role connection can name an approver's id. Closing this needs the application to pass the authenticated identity into the database session and the guard to check it. That is an application change still to decide.
- **Timing gap.** The guard reads the granter without a lock, so a demotion committing during the insert can still be missed. A row lock on users needs UPDATE privilege, which the control role must not have. The remedy is a consent-off row after a demotion. A migration that tried the lock was dropped before commit because it failed under the control role.
- **Skip path.** The 23505 skip after a concurrent retry is still not asserted deterministically; the race test allows zero skips. Removing the unique index does fail the race test (reviewer mutation).

Results: full suite 1529 pass, 0 fail. Typecheck, lint, gates, package validation and license pass.
