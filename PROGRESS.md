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

```yaml
- work_package: ACT-05
  status: in_progress   # macOS-verified; Linux in CI only; deployment-level separation not provisioned
  evidence: evidence/ACT-05/report.md
  blockers: [per-component LOGIN roles and processes, Linux/cloud enforcement evidence]
```

```yaml
- work_package: ACT-06
  status: blocked   # mechanisms done; dataset too small (<30/role) and no qualified model
  evidence: evidence/ACT-06/report.md
  blockers: [dataset expansion + held-out split, candidate models, operator approval]
```

```yaml
- work_package: ACT-02
  status: blocked   # no qualified builder, provider terms, GitHub App or disposable repo
  evidence: evidence/ACT-02/report.md
```

```yaml
- work_package: ACT-03
  status: blocked   # no GitHub App / test repository; only a local fake GitHub was used
  evidence: evidence/ACT-03/report.md
```

```yaml
- work_package: ACT-07
  status: in_progress   # dead letter, diagnostics, CI watcher (fake port), crash test done; no live GitHub, no rebase, no backup/restore, no multi-process fault injection
  evidence: evidence/ACT-07/report.md
```

v2.1 release checklist: **NOT READY** (`evidence/V21-RELEASE/report.md`).

## v2.2 Product & Software Factory (SAI-01..SAI-11)

Spec in `docs/v2.2/`; branch `dev/v22-sai`. All new execution authority is inactive by default. v2.2 requires v2.1 gates before real use; they have not passed. Nothing is `verified`: implemented and tested locally (real Postgres, FS, HTTP handler), never exercised with a real provider, model, catalog, tracker or users. Details and the T-01..T-30 matrix: `evidence/SAI/report.md`.

```yaml
- work_package: SAI-01..SAI-11 + PM artifacts + API/UI
  status: in_progress
  evidence: evidence/SAI/report.md
  blockers: [v2.1 gates (NOT READY), no qualified model/runtime, benchmarks below minSamples, no dynamic skill sandbox tests, per-component LOGIN roles not provisioned, T-11/T-30 not live]
```

## v2.3 Dispatch (DSP-01..DSP-10)

Spec package: `../dispatch-v2.3`. Branch `dev/v23-dispatch` (on `dev/v22-sai`, which stacks on `dev/v21-act-01`; **nothing is merged to main**). Real authorized-runtime/GitHub gates (G0, G7) depend on v2.1, which is NOT READY (`evidence/V21-RELEASE/report.md`): no live model/provider/GitHub is available, so no real coding pilot has been run. Statuses: `not_started | in_progress | blocked | verified`; `verified` is used only where a check was actually run and its output is recorded in the evidence file.

```yaml
- work_package: DSP-01
  status: in_progress   # packaged install verified locally; real browser window not observed; unsigned; macOS arm64 only
  evidence: evidence/DSP-01/report.md
- work_package: DSP-02
  status: in_progress   # real-process lifecycle verified; no launchd; no worker daemon exists to manage
  evidence: evidence/DSP-02/report.md
- work_package: DSP-03
  status: in_progress   # all slash commands verified via piped stdin + real API; no human TTY session; /new blocked (no repo linking)
  evidence: evidence/DSP-03/report.md
- work_package: DSP-04
  status: in_progress   # router/validator/confirmations verified; no qualified model interpreter exists (fails closed)
  evidence: evidence/DSP-04/report.md
- work_package: DSP-05
  status: in_progress   # client+sync+feed verified against real API/Postgres; not embedded in browser pages
  evidence: evidence/DSP-05/report.md
- work_package: DSP-06
  status: in_progress   # terminal scope verified; no server-side session table, not shared with dashboard
  evidence: evidence/DSP-06/report.md
- work_package: DSP-07
  status: in_progress   # pages verified over HTTP from packaged install; no real-browser/a11y tool pass
  evidence: evidence/DSP-07/report.md
- work_package: DSP-08
  status: in_progress   # views/controls verified; capability approval + activation not run end to end
  evidence: evidence/DSP-08/report.md
- work_package: DSP-09
  status: in_progress   # P2; compiles, headless status verified; GUI not observed; no bundle/signing
  evidence: evidence/DSP-09/report.md
- work_package: DSP-10
  status: blocked       # all local checks pass (CI 1236/0); REAL authorized pilot blocked: no runtime, qualified model, provider terms, worker daemon or GitHub App
  evidence: evidence/DSP-10/report.md
  blockers: [no worker daemon, no qualified model/authorized runtime, no GitHub App, v2.1 gates NOT READY]
```

Local-folder projects (migration 0014, `/new <folder>`, `dispatch --project`) are implemented and tested; jobs on them still cannot run (no worker, and the SCM/PR flow is GitHub-only). Docs: `docs/dispatch/{INSTALLATION,COMMANDS,OPERATIONS,SECURITY}.md`. Package sha256 (darwin-arm64 tarball): `f7ccc285995d18087383a8acd003eeec5717f0b554776bb7f2fb2824b0e31eb0`.

Also fixed while verifying: a v2.2 idempotent-activation race (`packages/skills/src/registry.ts`), found by the full suite.
