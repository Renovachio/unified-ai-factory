# Unified AI Software Factory

A Bun/TypeScript monorepo that takes a request through intake, spec, build, gates, review, policy and a guarded merge, with a human approving by default. All 25 work orders in `MASTER_PLAN.md` are implemented. Original implementation only; upstream source code is not included.

**Status: built and CI-green, not production-ready.** Nothing has run against a real GitHub App, subscription CLI, cloud provider or pilot data. The v2.3 `dispatch` command and its limits are described below. Per-task status and its caveats are in `PROGRESS.md`; open operator actions and known limits are in `docs/operator/OPEN_ACTIONS.md`. "Accepted" there means the operator told the agent to continue the plan, not that an independent human reviewed the code.

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
| `apps/dispatch-cli`, `packages/dispatch-core`, `packages/dispatch-client`, `apps/dispatch-menubar` | v2.3: the `dispatch` launcher/REPL, lifecycle and intent router, shared typed client + sync engine, optional macOS menu bar |
| `migrations/` | Reversible SQL migrations 0001-0014 |
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

## Dispatch (v2.3): one command
`dispatch` is the interaction and lifecycle layer over the factory (it is not a second orchestrator): the existing API, RBAC, approvals and job state machine stay authoritative.

```sh
bun install
bun scripts/package-dispatch.ts            # builds dist/dispatch-<ver>-darwin-arm64/ (+ .tar.gz, SHA256SUMS)
cd dist/dispatch-2.3.0-darwin-arm64 && ./install.sh   # no sudo; installs to ~/Library/Application Support/Dispatch, links ~/.local/bin/dispatch
dispatch doctor                            # read-only diagnosis
dispatch                                   # start or attach, open the dashboard, enter the prompt
```
Needs macOS (Apple silicon) and PostgreSQL 17 (`brew install postgresql@17`); Bun is not needed at run time. Dispatch runs its own private Postgres (unix socket only), the API and the dashboard, all on 127.0.0.1.

| Command | Meaning |
|---|---|
| `dispatch` / `--no-browser` | start or attach (idempotent, lock-protected), open the dashboard, enter the prompt |
| `dispatch <request>` / `/dispatch <request>` | same, plus create a new request in the active (or only) project |
| `dispatch --project <folder> [request]` / `/new <folder>` | use a folder on this machine as the project (GitHub is optional) |
| `dispatch start` / `status` / `doctor` | start missing services / report real health / diagnose without changing anything |
| `dispatch stop [--yes]` / `migrate` | stop only services Dispatch owns, warning about in-flight jobs / apply pending migrations explicitly |
| `/help /jobs /status /projects /project use /models /skills /agents /approvals /approve /pause /resume /cancel /logs /dashboard /context /exit /shutdown` | inside the prompt; `/exit` detaches and leaves jobs running |

Plain sentences work only for a fixed phrase set ("show my jobs", "list models"); anything else is refused until a qualified, authorized model interpreter exists (none does). Model output can only propose typed intents; destructive actions need a typed confirmation bound to the revision you saw.

**Pieces:** `packages/dispatch-core` (config, paths, process identity, lifecycle, intent router), `packages/dispatch-client` (typed client, SSE sync with cursor/dedupe/gap reconcile/backoff), `apps/dispatch-cli` (launcher + prompt), `apps/api/src/{local,dispatch}.ts` (local owner auth, one-time browser sign-in, snapshot/events/projects/approvals/capabilities views), dashboard pages (`/`, `/projects`, `/approvals`, `/models`, `/diagnostics`, `/logs`, `/help`), `apps/dispatch-menubar` (optional Swift menu bar), `scripts/{package-dispatch,dispatch-pilot}.ts`, `packaging/dispatch/`.

**Status:** local verification passed (`bun run ci`: 1236 tests, 0 failures; packaged install exercised from a clean shell). **Not released:** the real authorized coding pilot is BLOCKED (no configured runtime, qualified model, provider-terms approval, worker daemon or GitHub App), so no draft PR has been produced. Also unverified: a real browser/accessibility pass, a human TTY session, the menu-bar GUI; unsigned, macOS arm64 only, no launchd supervision. Per-task detail: `PROGRESS.md`, `evidence/DSP-01..10/report.md`. Docs: `docs/dispatch/{INSTALLATION,COMMANDS,OPERATIONS,SECURITY}.md`. Check pilot gates: `DISPATCH_HOME=... bun scripts/dispatch-pilot.ts`.

## Try it locally
`bun run demo` starts a throwaway Postgres, seeds **synthetic** data through the real API (one active skill, one awaiting approval, one rejected hostile archive, one improvement proposal), and serves the API on `127.0.0.1:8787` and the dashboard on `127.0.0.1:3000` (first page load compiles for ~30 s; add `--no-web` for the API only). Pick an identity at `http://127.0.0.1:8787/demo/login`, then open `/skills` and `/improvements`. The demo authenticator lives only in `scripts/demo.ts`, is loopback-only, and must never be reused in a deployment. `bun scripts/diagnostics.ts` (with `DATABASE_URL`) prints a redacted health snapshot.

## Before real use
See `docs/operator/OPEN_ACTIONS.md`: provider-terms decision, GitHub App, OIDC identity provider, evidence signing key, ratifying the proposed dependency approvals and the LGPL exception, and a real pilot.

## Authority
`SECURITY.md` and `AGENTS.md` are hard constraints. `CONTRACTS/` sets interface shapes. `TASKS/` sets work-order scope. `docs/BLUEPRINT_V1_1.md` and `ARCHITECTURE.md` are explanatory where not in conflict. If instructions disagree, stop and log an ADR; never weaken safeguards.
