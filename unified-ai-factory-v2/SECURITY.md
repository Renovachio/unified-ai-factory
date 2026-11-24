# Security policy

## Inference source denial
Only `subscription_cli` and `local_model` authentication modes exist in contracts. Subscription use requires documented provider authorization for exactly this automation pattern. Block rather than assume permission. No model API keys, no billed inference endpoints, no direct SDK inference or implicit fallback. Self-hosted cloud inference can incur infrastructure costs, clearly separated.

At worker enrollment and every run: validate executable allowlist and version, auth mode, identity, environment variables, endpoint allowlists, model policy, runtime location and operator approval. Disallow provider API keys including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, and other model-service secrets. Do not exfiltrate or reuse CLI login tokens.

## Threat boundaries
Repositories, issues, PR descriptions and model outputs are untrusted input. Treat repository scripts as hostile. Worktrees are a Git isolation mechanism, **not a security sandbox**. Use a restricted OS identity / VM or equivalent proven sandbox plus network egress policy, filesystem allowlist, CPU/memory/time quotas, short-lived GitHub tokens, and no host socket or secret mounts. Cloud hosts must deny metadata SSRF and use attested runner identity.

## Git and merge
GitHub App installation-scoped credentials never reach coding sandboxes. Strip unsafe Git hooks/config and validate path escapes. A separate merge service re-fetches PR head/base, check runs, GitHub protections, reviewer decision, exact policy digest and approval expiry. HIGH/CRITICAL changes always manual. Pilot: every merge manual.

## Incident procedure
On secret leak or sandbox escape: quarantine worker and job, revoke relevant credentials, freeze artifacts and audit logs, notify operator, require security clearance before re-entry. Never autonomously erase forensic evidence.

## Tests
Covered by the test suite: paid inference rejection; prompt injection; path traversal; network escape; stale fencing; approval invalidation; webhook forgery; race conditions.
