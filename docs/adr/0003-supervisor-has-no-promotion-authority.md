# ADR 0003 — The improvement supervisor has no promotion authority (v2.2 ADR-001)

**Status:** Accepted for implementation by operator instruction ("implement this new approach"); NOT independently reviewed.

## Context
A supervisor that can see its own weaknesses and rewrite its active instructions can optimise its metrics by disabling tests, altering benchmarks or widening privileges.

## Decision
Observability/orchestration is separated from authority. Enforced three ways, not one:
1. **Database role** `factory_supervisor` (migrations 0011/0012): read-only on registry, approvals, benchmarks and comparisons; may INSERT signals, proposals and the experiment ledger; UPDATE proposals only (a trigger rejects `approved`/`monitoring`/`accepted` when `current_user = 'factory_supervisor'`). No INSERT/UPDATE on approval requests/decisions, skill versions, the active registry, the registry log, rollback policies, benchmarks, comparisons, qualifications, users, integrations or merge tables. Its only write path to the registry is the `SECURITY DEFINER` function `registry_policy_disable`, which can only turn a version OFF under a rollback policy that two different humans created and approved, after a breach over the policy's minimum sample count. It can never enable or replace anything.
2. **API RBAC**: no API role can both request and decide; the supervisor has no API identity at all.
3. **Tests** (`packages/improvements/tests/supervisor.test.ts`) run the supervisor's own code under `SET ROLE factory_supervisor` and assert each denial, plus a source scan that its code has no network or model-inference surface.

Independent evaluation is a separate role (`factory_evaluator`) that alone writes comparisons; the grader must differ from both subjects.

## Consequences
Improvement needs a human step and is not autonomous. Deployment must create one LOGIN role per component and grant it exactly one of these NOLOGIN roles (the same open item as ACT-05); until then the separation is proven by tests, not by deployment.
