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
