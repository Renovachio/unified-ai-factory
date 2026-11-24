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
