# INT-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** a5805d2d3edb29c3290f9dbcc398018a0118b236 (branch dev/int-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44430369418
- **Test totals:**  639 pass  0 fail 
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
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `bun.lock`
- `migrations/0005_risk_ratchet.down.sql`
- `migrations/0005_risk_ratchet.up.sql`
- `packages/db/src/schema.ts`
- `packages/intake/package.json`
- `packages/intake/src/classify.ts`
- `packages/intake/src/context.ts`
- `packages/intake/src/decide.ts`
- `packages/intake/src/feedback.ts`
- `packages/intake/src/handler.ts`
- `packages/intake/src/index.ts`
- `packages/intake/src/schema.ts`
- `packages/intake/tests/intake.test.ts`
- `packages/intake/tsconfig.json`
- `packages/orchestrator/src/executor.ts`
- `packages/orchestrator/src/orchestrator.ts`
- `packages/orchestrator/src/pipeline.ts`
- `packages/orchestrator/src/ports.ts`
- `packages/orchestrator/tests/orchestrator.test.ts`
- `packages/runtimes/src/local-model.ts`
- `packages/runtimes/src/mock.ts`
- `packages/runtimes/src/output.ts`

## Notes
- `@factory/intake`: (1) deterministic classification of UNTRUSTED text: injection signals (ignore-previous, role override, secret exfiltration, disable controls, risk downgrade, self-approval, delimiter spoofing, pipe-to-shell), secret redaction, content-based risk FLOOR (security/payments/migrations/deps/concurrency/integrations => HIGH; production/infra/secrets/branch protection/regulated => CRITICAL); suspected injection or secrets raise the floor to HIGH. (2) `precheck`: too-short / title-repeating / placeholder requests go to NEEDS_INFO with questions WITHOUT spending any model time. (3) `decideIntake`: risk = max(floor, model hint) so content and model can only RAISE risk; strict `IntakeDecisionSchema` (unknown keys such as `skip_gates`, `required_reviewers`, `merge`, `approve`, `risk` are rejected, not ignored); invalid output never proceeds. (4) `buildContextManifest`: separate trusted/untrusted sections, redacted, content-addressed (`cas://sha256:...`), `casLoader` is integrity-checked and URI-restricted. (5) `answerQuestions`: atomic NEEDS_INFO -> INTAKE with optimistic version and a `job.feedback` event; intake artifacts are versioned per answer round (`intake.r<n>.json`) so earlier history is preserved.
- API: `POST /api/v1/jobs/:id/feedback` (editor+, CSRF/origin for sessions, expectedVersion, 409 when not in NEEDS_INFO).
- Orchestrator: optional `IntakeHandler` (pre-check short-circuit and decision), `awaiting-info` tick result, intake artifact scoped by answer round.
- New defence in depth (migration `0005_risk_ratchet`): once a job's risk is classified, the database itself refuses to lower it (and refuses resetting `risk_classified`); the orchestrator also uses `max(job.risk, policy.risk)`. Found because a mock policy port overwrote an intake-raised HIGH with MEDIUM.
- Output schemas are validated per role through an explicit `SchemaRegistry` passed to adapters (not a global): a model that tries to smuggle policy fields fails the run at the adapter boundary (job halts as FAILED for explicit recovery); unregistered roles fall back to the generic artifact shape (fail closed). A first attempt used a process-global registry and leaked across test files — replaced.
- Hostile-issue evidence: with a model that OBEYS the injection (accept + risk_hint LOW) the job still ends HIGH, still runs gate + reviews, policy decision is never eligible, no merge intent, hostile text appears only in the untrusted manifest section, `inference-policy.json` unchanged. The live local model (AGT-004 smoke) also refused an injected instruction.
- Scope limit: deterministic keyword floor is heuristic (English only); path-based classification arrives with POL-001. Next: SPC-001.
