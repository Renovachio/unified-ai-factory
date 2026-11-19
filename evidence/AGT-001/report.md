# AGT-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** 24b3774085af75ba9a0df3d748b952ba2bf45b4e (branch dev/agt-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44426222433
- **Test totals:** 
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
- `bun.lock`
- `config/provider-terms.json`
- `config/runtime-allowlist.json`
- `packages/runtimes/package.json`
- `packages/runtimes/src/index.ts`
- `packages/runtimes/src/mock.ts`
- `packages/runtimes/src/output.ts`
- `packages/runtimes/src/policy.ts`
- `packages/runtimes/src/sinks.ts`
- `packages/runtimes/src/testing/contract-suite.ts`
- `packages/runtimes/src/types.ts`
- `packages/runtimes/tests/mock.test.ts`
- `packages/runtimes/tests/policy.test.ts`
- `packages/runtimes/tests/simulation.test.ts`
- `packages/runtimes/tsconfig.json`

## Notes
- `@factory/runtimes`: adapter contract (`AgentRuntimeAdapter`: probe / start / status / cancel / optional resume), strict zod `AgentRunRequest` (unknown keys rejected, so no API key, base URL or billing field can be smuggled in), normalized `AgentEvent` envelope with a gap-free monotonic `EventSequencer` (nothing may follow a terminal event), `ProbeResult` availability union (`not-installed`, `terms-not-approved`, `rate-limited`, `offline`, ...), wire-result projection checked against `CONTRACTS/agent-result.schema.json`.
- `InferenceSourcePolicy` (deny-by-default, checked before every run): refuses credential/billing/base-URL environment variables, any auth mode other than `subscription_cli`/`local_model`, subscription adapters without an unexpired provider-terms approval for that exact adapter, metered inference hosts and non-allowlisted endpoints, and non-allowlisted executables/versions. Config: `config/provider-terms.json` (empty => all subscription adapters blocked) and `config/runtime-allowlist.json` (empty); `inference-policy.json` is validated against `policy.schema.json` at load.
- Role output handling (`parseRoleOutput`): size cap, JSON parse, schema validation, review output must match the role and the requested candidate SHA; invalid output can never succeed.
- `MockAdapter`: deterministic, idempotent on requestId, behaviors ok/slow/fail/rate_limited/bad_output/wrong_sha/offline, honest cancel/timeout.
- **One shared contract suite** (`src/testing/contract-suite.ts`, 12 tests) now runs against the mock and MUST be run unchanged by AGT-002/003/004; plus policy tests and a 12-role pipeline simulation.
- Note: `failureCode`/`output` are internal fields, not part of the wire contract (the schema forbids extra properties); `toWireResult` projects them out.
- Next: AGT-004 (local model adapter, no provider-terms dependency) and AGT-002/AGT-003 (BLOCKED on operator provider-terms approval by design).
