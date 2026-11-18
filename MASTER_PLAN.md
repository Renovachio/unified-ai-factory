# Execution plan

## Workflow
For each task: ensure dependencies accepted → branch → implement → tests → evidence → peer/operator review → mark accepted. Each task has objective gates in `TASKS/`. Treat task lists as required deliverables, not implementation already present.

## Milestone sequence
- M0: FND-001, LIC-001
- M1: DOM-001, DB-001, API-001, EVT-001, SCH-001, AGT-001, ORC-001
- M2: RUN-001, SCM-001
- M3: AGT-002, AGT-003, AGT-004, INT-001, SPC-001, BLD-001, GAT-001, REV-001
- M4: POL-001, MRJ-001, OBS-001
- M5 (opt-in): CLD-001, EVAL-001, AUTO-001

M0–M4 must be proven end-to-end with mock and at least one allowed real runtime. M5 must remain disabled by default. Task ordering may topologically interleave provided dependencies hold.

## Agent-facing task index
- [FND-001](TASKS/FND-001.md) — Workspace, lint/test/build CI; depends on —
- [LIC-001](TASKS/LIC-001.md) — provenance/allowlist/license gate; depends on FND-001
- [DOM-001](TASKS/DOM-001.md) — domain entities + state transition matrix; depends on FND-001
- [DB-001](TASKS/DB-001.md) — Postgres schema + migrations; depends on DOM-001
- [API-001](TASKS/API-001.md) — auth, RBAC, job creation and idempotency; depends on DB-001
- [EVT-001](TASKS/EVT-001.md) — event log/outbox/SSE; depends on DB-001
- [SCH-001](TASKS/SCH-001.md) — lease/fencing scheduler; depends on DB-001
- [RUN-001](TASKS/RUN-001.md) — local worker and workspace sandbox; depends on SCH-001
- [SCM-001](TASKS/SCM-001.md) — GitHub App and PR creation; depends on RUN-001
- [AGT-001](TASKS/AGT-001.md) — typed adapter contract + mock; depends on DOM-001
- [AGT-002](TASKS/AGT-002.md) — Claude Code subscription CLI adapter; depends on AGT-001,RUN-001
- [AGT-003](TASKS/AGT-003.md) — Codex subscription CLI adapter; depends on AGT-001,RUN-001
- [AGT-004](TASKS/AGT-004.md) — Local model adapter; depends on AGT-001,RUN-001
- [ORC-001](TASKS/ORC-001.md) — orchestrator with stage persistence; depends on EVT-001,SCH-001,AGT-001
- [INT-001](TASKS/INT-001.md) — safe intake and acceptance criteria; depends on ORC-001
- [SPC-001](TASKS/SPC-001.md) — analysis, architecture, specification; depends on INT-001
- [BLD-001](TASKS/BLD-001.md) — build/rework and candidate SHA storage; depends on SPC-001,SCM-001
- [GAT-001](TASKS/GAT-001.md) — locked deterministic gate engine; depends on BLD-001
- [REV-001](TASKS/REV-001.md) — risk-routed independent reviewers; depends on GAT-001
- [POL-001](TASKS/POL-001.md) — risk and merge-policy engine; depends on REV-001
- [MRJ-001](TASKS/MRJ-001.md) — exact-head approval and merge coordinator; depends on POL-001,SCM-001
- [OBS-001](TASKS/OBS-001.md) — dashboard, audit, subscription/local usage and tracing; depends on ORC-001
- [CLD-001](TASKS/CLD-001.md) — cloud sandbox provider; depends on MRJ-001,RUN-001
- [EVAL-001](TASKS/EVAL-001.md) — role/model quality benchmarking; depends on AGT-002,AGT-003,AGT-004
- [AUTO-001](TASKS/AUTO-001.md) — opt-in low-risk merge policies; depends on EVAL-001,MRJ-001
