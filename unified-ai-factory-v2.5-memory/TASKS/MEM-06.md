# MEM-06 — Feedback, Analytics & SAI-11 Integration

**Priority:** P1  
**Status:** NOT STARTED (specification only)  
**Dependencies:** MEM-03/04/05 and implemented SAI-11 or isolated proposal interface

## Objective
Deliver feedback, analytics & sai-11 integration integrated with the **existing** factory, without creating a parallel persistence, orchestration or permission system.

## Implementation scope
Retrieval usefulness/quality events, failure taxonomies, improvement hypotheses and candidate evaluation triggers. Inspect current repo before deciding file paths. Add typed contracts, migration/rollback strategy where relevant, user-facing states where relevant, structured audit/telemetry and security checks. Use bounded jobs, retry and idempotency; preserve tenant/project ACL.

## Work sequence
1. Audit relevant existing code/schema and record reuse vs gap in `PROGRESS.md`.
2. Write failing tests and contract/schema validations for the behavior described here.
3. Implement minimal additive server and storage changes, reusing existing modules.
4. Integrate lifecycle, privilege policy, audit, error states and observable evidence.
5. Run unit/integration/adversarial tests. Do not call usage-billed model APIs.
6. Run representative real authorized pilot when prerequisites are available; otherwise mark blocked and do not call complete.
7. Independently review diff, migration risks and proof of acceptance.

## Mandatory tests
No self-activation, poisoned feedback, missing SAI-11 graceful degradation. Additionally verify unauthorized project access, revoked sources, prompt-injection-as-data, durable restart and no policy bypass wherever applicable.

## Acceptance criteria
- Evidence-based proposals only; activation always independent human approval.
- Clear failure states and no silent fallback to unqualified/paid model inference.
- New or modified state remains traceable, versioned and restart-safe.
- Tests, commands, commits, screenshots/API traces (if relevant) and risks recorded.

## Deliverables
Implementation diff, applicable migration and API/contract updates, automated tests, operator/user guidance, benchmark/security evidence and updated `PROGRESS.md`.

## Reviewer stop conditions
Stop activation on leakage, fabricated approval, missing source evidence, unsafe deletion, failed data migration or quality regression. Existing v2.1/v2.4 gates remain authoritative.
