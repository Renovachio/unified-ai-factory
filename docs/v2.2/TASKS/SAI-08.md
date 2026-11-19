# SAI-08 — Immutable Registry, Approvals, Activation and Rollback

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** v2.1 auth, DB, outbox, RBAC
**Target modules:** `packages/skills/registry; packages/db migrations; apps/api approvals/activations`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Introduce immutable skill/agent versions and content-addressed artifact storage with tenant/workspace scopes.
2. Add approval request lifecycle bound to exact content digest, permissions digest, policy digest, evidence digest and expiry.
3. Implement separate human approver authentication and conflict-of-interest controls; activation uses transaction with CAS revision and idempotency.
4. Pin running jobs to exact approved version; support revoke, emergency disable, and rollback to last approved pinned version.

## Deliverables
- Source implementation in `packages/skills/registry; packages/db migrations; apps/api approvals/activations` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] No actor can self-approve executable package updates.
- [ ] Digest/permission mismatch, stale revision and expired evidence block activation.
- [ ] Rollback restores approved version with complete audit, no races.

## Required tests
- `T-07`
- `T-08`
- `T-09`
- `T-25`
- `T-26`
- `T-27`

## Stop conditions
- Missing provider authorization, failed sandbox proof, invalid license, prohibited model API usage, unverified evaluation, or unavailable independent approval => **BLOCKED**, not completed.
- Do not weaken tests/policies, auto-activate candidates, or report mock tests as real integration.

## Completion evidence template
- Implementation commit / diff:
- Test commands and passing output:
- Security / inference routing proof:
- Approval and artifact digests (if applicable):
- Remaining limitations and next dependency:
