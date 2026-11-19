# SAI-10 — Improvement Candidate Engine

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** SAI-04, SAI-05/06, SAI-09
**Target modules:** `packages/improvements/engine; candidate diff UI`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Ingest anonymized, permitted feedback from real tasks and evaluation failure records.
2. Form explicit falsifiable improvement hypotheses; propose one bounded change at a time to prompt, skill, workflow or agent manifest.
3. Generate candidate diff, versioned evaluation plan, expected benefit, risk and rollback criteria.
4. Ask independent evaluator to compare; submit recommendation with evidence, never modify the active skill itself.

## Deliverables
- Source implementation in `packages/improvements/engine; candidate diff UI` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] A recurring PRD omission produces a candidate with expected effect and observable acceptance metric.
- [ ] No test-time or production active mutation occurs prior to approved promotion.
- [ ] Non-improving candidates are rejected while preserving their evidence.

## Required tests
- `T-23`
- `T-24`
- `T-21`

## Stop conditions
- Missing provider authorization, failed sandbox proof, invalid license, prohibited model API usage, unverified evaluation, or unavailable independent approval => **BLOCKED**, not completed.
- Do not weaken tests/policies, auto-activate candidates, or report mock tests as real integration.

## Completion evidence template
- Implementation commit / diff:
- Test commands and passing output:
- Security / inference routing proof:
- Approval and artifact digests (if applicable):
- Remaining limitations and next dependency:
