# ACT-06 — Model qualification (v2.1)

**Status: `blocked` — mechanisms implemented and tested; NO model-role pair is qualified.**

## Baseline / gaps found
- Evaluator leakage: `isDetected` (EVAL-001) also counted a defect as found when a non-pass finding merely cited the changed file as its location. A reviewer that blocked every diff and cited the file scored 100% recall. **Fixed**: detection now needs a finding of sufficient severity (medium; high/critical for security defects) whose text names the defect class. Regression test proves the block-everything reviewer scores 0.
- Leakage guards added (tests): role prompts contain no golden solutions, hidden tests, defect ids/categories or task titles; reviewer-visible text never names the defect class; builder-visible text never includes golden body or hidden tests.
- Thresholds raised to the v2.1 initial targets (`config/eval-thresholds.json` v1.1: builder 0.90, code review recall 0.90, security recall 0.95). These are policy targets, not validated guarantees.
- Builder benchmark used a one-shot completion, not the tool loop: **added** `ToolLoopBuilderSubject` (real controlled tool loop; hidden tests stay hidden; public smoke check only) and `bun scripts/run-evals.ts local-tools`.

## Implemented
- `config/model-qualification.json` (empty registry) + `packages/runtimes/src/qualification.ts`: per (adapter, model, promptVersion, toolsetDigest, role) records; approval/expiry (≤90 days)/revocation; min samples; Wilson lower bound; zero critical misses and policy violations; builder requires the real tool loop. A different prompt, model or tool configuration is a different candidate.
- `selectRuntime`/`selectingExecutor`: failed, expired or absent qualification => `MODEL_NOT_QUALIFIED`; there is no fallback to a weaker or paid route.
- `proposeQualification`: turns a benchmark run into numbers for a human; **never an approval**.
- Runner enrollment now runs the sandbox enforcement self-test (fail closed).

## Why nothing qualifies today
The dataset has 12 builder tasks, 10 seeded defects (7 security), 3 clean diffs, 5 controls. The registry requires >= 30 samples per role, so even a perfect score (oracle: 12/12, Wilson lower bound < 0.8) is refused. No spec-quality suite exists, so no model can be qualified for `spec`. The only real model measured (qwen3.5:4b) failed EVAL-001. Growing the dataset to >= 30 per role and adding a held-out split is outstanding work.

## Tests
`bun test packages/evals` 19 pass; `packages/runtimes` selection/qualification/tool-loop tests; runner selection tests. Lint/typecheck clean.

## Open
1. Expand the dataset (>=30 builder, >=30 seeded defects incl. >=30 high/critical security, spec/PM tasks) with a hidden held-out split.
2. Run candidate models (local; subscription CLIs only after provider approval) and have an operator approve records.
3. Re-qualify on any model/prompt/CLI/harness/tool change.
