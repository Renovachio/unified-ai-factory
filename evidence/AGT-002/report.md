# AGT-002 evidence report

- **Status:** ACCEPTED_FAKE_CLI_BLOCKED_LIVE
- **Date:** 2026-11-19
- **Candidate SHA:** 7717e33af18c8c1fa3a6ee3950e108d9578b42bd (branch dev/agt-002)
- **GitHub CI on candidate SHA:** completed failure https://github.com/Renovachio/unified-ai-factory/actions/runs/44443954603
- **Test totals:**  804 pass  0 fail 
- **Accepted by:** operator, via instruction to continue following the plan to completion (2026-11-18); no separate human code review has occurred.

## Local commands (clean frozen install)
| Command | Exit |
|---|---|
| `bun install --frozen-lockfile` | 0 |
| `python3 scripts/validate_package.py` | 0 |
| `bun run license` | 0 |
| `bun run lint` | 0 |
| `bun run typecheck` | 0 |
| `bun test` | 0 |
| `bun run build` | 0 |

## Files changed in this task
- `apps/web/tsconfig.tsbuildinfo`
- `docs/adr/0002-subscription-cli-provider-terms-decision.md`
- `docs/third-party/provider-terms/README.md`
- `packages/runtimes/src/claude-code.ts`
- `packages/runtimes/src/cli.ts`
- `packages/runtimes/src/index.ts`
- `packages/runtimes/src/output.ts`
- `packages/runtimes/src/router.ts`
- `packages/runtimes/src/testing/contract-suite.ts`
- `packages/runtimes/tests/cli.test.ts`
- `packages/runtimes/tests/fake-cli.ts`
- `packages/sandboxes/src/process.ts`
- `scripts/live-cli-probe.ts`

## Notes
- **Provider-terms decision (documented): NOT APPROVED — the adapter ships DISABLED.** `docs/adr/0002-subscription-cli-provider-terms-decision.md` records that the agent cannot accept or interpret a provider's terms, lists exactly what an operator must do (record approval in `config/provider-terms.json`, allowlist executable+version, verify flags, supply an auth-mode probe, review credential-exposure), and `docs/third-party/provider-terms/README.md` is the operator register (all rows "NOT REVIEWED — BLOCKED").
- `SubscriptionCliAdapter` (`packages/runtimes/src/cli.ts`) + `ClaudeCodeSubscriptionCliAdapter`: **nothing executes — not even `--version` — until `InferenceSourcePolicy` passes**: no credential/billing/base-URL env vars, an unexpired provider-terms approval for THIS adapter, an allowlisted executable path and version, an operator-supplied `authModeProbe` returning "subscription" (unknown/api_key/missing => `not-authenticated`, "uncertain mode = block"), and no exposed CLI login state without an explicit risk acknowledgement. Probe results map to typed reasons (`terms-not-approved`, `not-installed`, `version-unsupported`, `not-authenticated`, `policy-violation`).
- Execution: the official CLI runs in the RUN-001 confinement sandbox with a SCRUBBED environment (host `ANTHROPIC_API_KEY`/`GITHUB_TOKEN` in the process env are provably absent from the CLI's env), prompt on STDIN (verified: argv contains only flags), JSON envelope parsed defensively then validated with the strict per-role schema bound to the candidate SHA, usage labelled `subscription_included`/`cli_reported`, timeout/cancel kill the process group, workspace outside the configured root refused. Usage-limit output => `agent.rate_limited` + `failureCode: rate-limited`.
- **Quota/fallback** (`routeRun`): approved candidates only; by default NO fallback (job pauses `quota-exhausted`); a role the operator listed may fall back to the next approved (local) runtime; `neverDowngradeRoles` always pauses instead; unavailable/terms-blocked runtimes are never run; there is no API/metered adapter in the codebase to fall back to (tested with a spy).
- **Same shared adapter contract suite** (12 tests) passes against this adapter using a fake print-mode CLI (`tests/fake-cli.ts`: ok/slow/fail/rate_limited/bad_output/wrong_sha/envdump/argvdump), plus terms-gate, API-key-injection (7 env vars; backend wrap counter proves nothing ran), scrubbed-env, stdin-not-argv, usage-label and fallback tests.
- **Real CLI evidence** (`bun scripts/live-cli-probe.ts claude-code <path>` -> `evidence/AGT-002/live-probe.json`): with the SHIPPED config the adapter probe returns `terms-not-approved` and the CLI is not executed; separately a harmless `--version` (no inference, no login state) reports the installed version `2.1.328 (Claude Code)` so an operator can decide what to allowlist. No live prompt was ever sent to the provider.
- Limits / blocked: **live subscription execution is BLOCKED pending the operator's terms decision**; the default argv (`-p --output-format json ...`) is unverified against the installed version; the auth-mode probe must be supplied by the operator; the real CLI's tool/permission behaviour inside the sandbox (it needs its login state) is unverified, as is behaviour of a tool-using builder via the CLI.
- Shared changes: `runSandboxed` gained `stdin` and `onOutput`; `extractJsonObject` shared helper.
- Next: AGT-003 (Codex adapter, same base).
