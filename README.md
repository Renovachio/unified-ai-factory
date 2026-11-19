# Unified AI Software Factory

A Bun/TypeScript monorepo that takes a request through intake, spec, build, gates, review, policy and a guarded merge, with a human approving by default. All 25 work orders in `MASTER_PLAN.md` are implemented. Original implementation only; upstream source code is not included.

**Status: built and CI-green, not production-ready.** Nothing has run against a real GitHub App, subscription CLI, cloud provider or pilot data. Per-task status and its caveats are in `PROGRESS.md`; open operator actions and known limits are in `docs/operator/OPEN_ACTIONS.md`. "Accepted" there means the operator told the agent to continue the plan, not that an independent human reviewed the code.

## Quick start
```sh
bun install
bun run ci        # validate package, license check, gates lock, lint, typecheck, tests, build
```
Requires Bun 1.4.4 and Postgres 17 (tests start a temporary cluster). Individual steps: `bun run lint`, `typecheck`, `test`, `build`, `license`, `gates:lock`, `validate:package`.

## Layout
| Path | Contents |
|---|---|
| `packages/domain` | Job state machine, transition guards, risk levels, policy types |
| `packages/db` | Drizzle schema, events/outbox, test database helper |
| `packages/scheduler` | Task queue with leases and fencing tokens |
| `packages/sandboxes` | macOS Seatbelt / Linux bubblewrap sandbox, cloud sandbox layer (off by default) |
| `packages/scm` | Trusted-side git candidates, GitHub App client, draft PRs, merge coordinator |
| `packages/runtimes` | Agent runtimes: mock, local model, subscription-CLI adapters (blocked by default) |
| `packages/orchestrator` | Durable job orchestrator, auto-merge controller |
| `packages/intake`, `agents`, `checks`, `contracts`, `telemetry`, `secrets`, `evals` | Intake classification, role agents and policy port, gates, shared schemas, redacting telemetry, secret broker, eval benchmark |
| `apps/api`, `apps/runner`, `apps/web` | HTTP API, worker, Next.js dashboard |
| `packages/skills`, `capabilities`, `improvements`, `product` | v2.2: skill/agent registry (quarantine, static validation, digest-bound approval, CAS activation), capability matcher and gap analysis, zero-authority improvement supervisor, PM artifacts |
| `migrations/` | Reversible SQL migrations 0001-0013 |
| `config/` | Inference policy, provider terms, risk policy, runtime allowlist, cloud, eval thresholds, gate manifests |
| `evidence/<ID>/` | Per-task acceptance report |
| `docs/` | Blueprint, ADRs, third-party notices, eval report, operator actions |

## Safe defaults that ship
- No model API keys or metered endpoints anywhere.
- Subscription CLIs (Claude Code, Codex) are disabled until a provider-terms approval is recorded in `config/provider-terms.json`.
- Cloud execution is off.
- Auto-merge: the global kill switch starts engaged, no repository is opted in, and the policy requires a human approval of the exact candidate SHA. HIGH and CRITICAL changes never merge unattended.
- The only real model measured (`qwen3.5:4b`) fails the quality thresholds (`docs/evals/REPORT.md`), so no route is eligible yet.

## v2.2 (inactive by default)
Skill/agent registry, paired evaluation, improvement supervisor and PM artifacts exist behind `/api/v2` and dashboard pages `/skills`, `/improvements`. No skill is active, all discovery sources are disabled, and the supervisor can only propose. v2.1 gates are NOT READY (`evidence/V21-RELEASE/report.md`); v2.2 status and gaps: `evidence/SAI/report.md`, operations: `docs/operator/SKILLS_AND_IMPROVEMENT.md`.

## Try it locally
`bun run demo` starts a throwaway Postgres, seeds **synthetic** data through the real API (one active skill, one awaiting approval, one rejected hostile archive, one improvement proposal), and serves the API on `127.0.0.1:8787` and the dashboard on `127.0.0.1:3000` (first page load compiles for ~30 s; add `--no-web` for the API only). Pick an identity at `http://127.0.0.1:8787/demo/login`, then open `/skills` and `/improvements`. The demo authenticator lives only in `scripts/demo.ts`, is loopback-only, and must never be reused in a deployment. `bun scripts/diagnostics.ts` (with `DATABASE_URL`) prints a redacted health snapshot.

## Before real use
See `docs/operator/OPEN_ACTIONS.md`: provider-terms decision, GitHub App, OIDC identity provider, evidence signing key, ratifying the proposed dependency approvals and the LGPL exception, and a real pilot.

## Authority
`SECURITY.md` and `AGENTS.md` are hard constraints. `CONTRACTS/` sets interface shapes. `TASKS/` sets work-order scope. `docs/BLUEPRINT_V1_1.md` and `ARCHITECTURE.md` are explanatory where not in conflict. If instructions disagree, stop and log an ADR; never weaken safeguards.
