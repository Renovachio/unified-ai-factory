# Open operator actions and known limits

The build phases were implemented and accepted **on the strength of an instruction to proceed, not of an independent human review**. Treat acceptance as "built, tested, CI-green", not as "reviewed for production". Nothing here has run against a real GitHub App, a real subscription CLI, a real cloud provider, or real pilot data.

## Needs a human decision or credentials (blocking real use)
1. **Provider terms** (AGT-002/AGT-003): no approval recorded, so the Claude Code / Codex adapters are DISABLED. Follow `docs/adr/0002-subscription-cli-provider-terms-decision.md`. Until then only the mock and local-model runtimes can run.
2. **GitHub App** (SCM-001/MRJ-001): create the App (contents + pull_requests write on a dedicated test repository; separate `merge` use), provide app id, private key, installation id and webhook secret. Live draft-PR and merge verification has NOT been done — everything was verified against a local fake GitHub over real HTTP. Do not use `Renovachio/unified-ai-factory` itself as the test target without approval.
3. **OIDC identity provider** (API-001/OBS-001): the API verifies bearer tokens and session cookies, but there is no login/callback flow in the dashboard; it cannot log anyone in yet.
4. **Gate evidence signing key** (GAT-001): generate an Ed25519 key pair, keep the private key with the trusted gate service only, give the public key to the merge coordinator. Test keys are ephemeral.
5. **Dependency approvals** (LIC-001): every direct dependency in `licenses/allowlist.yaml` is labelled "PROPOSED by agent - operator ratification pending". The `@img/sharp-libvips-*` LGPL exception was approved by you in the session, conditional on a legal review that is still pending.
6. **Pilot and model routes** (EVAL-001/AUTO-001): the only real model measured (`qwen3.5:4b` via Ollama) FAILS the quality thresholds (`docs/evals/REPORT.md`), so no route is currently eligible as reviewer or builder. Choose/measure routes, run the pilot (>= 30 tasks, 3 repositories), and produce the signed pilot report before anyone enables auto-merge. Revisit `config/eval-thresholds.json` with real data.
7. **Cloud execution** (CLD-001): off by default. Needs a real provider implementation of `RemoteSandboxProvider`, pinned image digests, an attestation key and a re-run of the parity suite. Only a simulated provider was tested.

## Engineering gaps you should know about
- **Builder runtime**: a tool-using code-writing agent is required for real builds. Subscription CLIs are terms-blocked and the local-model adapter has no tool loop; builder tests use scripted sandboxed commands.
- **Gate dependencies**: the sandbox has no network, so gates run dependency-free commands. Real projects need an offline cache or a controlled mirror with an egress allowlist.
- **Privileged services**: the merge coordinator and secret broker run as modules, not as separate processes with their own database roles and credentials.
- **No automatic rebase** when the base branch moves (the job returns to a human); **no post-merge CI watcher** (only `recordPostmerge`); required-check names per repository are injected configuration, not stored.
- **Real OpenTelemetry** is not wired (a minimal redacting tracer exists); no browser/e2e/a11y-tool tests of the dashboard (structural tests only).
- **Host**: macOS confinement uses Seatbelt (`sandbox-exec`, deprecated by Apple but working); Linux uses bubblewrap and is verified only in CI. Run the worker under a dedicated unprivileged account.
- Reviews and policy-sensitive routing are heuristic where noted in each `evidence/<ID>/report.md` (e.g. English-only keyword floor in intake).

## Safe defaults that ship
No model API keys or metered endpoints anywhere; subscription CLIs blocked; cloud off; auto-merge kill switch ENGAGED and repositories not opted in; pilot policy (every merge needs a human approval of the exact candidate; HIGH/CRITICAL always).
