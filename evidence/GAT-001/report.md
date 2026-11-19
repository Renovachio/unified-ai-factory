# GAT-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** 981b13dd147aafee7b3997ec72100ae18266889a (branch dev/gat-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44434974457
- **Test totals:**  682 pass  0 fail 
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
- `.github/workflows/ci.yml`
- `bun.lock`
- `config/gates.lock.json`
- `config/gates/typescript-web.json`
- `package.json`
- `packages/agents/package.json`
- `packages/agents/tests/gates-e2e.test.ts`
- `packages/checks/package.json`
- `packages/checks/src/gates/evidence.ts`
- `packages/checks/src/gates/index.ts`
- `packages/checks/src/gates/manifest.ts`
- `packages/checks/src/gates/port.ts`
- `packages/checks/src/gates/runner.ts`
- `packages/checks/src/index.ts`
- `packages/checks/tests/gates.test.ts`
- `packages/orchestrator/src/builder.ts`
- `packages/orchestrator/src/orchestrator.ts`
- `scripts/gates-lock.ts`

## Notes
- `@factory/checks` gates (`packages/checks/src/gates`): **factory-owned, pinned manifests** — `config/gates/typescript-web.json` (strict zod schema: `locked: true`, argv-only commands, argv[0] must be an allowlisted executable, step ids from the canonical list) pinned by digest in `config/gates.lock.json` (`bun scripts/gates-lock.ts`, `--check` runs in CI and `bun run ci`). Any edit without re-pinning, an unpinned/unlocked/malformed manifest, or a non-allowlisted executable => `manifest-mismatch`: NOTHING runs and the verdict can never be pass (tested for 6 edit variants).
- Runner (`runGates`): executes the locked argv inside the RUN-001 sandbox (no network, workspace-only FS, scrubbed env) against a FRESH checkout of exactly the candidate SHA (token only in the fetching process), per-step timeout kill, logs stored content-addressed (redacted); afterwards re-verifies `HEAD` unchanged and that NO tracked file was modified (a check that rewrites sources cannot fake a pass => `worktree-mutated`).
- Tamper resistance from the inside: candidates that touch check-defining files (package.json, lockfiles, tsconfig/eslint/test configs, scripts/, workflows, `.factory/`, manifest `protectedPaths`) can NEVER pass even if the weakened commands exit 0 (`checks-tampered`); tests show a builder replacing every script with `true` is stopped and escalated.
- **Signed, SHA-bound evidence**: Ed25519 over canonical JSON (`factory.gate-evidence/1`: job, repo, head SHA, base SHA, manifest digest, per-step exit/timing/log digest, runner identity, changed check-defining files). `verifyEvidence` checks the signature AND head/base/manifest/job bindings AND internal consistency (a validly signed "pass" with a failing step is rejected). Forgery (flipping verdict/steps/head), wrong key, other SHA, other base, other manifest are all rejected. `verifyStoredGateEvidence` re-verifies from `gate_results` + the integrity-checked content-addressed store for the EXACT head/base/manifest — the primitive MRJ-001 will call before any merge.
- Orchestrator: failure classes `manifest-mismatch`, `checks-tampered`, `head-mismatch` ESCALATE IMMEDIATELY to a human (no automated fix attempts, never reaches review); other classes use the 2-fixes-per-class budget from BLD-001. End-to-end with real sandboxed gates: good candidate passes and re-verifies; FAIL-marker candidate -> feedback -> fixed round passes (two evidences bound to two different SHAs, the passing one cannot be replayed for the failing head); weakened checks and tampered manifest go straight to a human with zero reviews and zero merge intents.
- Also fixed: a tester that has nothing new to add in a rework round is a recorded no-op (candidate stays at the builder's commit) instead of failing the job.
- Limits / operator actions: (1) the sandbox has NO network, so gates run dependency-free commands here; real projects need a pre-populated offline cache or a controlled package mirror reachable under an egress allowlist (not implemented). (2) The gate checks only what the manifest says — it does not prove tests are meaningful (reviewers + traceability). (3) The evidence signing key must be generated and held by the operator (test keys are ephemeral); the public key must be distributed to the merge coordinator. (4) Evidence signing is not a transparency log; a compromised gate host could sign false evidence.
- Next: REV-001.
