# ADR 0002 — Subscription CLI adapters: provider-terms decision

Status: **DECISION RECORDED — NOT APPROVED. Adapters ship disabled.** (2026-11-19)

## Decision
The factory contains adapters for the official Claude Code and Codex command-line tools (`ClaudeCodeSubscriptionCliAdapter`,
`CodexSubscriptionCliAdapter`). **No provider-terms approval has been recorded**, so every probe and every run is refused with
`terms-not-approved`, and the CLI binary is not executed at all (not even `--version`) until an operator adds an approval to
`config/provider-terms.json`. This is enforced in code (`InferenceSourcePolicy`) and tested.

## Why the agent could not approve this
A subscription is not, by itself, evidence that the provider permits THIS automation pattern (unattended orchestration, a service
invoking the CLI on behalf of jobs, repository-driven prompts, concurrency, running on a shared machine). That is a legal/contractual
question about the provider's CURRENT terms and usage policies, which can change. The agent has no authority to accept terms on the
operator's behalf and did not attempt to interpret them.

## What an operator must do before enabling an adapter
1. Read the provider's current terms/usage policy for the exact product and plan and decide whether unattended, orchestrated CLI use
   is affirmatively permitted. If it is unclear or prohibited: do nothing — keep the adapter disabled and use the local-model adapter.
2. Record the decision in `config/provider-terms.json` (adapter id, provider, terms URL, date reviewed, approver, the exact scope
   approved, optional expiry). Re-review at the expiry date or whenever the terms change; an expired approval blocks the adapter again.
3. Allowlist the executable in `config/runtime-allowlist.json`: absolute path + version regex for the version(s) actually verified.
4. Verify the CLI's non-interactive flags for that version (the adapter's default argv is a starting point, marked UNVERIFIED), and supply
   an `authModeProbe` that confirms the CLI is logged in with a SUBSCRIPTION and not an API key / metered mode. Without it the adapter
   treats the mode as unknown and refuses to run.
5. Decide, with security review, whether the CLI's login state may be exposed read-only to the sandbox (`authStateDirs`). Doing so lets
   repository code that the CLI runs read those credentials; the adapter refuses unless `acknowledgeCredentialExposureRisk` is set.
6. Never place API keys, tokens or base-URL overrides in the worker environment: they are refused, and quota exhaustion never leads to
   one (see the router: pause, or fall back only to an operator-approved local runtime for roles the operator allowed).

## Consequences
- Until step 2 is done by a human, the factory can run only on the mock and local-model runtimes (AGT-001/AGT-004).
- Live end-to-end use of a subscription CLI has NOT been exercised or verified in this repository; tests use fake CLIs that behave like
  print-mode tools. The installed Claude Code version was read once (`--version`) for the operator's allowlist decision:
  `evidence/AGT-002/live-probe.json`.
- Codex CLI is not installed on the reference host; its adapter is covered by the same contract suite against a fake CLI.
