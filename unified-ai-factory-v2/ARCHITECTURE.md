# Architecture and ownership

## Layers
- `apps/web`: dashboard (untrusted browser); read/approve through authenticated API.
- `apps/api`: authenticated REST/SSE and signed integration webhooks.
- `packages/domain`: typed workflow, policy and risk evaluator; no network calls.
- `packages/db`: PostgreSQL schema, transactions, state transitions + outbox.
- `packages/scheduler`: durable task leases, monotonic fencing and retry controls.
- `apps/runner`: locally supervised or authorized remote isolated execution.
- `packages/runtimes`: subscription CLI adapters (only permitted uses), local model adapter, mock adapter.
- `packages/sandboxes`: confinement, filesystem/network permissions, teardown.
- `packages/agents`: structured prompts and review role routing.
- `packages/checks`: factory-owned deterministic checks and immutable evidence.
- `packages/scm`: installation-scoped GitHub App integration, guarded merge.
- `packages/telemetry`: immutable audit events, redaction, aggregate runtime utilization.

## Nonnegotiable boundaries
- Only orchestrator advances job state in database transaction and emits outbox events.
- Only scheduler leases jobs; worker reports require valid fencing token.
- Only server-side merge coordinator writes merges after fresh exact-SHA evidence and policy.
- Builder never controls reviewer approvals, gate policies, secret broker or authorization.
- Target repositories cannot mutate authoritative factory configuration.
- Cloud execution is optional; self-hosted models only unless expressly compliant subscription CLI permitted; infrastructure costs separate from model inference.

## Suggested folders
`apps/{api,web,runner}`; `packages/{contracts,domain,db,scheduler,agents,runtimes,sandboxes,checks,scm,intake,secrets,telemetry,ui}`; `config`; `migrations`; `prompts`; `tests/{unit,contract,integration,e2e,adversarial,fault}`; `docs/adr`.

See `docs/BLUEPRINT_V1_1.md` for transition diagram, event guarantees and the proposed PostgreSQL tables.
