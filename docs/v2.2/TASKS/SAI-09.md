# SAI-09 — Versioned, Role-Specific Quality Evaluator

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** SAI-07, SAI-08; existing evals
**Target modules:** `packages/evals extension; fixtures/pm; eval comparison UI`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Create versioned benchmarks for PM meetings, research, PRD, story acceptance, analytics and engineering security roles.
2. Run current approved baseline and candidate on identical fixtures/settings, with hidden holdout not available to generator.
3. Combine deterministic format/provenance tests, rubric-based independent review and task outcomes; report uncertainty and sample size.
4. Stop promotion for critical safety regressions, missing role threshold, invalid data provenance or unsupported provider runtime.

## Deliverables
- Source implementation in `packages/evals extension; fixtures/pm; eval comparison UI` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] Comparison includes same benchmark digest, quality metrics, critical failures and evaluation limitations.
- [ ] Candidate cannot edit grader/holdout.
- [ ] Insufficient confidence blocks approval recommendation, even for apparent improvement.

## Required tests
- `T-20`
- `T-21`
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
