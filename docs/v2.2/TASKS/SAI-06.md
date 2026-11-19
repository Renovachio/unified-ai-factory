# SAI-06 — Agent Definition and Creation

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** SAI-04, SAI-07, SAI-08
**Target modules:** `packages/agents/designer; manifests/agent`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Decide whether a new agent is justified versus a skill, workflow or tool adapter using criteria: durable goal, state, tools and nonoverlapping ownership.
2. Build an agent manifest with purpose, triggers, inputs, output schema, allowed skills/tools, data scope, timeout, failure behavior and human gates.
3. Keep authority least privilege; require separate permission review for external-write or credential-bearing tools.
4. Evaluate new agent against existing role baseline and submit exact-digest approval request, without activation.

## Deliverables
- Source implementation in `packages/agents/designer; manifests/agent` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] A reusable multi-step PM task may create a justified candidate agent.
- [ ] Single-use formatting task proposes a skill instead of an unnecessary agent.
- [ ] New agent cannot inherit administrator, policy or merge authority.

## Required tests
- `T-16`
- `T-22`

## Stop conditions
- Missing provider authorization, failed sandbox proof, invalid license, prohibited model API usage, unverified evaluation, or unavailable independent approval => **BLOCKED**, not completed.
- Do not weaken tests/policies, auto-activate candidates, or report mock tests as real integration.

## Completion evidence template
- Implementation commit / diff:
- Test commands and passing output:
- Security / inference routing proof:
- Approval and artifact digests (if applicable):
- Remaining limitations and next dependency:
