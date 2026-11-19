# Execution progress

All 25 work orders are implemented, each with a report in `evidence/<ID>/report.md`, CI green on its candidate SHA. Status suffixes state what was NOT verified live (`MOCK_ONLY`, `FAKE_CLI_BLOCKED_LIVE`, `SIMULATED_PROVIDER`, `INERT_BY_DEFAULT`). "Accepted by: operator (continue-plan instruction)" means the operator told the agent to continue the plan; it is NOT an independent code review. Open operator actions and known limits: `docs/operator/OPEN_ACTIONS.md`.

| Task | Status | Evidence | Accepted by |
|---|---|---|---|
| FND-001 | ACCEPTED | evidence/FND-001/report.md | operator (continue-plan instruction) |
| LIC-001 | ACCEPTED | evidence/LIC-001/report.md | operator (continue-plan instruction) |
| DOM-001 | ACCEPTED | evidence/DOM-001/report.md | operator (continue-plan instruction) |
| DB-001 | ACCEPTED | evidence/DB-001/report.md | operator (continue-plan instruction) |
| API-001 | ACCEPTED | evidence/API-001/report.md | operator (continue-plan instruction) |
| EVT-001 | ACCEPTED | evidence/EVT-001/report.md | operator (continue-plan instruction) |
| SCH-001 | ACCEPTED | evidence/SCH-001/report.md | operator (continue-plan instruction) |
| RUN-001 | ACCEPTED | evidence/RUN-001/report.md | operator (continue-plan instruction) |
| SCM-001 | ACCEPTED_MOCK_ONLY | evidence/SCM-001/report.md | operator (continue-plan instruction) |
| AGT-001 | ACCEPTED | evidence/AGT-001/report.md | operator (continue-plan instruction) |
| AGT-002 | ACCEPTED_FAKE_CLI_BLOCKED_LIVE | evidence/AGT-002/report.md | operator (continue-plan instruction) |
| AGT-003 | ACCEPTED_FAKE_CLI_BLOCKED_LIVE | evidence/AGT-003/report.md | operator (continue-plan instruction) |
| AGT-004 | ACCEPTED | evidence/AGT-004/report.md | operator (continue-plan instruction) |
| ORC-001 | ACCEPTED | evidence/ORC-001/report.md | operator (continue-plan instruction) |
| INT-001 | ACCEPTED | evidence/INT-001/report.md | operator (continue-plan instruction) |
| SPC-001 | ACCEPTED | evidence/SPC-001/report.md | operator (continue-plan instruction) |
| BLD-001 | ACCEPTED | evidence/BLD-001/report.md | operator (continue-plan instruction) |
| GAT-001 | ACCEPTED | evidence/GAT-001/report.md | operator (continue-plan instruction) |
| REV-001 | ACCEPTED | evidence/REV-001/report.md | operator (continue-plan instruction) |
| POL-001 | ACCEPTED | evidence/POL-001/report.md | operator (continue-plan instruction) |
| MRJ-001 | ACCEPTED_MOCK_GITHUB | evidence/MRJ-001/report.md | operator (continue-plan instruction) |
| OBS-001 | ACCEPTED | evidence/OBS-001/report.md | operator (continue-plan instruction) |
| CLD-001 | ACCEPTED_SIMULATED_PROVIDER_OPT_IN_OFF | evidence/CLD-001/report.md | operator (continue-plan instruction) |
| EVAL-001 | ACCEPTED | evidence/EVAL-001/report.md | operator (continue-plan instruction) |
| AUTO-001 | ACCEPTED_INERT_BY_DEFAULT | evidence/AUTO-001/report.md | operator (continue-plan instruction) |

## v2.1 Hardening & Operational Activation

Plan: `Unified_AI_Software_Factory_v2.1_Hardening_Operational_Activation.md` (auto-merge stays disabled). `IMPLEMENTED` is not `VERIFIED`; statuses are `not_started | in_progress | blocked | verified`.

```yaml
- work_package: ACT-01
  status: blocked   # local-engine path verified; provider terms + qualified builder missing
  baseline_commit: 298a60c  # v2.0 dev/auto-001 tip before v2.1 (history later rewritten; see git log)
  evidence: evidence/ACT-01/report.md
  blockers: [provider-terms approval, no role-qualified builder model]
```

```yaml
- work_package: ACT-04
  status: in_progress   # HTTP-level flow verified with a fake issuer; no real IdP, no browser E2E
  evidence: evidence/ACT-04/report.md
  blockers: [OIDC provider configuration, browser-level E2E]
```
