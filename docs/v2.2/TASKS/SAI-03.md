# SAI-03 — Capability Matching and Agent Routing

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** SAI-08 registry, SAI-09 qualifications metadata
**Target modules:** `packages/capabilities/matcher; apps/api capabilities match`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Build structured task requirements by domain, desired artifacts, data access, autonomy, tools, permissions and quality.
2. Rank only approved, version-pinned, role-qualified compatible skills/agents using coverage, historical quality and permission fit.
3. Return explainable candidate choices, gaps, rejected alternatives and precise evidence/qualification version.
4. Compose multiple skills only if tool scopes intersect safely; never infer tool permission from skill text.

## Deliverables
- Source implementation in `packages/capabilities/matcher; apps/api capabilities match` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] A PM user-story request routes to an approved appropriate skill, with explanation.
- [ ] Unqualified, unapproved or incompatible entries are excluded.
- [ ] No supported route returns structured blocked state, not ad hoc inference downgrade.

## Required tests
- `T-12`
- `T-13`
- `T-28`

## Stop conditions
- Missing provider authorization, failed sandbox proof, invalid license, prohibited model API usage, unverified evaluation, or unavailable independent approval => **BLOCKED**, not completed.
- Do not weaken tests/policies, auto-activate candidates, or report mock tests as real integration.

## Completion evidence template
- Implementation commit / diff:
- Test commands and passing output:
- Security / inference routing proof:
- Approval and artifact digests (if applicable):
- Remaining limitations and next dependency:
