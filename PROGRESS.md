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

Agent work on local folders (migrations 0015-0016, `dispatch code` in-place mode with snapshot, plan-scoped guard and per-wave leases, `dispatch work`, `dispatch mcp`, plugin `packaging/dispatch/claude-plugin`) is implemented and tested; the plugin, restricted launch, write guard and leases were verified live against a real Claude session on synthetic folders (`docs/dispatch/AGENTS.md`), but the Dispatch MCP tools and the full `dispatch work`/`dispatch code` flows were not: DSP-10 stays blocked until the operator records provider terms and a supervised first run is done. Local-folder projects (migration 0014, `/new <folder>`, `dispatch --project`) are implemented and tested; jobs on them still cannot run (no worker, and the SCM/PR flow is GitHub-only). Docs: `docs/dispatch/{INSTALLATION,COMMANDS,OPERATIONS,SECURITY}.md`. Package sha256 (darwin-arm64 tarball): `f7ccc285995d18087383a8acd003eeec5717f0b554776bb7f2fb2824b0e31eb0`.

Also fixed while verifying: a v2.2 idempotent-activation race (`packages/skills/src/registry.ts`), found by the full suite.

## v2.5 Adaptive Memory (MEM-01..MEM-08)

Spec: `unified-ai-factory-v2.5-memory/` (outside this repo). Branch `dev/mem-01`, stacked on `dev/v23-dispatch`; nothing is merged. Work is done one task at a time (AGENTS.md); later tasks wait for MEM-01 to be accepted.

```yaml
- work_package: MEM-01
  status: verified   # local checks only: 71 memory/db tests on real PostgreSQL 17, full suite 1354/0, lint, typecheck, package validation, license, gates lock. NOT independently reviewed; no pilot.
  commits: [a2b98c5, 64d3361]
  evidence: evidence/MEM-01/report.md
  blockers: [independent review (open by operator decision), real authorized pilot (open by operator decision); project access is organization-role only by operator decision]
- work_package: MEM-02
  status: verified   # local checks only: 92 memory/db tests, full suite 1375/0; deterministic extraction only (no model); consent is asserted by the caller. NOT independently reviewed; no pilot.
  commits: [85320ba]
  evidence: evidence/MEM-02/report.md
  blockers: [MEM-01 not accepted, independent review (open by operator decision), real authorized pilot (open by operator decision), per-participant consent workflow for real transcripts]
- work_package: MEM-03
  status: verified   # local checks only: lexical only (pgvector absent, semantic disclosed as disabled); 109 memory/db tests, full suite 1392/0; no quality benchmark. NOT independently reviewed; no pilot.
  commits: [bd95b4b]
  evidence: evidence/MEM-03/report.md
  blockers: [MEM-01/02 not accepted, independent review and pilot (open by operator decision), semantic retrieval off (pgvector 0.8.7 installed; no embedding model qualified in config/model-qualification.json), no retrieval quality benchmark (MEM-08)]
  followup: migration 0020 stems English and Portuguese (index version 2); see evidence/MEM-03/report.md
- work_package: MEM-04
  status: implemented   # local checks only: token estimate (no tokenizer), placeholder role caps, no runtime consumes packs yet; 16 context tests, full suite 1412/0; NOT independently reviewed; no pilot. Not called complete.
  evidence: evidence/MEM-04/report.md
  blockers: [independent review (open by operator decision), real authorized pilot (not run), no qualified tokenizer, role caps unbenchmarked, no worker entrypoint calls composeAgentExecutor, so memory is not active in any app]
  followup: rendered pack text stored (migration 0022); runtime loader resolveContextPack; opt-in roles spec and builder in packages/orchestrator/src/memory-context.ts; see evidence/MEM-04/report.md addendum
  followup2: composition root composeAgentExecutor (packages/orchestrator/src/agent-composition.ts), pack built for jobs.created_by, memory OFF unless DISPATCH_MEMORY_CONTEXT=1; end-to-end test through runOnce (5 tests). Still not active in any app: no worker entrypoint calls it; see evidence/MEM-04/report.md addendum 2; worker entrypoint stopped by default (DISPATCH_WORKER_ENABLE=1 required) and refuses to start while no runtime adapter is registered (addendum 3)
- work_package: MEM-05
  status: implemented_partial   # local checks only: consolidation with human approval and lineage, read-only review candidates; 15 consolidation tests, full suite 1449/0. NOT built: retention (needs operator policy), stale priority. Reversal built as restore after the consolidated memory ends (migration 0024). NOT independently reviewed; no pilot.
  evidence: evidence/MEM-05/report.md
  followup: restore after consolidation ended (migration 0024); independent review (tip 6f1296e) found DB gaps, fixed in migration 0025 (superseded_by and approved_by enforced, transition record required, consolidation links limited to consolidated memories); followup3: retention policy built (eraseMemoryText, runRetention); scheduler (runRetentionSweep, scripts/memory-retention.ts, cron documented) and conflict-driven erasure of approved memory (approveWithErasure, conflict rule) built; backup expiry runbook open; role-scoped run not verified; followup2: Option A applied (migration 0026): control role cannot write users; transition checks bind actor and from-status. Residual: control role can still name an existing approver in raw SQL (needs per-user DB identity or session-bound actor, a further decision). blockers: [login sessions moved to factory_login via create_auth_session (migration 0027; operator must set DATABASE_LOGIN_URL); approvals and approval_decisions written only by factory_approval (migration 0028; operator must set DATABASE_APPROVAL_URL for multi-user); product artifact approval guarded by trigger to factory_approval (migration 0029); separation is by connection, not process; fresh review of 0026 and 0027 open, retention policy not set by operator, pilot open, backup drill not run]
- work_package: MEM-06
  status: implemented_partial   # slice 1: retrieval feedback (migration 0031, packages/memory/src/feedback.ts), 8 tests; full suite 1509/0. wiring adapter to SAI-11 intake (orchestrator, role-scoped test as factory_control). NOT built: failure taxonomy, hypotheses, evaluation triggers, any app route or UI calling it, project consent setting, pilot (no authorized pilot project)
  evidence: evidence/MEM-06/report.md
- work_package: MEM-07
  status: not_started   # depends on MEM-01/03/05 and v2.4 browser UI (not present in this branch)
- work_package: MEM-08
  status: blocked       # release gate: needs a qualified runtime, a real authorized pilot and quality benchmarks; none exist (see DSP-10, EVAL-001)
  blockers: [no qualified model or authorized runtime, no authorized pilot project, v2.1 gates NOT READY]
```
