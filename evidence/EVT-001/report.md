# EVT-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-18
- **Candidate SHA:** 1a8ed9b1c0cd64f2e9635891cd9393e75ae5d770 (branch dev/evt-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44422821207
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
- `licenses/allowlist.yaml`
- `migrations/0003_event_envelope.down.sql`
- `migrations/0003_event_envelope.up.sql`
- `packages/contracts/package.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/tests/contracts.test.ts`
- `packages/contracts/tsconfig.json`
- `packages/db/package.json`
- `packages/db/src/events.ts`
- `packages/db/src/index.ts`
- `packages/db/src/outbox.ts`
- `packages/db/src/schema.ts`
- `packages/db/src/sse.ts`
- `packages/db/src/transition.ts`
- `packages/db/tests/db.test.ts`
- `packages/db/tests/events.test.ts`
- `packages/telemetry/package.json`
- `packages/telemetry/src/digest.ts`
- `packages/telemetry/src/index.ts`
- `packages/telemetry/src/redact.test.ts`
- `packages/telemetry/src/redact.ts`
- `packages/telemetry/tsconfig.json`
- `tsconfig.base.json`

## Notes
- `@factory/db`: `appendEvent` (sequence allocated under the job row lock => contiguous, commit-ordered, rolled back with the transaction), `readEvents`, `toEnvelope`, `deliverOutbox` (at-least-once, SKIP LOCKED, per-job ordering via advisory lock + head-of-line backoff blocking), `DedupingConsumer`, `transitionJob` (version check + legality + guard + history + event + outbox + audit, one transaction), `eventStream`/`sseResponse` (replay + tail, Last-Event-ID resume, keep-alives, abort).
- Migration `0003_event_envelope` adds `attempt` and `fencing_token` to events (down migration provided).
- `@factory/telemetry`: deep secret redaction (keys and token/PEM/JWT/GitHub/AWS patterns) and canonical digests; payloads are redacted before persistence.
- `@factory/contracts`: Ajv validators compiled directly from `CONTRACTS/*.schema.json` (strict, formats); event envelopes, create-job, review, agent-result and policy tested, including that `config/inference-policy.json` validates.
- A defect was found by the tests and fixed in this task: after a failed delivery, later events of the same job were deliverable out of order.
- Tests: 20-way concurrent append -> sequences 1..20; rollback -> no hole; consumer kill + resume via Last-Event-ID -> no gaps/duplicates; concurrent consumers never double-claim; concurrent transitions -> exactly one wins.
- SSE HTTP route wiring and auth live in API-001. Next: SCH-001.
