# Unified AI Factory v2.5 — Adaptive Memory & Learning

**Status:** Agent-executable specification, **not implemented software**. Integrates additively with the browser-first v2.4 plan, v2.2 SAI-11, and existing PostgreSQL/orchestrator. This package must be reviewed against a fresh checkout before implementing.

## Goals
1. Retain valuable project, product and engineering knowledge with provenance and permission boundaries.
2. Cut repeated input context while maintaining or improving correctness.
3. Retrieve just-in-time, task-relevant memories and cite their source records.
4. Learn operationally from outcomes via qualified, gated changes—not automatic model-weight training or self-approval.
5. Keep existing inference rule: only qualified local/self-hosted models or official subscription CLIs where explicitly permitted; no metered inference APIs or paid fallback.

## Reading order
1. `PRODUCT_PLAN.md` — user experience and outcomes.
2. `ARCHITECTURE.md` — components, data flow, lifecycle, trust boundaries.
3. `AGENTS.md` — implementation agent instructions.
4. `SECURITY.md`, `EVALUATION.md`, `CONTRACTS/README.md`.
5. `TASKS/MEM-01.md` through `MEM-08.md` in dependency order.
6. `TESTS.md`, `ROLLOUT.md`, `PROGRESS.md`.

## Scope discipline
- **In scope:** memory ingestion, canonical record/index, controlled retrieval, consolidation, token-budgeted context packs, feedback, audit/delete and quality evaluation.
- **Out of scope:** replacing PostgreSQL, creating an autonomous memory superagent, model retraining, default cross-project/global memory sharing, unreviewed external data ingestion, and silently activating improved skills.
- **Existing v2.4 UX:** browser-first remains the primary interface, `dispatch` remains a lightweight launcher. Memory needs user-facing controls inside Settings and contextual provenance inside task views—not another standalone dashboard/application.

## Implementation sequence
MEM-01 schema/lifecycle → MEM-02 ingestion → MEM-03 hybrid retrieval → MEM-04 context builder → MEM-05 consolidation → MEM-06 feedback/SAI-11 → MEM-07 user controls → MEM-08 E2E/security/evals. Security/evaluation instrumentation begins in MEM-01, not at the end.

## Definition of done
A real authorized project can produce source-linked memories, retrieve them on a follow-up task, maintain factual quality against a full-context baseline, demonstrate reproducible input-token savings, keep separated projects isolated, handle stale/deleted evidence, and survive crash/restart. No production rollout until independent evidence and approval.
