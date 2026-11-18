# Unified AI Software Factory — Agent Implementation Package v2.0

This is an **implementation specification and task execution scaffold**, not a functioning factory. Read `AGENTS.md`, then `MASTER_PLAN.md`, then the selected `TASKS/<ID>.md`. Original implementation only; upstream source code is not included.

## Start here
1. Install an approved toolchain on the target host. Confirm provider subscription automation terms before using any subscription CLI. No paid model inference, API keys or metered endpoints.
2. Read `docs/BLUEPRINT_V1_1.md`, `ARCHITECTURE.md`, `SECURITY.md`, and `CONTRACTS/README.md`.
3. Run `python3 scripts/validate_package.py` to verify package consistency (standard library only).
4. Implement `FND-001`, followed by the dependencies listed in `MASTER_PLAN.md`. Run the acceptance commands for the current task. Record outputs in `evidence/<TASK-ID>/` and update `PROGRESS.md`.
5. Remain on a development branch; no unattended merges or deployments during the pilot.

## Authority
`SECURITY.md` and `AGENTS.md` are hard constraints. `CONTRACTS/` sets interface shapes. `TASKS/` sets work-order scope. The blueprint is explanatory where not in conflict. If instructions disagree, stop and log an ADR: never weaken safeguards.

## Status
Specification-ready for supervised execution; application not yet implemented or tested. Provider CLI compatibility and legal reuse permission require operator verification.
