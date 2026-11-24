# Instructions for the Implementation Agent

**Role:** Senior backend/data architect and product engineer implementing Adaptive Memory v2.5 into the existing Unified AI Factory. **Boundary:** You can propose changes and produce code/tests in an isolated branch, but cannot approve your own merge, alter policy, or claim integration readiness without evidence.

## Preparation
1. Inspect actual repository checkout and version, current v2.1 runtime gate state, v2.2 SAI-11 implementation state, v2.4 UX implementation, ORM, auth, job state, storage and data contracts.
2. Read `README.md`, `PRODUCT_PLAN.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `SECURITY.md`, `EVALUATION.md`, `ROLLOUT.md`, `TESTS.md`.
3. Record a **reuse/gap matrix**. Do not recreate any current projects, approvals, knowledge graph, artifact store or telemetry tables. Do not presume all planned features exist.
4. Create task-specific implementation branches/worktrees, smallest coherent vertical slices, and migration/rollback review.

## Execution
Implement `TASKS/MEM-01.md` → `MEM-08.md` in dependency order. Security and evaluation tests are ongoing, not postponed. For each work order produce: changed paths, database migration notes, tests, command outputs, screenshots/API traces if UI, security checks, evidence, git commit, blockers and known limitations. Update `PROGRESS.md` truthfully after each mergeable stage.

## Hard invariants
- Preserve existing PostgreSQL as authoritative state and existing orchestrator ownership; no new separate superagent or duplicate scheduler.
- No cross-project sharing by default; enforce permissions server-side before memory retrieval and before context packaging.
- Never promote unverified source content to approved requirement; memory cannot issue privileged instructions.
- Memory may suggest candidate improvements, but all production activation remains under independent approval and original SAI-11 governance.
- No paid/metered AI inference APIs, token-priced endpoints, unofficial CLI token bridges or automatic paid fallbacks.
- Protect privacy, encryption, retention, tombstones, index invalidation and user review controls.
- Use deterministic code for metric/token accounting wherever possible; disclose unavailable usage metrics.
- Never confuse tests against fixtures with live end-to-end production verification.

## Stop / escalate
If the actual repository violates a stated design assumption, document it and propose a minimal safe adaptation. Stop activation if provider authorization, isolation, migration safety, ACL test or quality noninferiority gate is unverified. Continue documentation/tests that do not require that blocked capability.

## Completion evidence
A fresh install can run a real authorized project task, persist source-linked memory, retrieve it later, show memory provenance in the browser, protect deleted and revoked sources, benchmark quality and token usage against baseline, and create (not auto-activate) an SAI-11 improvement proposal. Provide reproducible commands and independent reviewer report.


---

# Work Orders


---

# MEM-01 — Canonical Memory Schema & Lifecycle

**Priority:** P0  
**Status:** NOT STARTED (specification only)  
**Dependencies:** Existing PostgreSQL, authorization and migration conventions

## Objective
Deliver canonical memory schema & lifecycle integrated with the **existing** factory, without creating a parallel persistence, orchestration or permission system.

## Implementation scope
Additive canonical record/source tables, status transitions, indexes, audit/outbox integration. Inspect current repo before deciding file paths. Add typed contracts, migration/rollback strategy where relevant, user-facing states where relevant, structured audit/telemetry and security checks. Use bounded jobs, retry and idempotency; preserve tenant/project ACL.

## Work sequence
1. Audit relevant existing code/schema and record reuse vs gap in `PROGRESS.md`.
2. Write failing tests and contract/schema validations for the behavior described here.
3. Implement minimal additive server and storage changes, reusing existing modules.
4. Integrate lifecycle, privilege policy, audit, error states and observable evidence.
5. Run unit/integration/adversarial tests. Do not call usage-billed model APIs.
6. Run representative real authorized pilot when prerequisites are available; otherwise mark blocked and do not call complete.
7. Independently review diff, migration risks and proof of acceptance.

## Mandatory tests
DB integration and unauthorized status change tests. Additionally verify unauthorized project access, revoked sources, prompt-injection-as-data, durable restart and no policy bypass wherever applicable.

## Acceptance criteria
- Migration preserves old data; immutable approved/provenance versioning; no duplicate existing entities.
- Clear failure states and no silent fallback to unqualified/paid model inference.
- New or modified state remains traceable, versioned and restart-safe.
- Tests, commands, commits, screenshots/API traces (if relevant) and risks recorded.

## Deliverables
Implementation diff, applicable migration and API/contract updates, automated tests, operator/user guidance, benchmark/security evidence and updated `PROGRESS.md`.

## Reviewer stop conditions
Stop activation on leakage, fabricated approval, missing source evidence, unsafe deletion, failed data migration or quality regression. Existing v2.1/v2.4 gates remain authoritative.


---

# MEM-02 — Evidence-Based Ingestion & Extraction

**Priority:** P0  
**Status:** NOT STARTED (specification only)  
**Dependencies:** MEM-01; existing event and artifact storage

## Objective
Deliver evidence-based ingestion & extraction integrated with the **existing** factory, without creating a parallel persistence, orchestration or permission system.

## Implementation scope
Ingest approved source events; generate typed candidate claims; redact secrets; link spans/digests; consent checks. Inspect current repo before deciding file paths. Add typed contracts, migration/rollback strategy where relevant, user-facing states where relevant, structured audit/telemetry and security checks. Use bounded jobs, retry and idempotency; preserve tenant/project ACL.

## Work sequence
1. Audit relevant existing code/schema and record reuse vs gap in `PROGRESS.md`.
2. Write failing tests and contract/schema validations for the behavior described here.
3. Implement minimal additive server and storage changes, reusing existing modules.
4. Integrate lifecycle, privilege policy, audit, error states and observable evidence.
5. Run unit/integration/adversarial tests. Do not call usage-billed model APIs.
6. Run representative real authorized pilot when prerequisites are available; otherwise mark blocked and do not call complete.
7. Independently review diff, migration risks and proof of acceptance.

## Mandatory tests
Source fixtures, prompt-injection, redaction and duplicate-event tests. Additionally verify unauthorized project access, revoked sources, prompt-injection-as-data, durable restart and no policy bypass wherever applicable.

## Acceptance criteria
- No unsourced approved memory; proposed meeting notes stay proposed; idempotent writes.
- Clear failure states and no silent fallback to unqualified/paid model inference.
- New or modified state remains traceable, versioned and restart-safe.
- Tests, commands, commits, screenshots/API traces (if relevant) and risks recorded.

## Deliverables
Implementation diff, applicable migration and API/contract updates, automated tests, operator/user guidance, benchmark/security evidence and updated `PROGRESS.md`.

## Reviewer stop conditions
Stop activation on leakage, fabricated approval, missing source evidence, unsafe deletion, failed data migration or quality regression. Existing v2.1/v2.4 gates remain authoritative.


---

# MEM-03 — Hybrid Search & Scoped Retrieval

**Priority:** P0  
**Status:** NOT STARTED (specification only)  
**Dependencies:** MEM-01/02; database full text; optional pgvector qualification

## Objective
Deliver hybrid search & scoped retrieval integrated with the **existing** factory, without creating a parallel persistence, orchestration or permission system.

## Implementation scope
Keyword retrieval, optional versioned embeddings, ranking and double ACL checks; status/time filtering. Inspect current repo before deciding file paths. Add typed contracts, migration/rollback strategy where relevant, user-facing states where relevant, structured audit/telemetry and security checks. Use bounded jobs, retry and idempotency; preserve tenant/project ACL.

## Work sequence
1. Audit relevant existing code/schema and record reuse vs gap in `PROGRESS.md`.
2. Write failing tests and contract/schema validations for the behavior described here.
3. Implement minimal additive server and storage changes, reusing existing modules.
4. Integrate lifecycle, privilege policy, audit, error states and observable evidence.
5. Run unit/integration/adversarial tests. Do not call usage-billed model APIs.
6. Run representative real authorized pilot when prerequisites are available; otherwise mark blocked and do not call complete.
7. Independently review diff, migration risks and proof of acceptance.

## Mandatory tests
Cross-project canaries, stale index, hybrid recall and vector version tests. Additionally verify unauthorized project access, revoked sources, prompt-injection-as-data, durable restart and no policy bypass wherever applicable.

## Acceptance criteria
- Zero ACL leakage; semantic optional; safe lexical-only fallback.
- Clear failure states and no silent fallback to unqualified/paid model inference.
- New or modified state remains traceable, versioned and restart-safe.
- Tests, commands, commits, screenshots/API traces (if relevant) and risks recorded.

## Deliverables
Implementation diff, applicable migration and API/contract updates, automated tests, operator/user guidance, benchmark/security evidence and updated `PROGRESS.md`.

## Reviewer stop conditions
Stop activation on leakage, fabricated approval, missing source evidence, unsafe deletion, failed data migration or quality regression. Existing v2.1/v2.4 gates remain authoritative.


---

# MEM-04 — Token-Aware Context Assembly

**Priority:** P0  
**Status:** NOT STARTED (specification only)  
**Dependencies:** MEM-03; current model router and context interface

## Objective
Deliver token-aware context assembly integrated with the **existing** factory, without creating a parallel persistence, orchestration or permission system.

## Implementation scope
Budget allocator, selection manifests, citations, source pinning and staged expansion. Inspect current repo before deciding file paths. Add typed contracts, migration/rollback strategy where relevant, user-facing states where relevant, structured audit/telemetry and security checks. Use bounded jobs, retry and idempotency; preserve tenant/project ACL.

## Work sequence
1. Audit relevant existing code/schema and record reuse vs gap in `PROGRESS.md`.
2. Write failing tests and contract/schema validations for the behavior described here.
3. Implement minimal additive server and storage changes, reusing existing modules.
4. Integrate lifecycle, privilege policy, audit, error states and observable evidence.
5. Run unit/integration/adversarial tests. Do not call usage-billed model APIs.
6. Run representative real authorized pilot when prerequisites are available; otherwise mark blocked and do not call complete.
7. Independently review diff, migration risks and proof of acceptance.

## Mandatory tests
Budget edge cases, token accounting, model role and overlong prompts. Additionally verify unauthorized project access, revoked sources, prompt-injection-as-data, durable restart and no policy bypass wherever applicable.

## Acceptance criteria
- Bounded packs with provenance, zero privileged instructions inherited from memories.
- Clear failure states and no silent fallback to unqualified/paid model inference.
- New or modified state remains traceable, versioned and restart-safe.
- Tests, commands, commits, screenshots/API traces (if relevant) and risks recorded.

## Deliverables
Implementation diff, applicable migration and API/contract updates, automated tests, operator/user guidance, benchmark/security evidence and updated `PROGRESS.md`.

## Reviewer stop conditions
Stop activation on leakage, fabricated approval, missing source evidence, unsafe deletion, failed data migration or quality regression. Existing v2.1/v2.4 gates remain authoritative.


---

# MEM-05 — Consolidation, Supersession & Retention

**Priority:** P1  
**Status:** NOT STARTED (specification only)  
**Dependencies:** MEM-01/02/03; retention/security policy

## Objective
Deliver consolidation, supersession & retention integrated with the **existing** factory, without creating a parallel persistence, orchestration or permission system.

## Implementation scope
Versioned summaries, dedup/contradiction rules, stale priority and reversible lineage. Inspect current repo before deciding file paths. Add typed contracts, migration/rollback strategy where relevant, user-facing states where relevant, structured audit/telemetry and security checks. Use bounded jobs, retry and idempotency; preserve tenant/project ACL.

## Work sequence
1. Audit relevant existing code/schema and record reuse vs gap in `PROGRESS.md`.
2. Write failing tests and contract/schema validations for the behavior described here.
3. Implement minimal additive server and storage changes, reusing existing modules.
4. Integrate lifecycle, privilege policy, audit, error states and observable evidence.
5. Run unit/integration/adversarial tests. Do not call usage-billed model APIs.
6. Run representative real authorized pilot when prerequisites are available; otherwise mark blocked and do not call complete.
7. Independently review diff, migration risks and proof of acceptance.

## Mandatory tests
Conflicting requirements, source revocation, consolidation and backup tests. Additionally verify unauthorized project access, revoked sources, prompt-injection-as-data, durable restart and no policy bypass wherever applicable.

## Acceptance criteria
- Never overwrite authoritative history; no automatic invented approval.
- Clear failure states and no silent fallback to unqualified/paid model inference.
- New or modified state remains traceable, versioned and restart-safe.
- Tests, commands, commits, screenshots/API traces (if relevant) and risks recorded.

## Deliverables
Implementation diff, applicable migration and API/contract updates, automated tests, operator/user guidance, benchmark/security evidence and updated `PROGRESS.md`.

## Reviewer stop conditions
Stop activation on leakage, fabricated approval, missing source evidence, unsafe deletion, failed data migration or quality regression. Existing v2.1/v2.4 gates remain authoritative.


---

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


---

# MEM-07 — Browser Memory Controls & Transparency

**Priority:** P1  
**Status:** NOT STARTED (specification only)  
**Dependencies:** MEM-01/03/05, v2.4 browser auth/navigation

## Objective
Deliver browser memory controls & transparency integrated with the **existing** factory, without creating a parallel persistence, orchestration or permission system.

## Implementation scope
Project Memory & Evidence, included-context pane, review/correct/suppress/delete/export controls. Inspect current repo before deciding file paths. Add typed contracts, migration/rollback strategy where relevant, user-facing states where relevant, structured audit/telemetry and security checks. Use bounded jobs, retry and idempotency; preserve tenant/project ACL.

## Work sequence
1. Audit relevant existing code/schema and record reuse vs gap in `PROGRESS.md`.
2. Write failing tests and contract/schema validations for the behavior described here.
3. Implement minimal additive server and storage changes, reusing existing modules.
4. Integrate lifecycle, privilege policy, audit, error states and observable evidence.
5. Run unit/integration/adversarial tests. Do not call usage-billed model APIs.
6. Run representative real authorized pilot when prerequisites are available; otherwise mark blocked and do not call complete.
7. Independently review diff, migration risks and proof of acceptance.

## Mandatory tests
Browser accessibility, CSRF/ACL, retention and deletion propagation E2E. Additionally verify unauthorized project access, revoked sources, prompt-injection-as-data, durable restart and no policy bypass wherever applicable.

## Acceptance criteria
- Ordinary user can inspect and correct memory with no SQL/terminal.
- Clear failure states and no silent fallback to unqualified/paid model inference.
- New or modified state remains traceable, versioned and restart-safe.
- Tests, commands, commits, screenshots/API traces (if relevant) and risks recorded.

## Deliverables
Implementation diff, applicable migration and API/contract updates, automated tests, operator/user guidance, benchmark/security evidence and updated `PROGRESS.md`.

## Reviewer stop conditions
Stop activation on leakage, fabricated approval, missing source evidence, unsafe deletion, failed data migration or quality regression. Existing v2.1/v2.4 gates remain authoritative.


---

# MEM-08 — Benchmarks, Shadow Mode, Security & Rollout

**Priority:** P0 release gate  
**Status:** NOT STARTED (specification only)  
**Dependencies:** MEM-01–07, qualified runtime and operational v2.4 gates

## Objective
Deliver benchmarks, shadow mode, security & rollout integrated with the **existing** factory, without creating a parallel persistence, orchestration or permission system.

## Implementation scope
Reproducible baseline-vs-memory experiments, shadow metrics, rollout flags and rollback drills. Inspect current repo before deciding file paths. Add typed contracts, migration/rollback strategy where relevant, user-facing states where relevant, structured audit/telemetry and security checks. Use bounded jobs, retry and idempotency; preserve tenant/project ACL.

## Work sequence
1. Audit relevant existing code/schema and record reuse vs gap in `PROGRESS.md`.
2. Write failing tests and contract/schema validations for the behavior described here.
3. Implement minimal additive server and storage changes, reusing existing modules.
4. Integrate lifecycle, privilege policy, audit, error states and observable evidence.
5. Run unit/integration/adversarial tests. Do not call usage-billed model APIs.
6. Run representative real authorized pilot when prerequisites are available; otherwise mark blocked and do not call complete.
7. Independently review diff, migration risks and proof of acceptance.

## Mandatory tests
Adversarial T01–T30, noninferiority, cost, token, real end-to-end trials. Additionally verify unauthorized project access, revoked sources, prompt-injection-as-data, durable restart and no policy bypass wherever applicable.

## Acceptance criteria
- No rollout without quality and security gates, true performance evidence and approval.
- Clear failure states and no silent fallback to unqualified/paid model inference.
- New or modified state remains traceable, versioned and restart-safe.
- Tests, commands, commits, screenshots/API traces (if relevant) and risks recorded.

## Deliverables
Implementation diff, applicable migration and API/contract updates, automated tests, operator/user guidance, benchmark/security evidence and updated `PROGRESS.md`.

## Reviewer stop conditions
Stop activation on leakage, fabricated approval, missing source evidence, unsafe deletion, failed data migration or quality regression. Existing v2.1/v2.4 gates remain authoritative.


---

# Copy/Paste Prompt for Coding Agent

Implement the attached Unified AI Factory v2.5 Adaptive Memory package **additively** in the currently checked-out repository.

First audit the real codebase and existing v2.1/v2.2/v2.4 implementation against `README.md`, `PRODUCT_PLAN.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `SECURITY.md`, `EVALUATION.md`, `AGENTS.md` and all `TASKS/MEM-xx.md`. Create a truthful gap/reuse matrix; do not duplicate functionality or assume that previous engineering specifications have already been implemented.

Proceed by implementing MEM-01 through MEM-08, respecting dependencies and blocking security gates. Use existing PostgreSQL, ORM/migrations, orchestrator, API auth, event bus, artifact store and browser UI. Build source-linked, permission-scoped canonical memory; conservative extraction; hybrid retrieval; bounded context packs; traceable consolidation; feedback/SAI-11 proposals; visible correction/delete controls; and measured quality/token evaluation. Implement deterministic and adversarial tests. Preserve v2.4 localhost/browser security and subscription-or-qualified-local-only inference restrictions. Do not introduce metered AI APIs.

For each task report exact files, commits, test commands/output, baseline comparison, security evidence, known gaps. Never claim a workflow completed unless it was validated with a real permitted runtime and source-grounded evidence. Do not self-approve agent/skill improvements or merge high-impact changes.

The product must demonstrate fewer repeated context tokens **without worse factual or task quality**; if the evaluation does not demonstrate that, block activation and report why.
