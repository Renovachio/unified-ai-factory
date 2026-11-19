# SAI-04 — Missing Capability and Quality Gap Analyzer

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** SAI-03; telemetry with privacy opt in
**Target modules:** `packages/capabilities/gaps; improvement signals API`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Detect uncovered requests, repeated validation failures, user correction patterns, low-quality outputs and missing tool integrations.
2. Group by normalized intent, current version, evidence digest and tenant; dedupe repeated events.
3. Distinguish missing skill, missing agent, missing connector, inadequate data, unqualified model and policy-blocked operation.
4. Recommend discovery, new skill, new agent, revised workflow or no action with confidence and cost/risk estimates.

## Deliverables
- Source implementation in `packages/capabilities/gaps; improvement signals API` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] Gap report includes representative evidence and never mislabels policy refusal as capability absence.
- [ ] Duplicate events do not flood improvement backlog.
- [ ] Only anonymized permitted telemetry is used.

## Required tests
- `T-14`
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
