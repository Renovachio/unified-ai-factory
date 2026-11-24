# SAI-05 — Skill Creation in Quarantine

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** SAI-04, SAI-07 and SAI-08
**Target modules:** `packages/skills/creator; prompts/skill-candidate`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Create agent-compatible SKILL.md with concise triggers and imperative workflow plus optional references, scripts and examples.
2. Generate source-only candidate in an isolated working directory; perform syntax/reference/resource validation and require sandbox checks for scripts.
3. Maintain test examples for input/output, claims, edge cases, permission requirements and source provenance.
4. Submit immutable candidate and evidence to registry as AWAITING_APPROVAL; never write to live skill roots.

## Deliverables
- Source implementation in `packages/skills/creator; prompts/skill-candidate` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] A missing PM capability produces a valid candidate with provenance, tests and manifest.
- [ ] Scripts cannot execute outside quarantine in generation.
- [ ] No generated candidate is active before independent human approval.

## Required tests
- `T-06`
- `T-15`
- `T-24`

## Stop conditions
- Missing provider authorization, failed sandbox proof, invalid license, prohibited model API usage, unverified evaluation, or unavailable independent approval => **BLOCKED**, not completed.
- Do not weaken tests/policies, auto-activate candidates, or report mock tests as real integration.

## Completion evidence template
- Implementation commit / diff:
- Test commands and passing output:
- Security / inference routing proof:
- Approval and artifact digests (if applicable):
- Remaining limitations and next dependency:
