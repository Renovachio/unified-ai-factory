# ADR-001 — SAI-11 has no promotion authority

**Status:** Proposed

## Context
A supervisor that can identify its own weaknesses and rewrite its active instructions can optimize its metrics by disabling tests, altering evaluation fixtures or broadening privileges.

## Decision
Separate improvement observability/orchestration from authority to approve/activate. The supervisor may create and reprioritize backlog proposals, request quarantined changes and independent evaluations, and report outcomes. Registry activation requires a human approver and a dedicated policy service. Emergency rollback/disable is deterministic, preauthorized, and cannot promote unseen versions. Enforce with distinct DB roles, API authorizations, and adversarial tests.

## Consequences
Improvement may need a human step and is not fully autonomous. Auditability, reproducibility and fail-closed behavior take priority.
