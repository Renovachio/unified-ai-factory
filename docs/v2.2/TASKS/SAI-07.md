# SAI-07 — Skill and Agent Validation

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** v2.1 sandbox baseline; existing gates
**Target modules:** `packages/skills/validator; packages/checks extension`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Validate frontmatter schema, file references, licenses, dependencies, unsafe archives, secrets, executable content and outbound domains.
2. Use static scanning and gated dynamic tests in no-secrets/no-network sandbox; require explicit grants for additional resources.
3. Produce signed immutable validation report tied to digest, sandbox attestations, policy digest, tool versions and error codes.
4. Reject injection instructions that claim higher authority; deny model API invocation even when script disguises hostname.

## Deliverables
- Source implementation in `packages/skills/validator; packages/checks extension` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] Malicious archives and hidden model API calls are rejected.
- [ ] Safe skill validates only if required tools and scoped permissions are available.
- [ ] Changed package invalidates previous evidence and approvals.

## Required tests
- `T-03`
- `T-04`
- `T-06`
- `T-07`
- `T-10`

## Stop conditions
- Missing provider authorization, failed sandbox proof, invalid license, prohibited model API usage, unverified evaluation, or unavailable independent approval => **BLOCKED**, not completed.
- Do not weaken tests/policies, auto-activate candidates, or report mock tests as real integration.

## Completion evidence template
- Implementation commit / diff:
- Test commands and passing output:
- Security / inference routing proof:
- Approval and artifact digests (if applicable):
- Remaining limitations and next dependency:
