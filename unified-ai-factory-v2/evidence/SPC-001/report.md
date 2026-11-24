# SPC-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** d9ff62b947b343d1d45fc4d98fb6b527a8c71f87 (branch dev/spc-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44431510104
- **Test totals:**  656 pass  0 fail 
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
- `packages/agents/package.json`
- `packages/agents/src/handler.ts`
- `packages/agents/src/index.ts`
- `packages/agents/src/spec.ts`
- `packages/agents/tests/spec.test.ts`
- `packages/agents/tsconfig.json`
- `packages/domain/src/gates.ts`
- `packages/domain/src/index.ts`
- `packages/intake/src/context.ts`
- `packages/orchestrator/src/orchestrator.ts`
- `packages/orchestrator/src/ports.ts`

## Notes
- `@factory/agents`: strict zod schemas for the three specification roles — `RequirementsSchema` (every AC needs an `observable` outcome), `DesignSchema` (repo-relative, traversal-free paths), `SpecSchema` (tasks must cover >= 1 AC and reference checks; every check must be EXECUTABLE: `runs` is either a known deterministic gate step id or a test file; arbitrary shell commands are not representable) — plus `registerSpecSchemas`.
- `validateTraceability`: every AC implemented by >= 1 task AND verified by >= 1 executable check; no dropped intake ACs; no dangling/duplicate ids; a check's `test_file` must be a real test path that some task creates; tasks may only touch files the design declares; each task's claimed ACs must be verified by ITS checks; protected-path touches (`.github/workflows`, `config`, `licenses`, `migrations`, `package.json`, auth, SQL ...) are surfaced and floor the risk (CRITICAL/HIGH). 10 defect classes tested individually.
- `createSpecHandler` re-validates the stored artifacts independently of the adapter, writes `traceability.json` (matrix + errors) as a content-addressed artifact, and returns the risk floor. Orchestrator: untraceable spec => job FAILED with `spec-traceability` and a `spec.rejected` event listing the errors BEFORE any builder/tester task exists; accepted spec => `spec.accepted` event, `jobs.spec_digest` set, risk floor ratcheted up.
- Canonical gate step ids and protected-path globs live in `@factory/domain` (`gates.ts`) so GAT-001/POL-001 reuse the same source of truth.
- Agent context now carries earlier-stage outputs (intake -> analyst -> architect -> spec) in a labelled `agent_outputs` section (model output, treated as data, size-capped).
- Scope limit: the traceability proof is structural. Whether a check actually exercises its AC is established by running the gates (GAT-001) and by reviewers (REV-001); semantic adequacy of ACs is not claimed. Next: BLD-001.
- Bug found by the protected-path test and fixed: the glob->regex helper re-expanded its own placeholders, so `**/package.json` did not match nested paths (e.g. `apps/web/package.json`).
