# AGT-003 evidence report

- **Status:** ACCEPTED_FAKE_CLI_BLOCKED_LIVE
- **Date:** 2026-11-19
- **Candidate SHA:** d8a80ef739ece455a96046f149d55e99dd024ff7 (branch dev/agt-003)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44445441805
- **Test totals:**  824 pass  0 fail 
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
- `packages/runtimes/src/cli.ts`
- `packages/runtimes/src/codex.ts`
- `packages/runtimes/src/index.ts`
- `packages/runtimes/tests/codex.test.ts`
- `packages/runtimes/tests/fake-cli.ts`

## Notes
- **Provider-terms decision (documented): NOT APPROVED — Codex adapter ships DISABLED**, recorded in the same ADR as AGT-002: `docs/adr/0002-subscription-cli-provider-terms-decision.md` + operator register `docs/third-party/provider-terms/README.md` (codex row: NOT REVIEWED — BLOCKED). Approvals are per adapter id (tested: an approval for `claude-code` does not enable `codex` and vice versa).
- `CodexSubscriptionCliAdapter` reuses `SubscriptionCliAdapter` (all fail-closed behaviour from AGT-002): policy gate BEFORE anything executes (terms, credential env, executable+version allowlist, auth-mode probe, credential-exposure acknowledgement), confinement sandbox with scrubbed env, prompt on stdin, strict SHA-bound output validation, timeout/cancel with process-group kill. Codex-specific: default argv (`exec --json --model <m> -`) and a defensive JSON-lines parser (`parseCodexOutput`: last message-like record is the model text, usage from the last usage-bearing event, non-JSON noise ignored). Both are UNVERIFIED against any installed Codex version and must be checked by the operator.
- **Same shared adapter contract suite** (12 tests) passes against this adapter using a fake JSONL-speaking CLI; plus: shipped config => blocked and the binary is never executed (backend wrap counter = 0); not-installed / unverified / API-key auth mode block even with an approval; 6 API-key/billing/base-URL variables (`OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, Azure/Bedrock variants...) refuse the adapter with nothing executed; usage labelled `subscription_included`/`cli_reported`; **rate limit => failed run + `agent.rate_limited`; router pauses by default and falls back ONLY to a separately APPROVED runtime for roles the operator permitted (an unapproved second CLI is never used)**; cancellation is prompt.
- Real-CLI evidence: **Codex CLI is not installed on the reference host** (`evidence/AGT-003/live-probe.json` records installed=false); therefore no real-binary smoke test was possible and none is claimed. Live execution is BLOCKED on (a) the operator's terms decision and (b) installing/verifying the CLI.
- Next: CLD-001.
