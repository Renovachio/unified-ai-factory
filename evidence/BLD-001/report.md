# BLD-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** 3a77308767ace6203a2a103a1469f54a8704f48c (branch dev/bld-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44433471390
- **Test totals:**  666 pass  0 fail 
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
- `packages/sandboxes/src/backends.ts`
- `packages/sandboxes/src/process.ts`
- `packages/sandboxes/tests/adversarial.test.ts`

## Notes
- Trusted candidate pipeline (`@factory/scm` `repo.ts`, `@factory/orchestrator` `builder.ts`): checkout EXACT parent SHA (shallow fetch; token only in the fetching process's git env, never in the workspace — grep of worktree+`.git` proves it) -> sandboxed code-writing agent (`BuilderRuntime`, no network/credentials) -> TRUSTED `commitCandidate` -> push to `factory/<job>` (fast-forward only) -> immutable record.
- `commitCandidate` never trusts agent-made git objects: it sanitizes `.git`, requires `HEAD == expected parent`, then builds the commit with plumbing (`add --literal-pathspecs` -> `write-tree` -> `commit-tree`) from an EXACT allowlist of paths taken from the approved design. Rejected (fail closed, task fails, nothing pushed): paths outside the design, `.gitattributes/.gitmodules/.git*`, symlinks leaving the repo, gitlinks/submodules, oversized files/totals, too many files, empty change, wrong parent. Fixed identity and the job's creation timestamp make candidates REPRODUCIBLE (same base + same edits => same SHA, verified; different content => different SHA). Planted hooks/aliases/fsmonitor/user config in the worktree never run (verified with a marker file).
- Migration `0006_candidates`: append-only record per (job, round, role) with parent/head/tree SHA, patch digest and descriptor digest; unique (job,round,role) and (job,head). Patch and a `factory.candidate/1` descriptor are content-addressed artifacts (`patch.<role>.r<n>`, `build.r<n>.json`, `test-plan.r<n>.json`). A retried task REUSES the recorded candidate (no second candidate, agent not re-run).
- `candidateScm`/`createGitScmPort`: the orchestrator only READS recorded candidates at BUILDING -> GATING (idempotent), sets `jobs.head_sha`; gate/review evidence rows are keyed to that same head SHA (asserted).
- Rework: round n>0 builder starts from the PREVIOUS round's final candidate (chained parents, branch fast-forwards, 5 commits after one rework) and receives `gate.failed` feedback events. Bounds: global round budget (`max_rounds`) AND at most 2 automated fixes per gate-failure class (`MAX_FIXES_PER_CLASS`): the 3rd failure of the same class goes REWORK -> AWAITING_HUMAN (tested: exactly 3 rounds of candidates, 3 failed gate rows, no merge intent).
- Known limits: (1) a crash AFTER a push but BEFORE the DB record, followed by a retry that produces different content, ends in a refused non-fast-forward push (task fails safely; operator recovery) rather than adopting the orphan commit. (2) The builder agent here is a scripted sandboxed shell; a real builder needs a tool-using CLI adapter, which is BLOCKED on provider-terms approval (AGT-002/003) — the local-model adapter has no file-editing tool loop. (3) Real GitHub push uses the same code path as local remotes plus the https-only/token branch, which is exercised only with a local remote in tests.
- Next: GAT-001.
- Fix found by the Linux CI run of this task: the bubblewrap backend ignored the requested cwd (always `--chdir` workspace root), so sandboxed builder commands ran outside the repo directory on Linux; `cwd` is now part of the wrap context (tested).
