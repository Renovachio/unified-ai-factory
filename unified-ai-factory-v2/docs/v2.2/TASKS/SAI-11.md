# SAI-11 — Continuous Improvement Supervisor

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** SAI-04, SAI-08, SAI-09, SAI-10
**Target modules:** `packages/improvements/supervisor; apps/web improvement backlog`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Continuously ingest opted-in quality/defect/rework signals and map each to exact active skill/agent version and baseline.
2. Dedupe, rank and schedule improvement proposals by user impact, severity, frequency, confidence, reversibility and resources.
3. Coordinate candidate generation and isolated paired evaluations; retain experiment ledger, benchmark versions and independence of evaluator.
4. Prepare concise human approval package with before/after diff, confidence/limitations, security and licensing report, granted scopes and rollback rules.
5. After independently authorized activation, track outcome windows, drift, regressions and adoption; trigger *only* predefined deterministic disable/rollback actions when safe.
6. Keep supervisor identity explicitly denied approval/activation/policy/merge/benchmark-write capabilities; enforce with DB role + API RBAC + tests.

## Deliverables
- Source implementation in `packages/improvements/supervisor; apps/web improvement backlog` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] Supervisor autonomously detects a seeded quality regression and creates an evidence-backed proposal.
- [ ] It cannot approve, install, alter scope, adjust evaluation tests, or enable paid inference.
- [ ] Approval of exact digest by independent user promotes candidate atomically.
- [ ] Detected post-release regression disables or rolls back via approved deterministic policy, preserving audit; no new version enabled.

## Required tests
- `T-22`
- `T-23`
- `T-24`
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
