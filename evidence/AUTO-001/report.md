# AUTO-001 evidence report

- **Status:** ACCEPTED_INERT_BY_DEFAULT
- **Date:** 2026-11-19
- **Candidate SHA:** 4f7be1d57a3e6d0906e79ccbeb3406b70ec9f377 (branch dev/auto-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44453088983
- **Test totals:**  914 pass  0 fail 
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
- `CONTRACTS/openapi.yaml`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/auth.ts`
- `apps/api/tests/auto-merge.test.ts`
- `apps/web/app/actions.ts`
- `apps/web/app/auto-merge/page.tsx`
- `apps/web/app/layout.tsx`
- `apps/web/tsconfig.tsbuildinfo`
- `bun.lock`
- `migrations/0008_auto_merge_controls.down.sql`
- `migrations/0008_auto_merge_controls.up.sql`
- `packages/agents/package.json`
- `packages/agents/src/policy-port.ts`
- `packages/agents/tests/auto-merge.test.ts`
- `packages/agents/tests/merge-fixture.ts`
- `packages/db/src/schema.ts`
- `packages/domain/src/guards.test.ts`
- `packages/domain/src/guards.ts`
- `packages/evals/src/index.ts`
- `packages/evals/src/pilot.ts`
- `packages/evals/tests/pilot-fixture.ts`
- `packages/evals/tests/pilot.test.ts`
- `packages/orchestrator/src/auto-merge.ts`
- `packages/orchestrator/src/index.ts`
- `packages/orchestrator/src/orchestrator.ts`
- `packages/orchestrator/src/snapshot.ts`
- `packages/scm/src/merge.ts`

## Notes
- **Inert by default (the pilot is unchanged)**: migration `0008_auto_merge_controls` seeds the global KILL SWITCH ENGAGED and no repository opted in; the shipped `config/risk-policy.json` still has `pilotHumanApproval: true` / `autoMerge.enabled: false`. Test: under the default configuration a LOW docs change goes to AWAITING_HUMAN and nothing merges unattended. Auto-merge can only be reached after ALL of: a post-pilot policy (operator edits `risk-policy.json`, which also changes the policy digest), the kill switch disarmed (admin/security officer), the repository opted in WITH validated pilot evidence, and every per-change control passing.
- **Pilot evidence gate** (`validatePilotReport`, `@factory/evals`): strict signed report bound to the CURRENT benchmark fixture digest; the route's metrics must pass `config/eval-thresholds.json`; pilot must cover >= 30 tasks over 3 repositories, >= 10 seeded defects, >= 5 high-risk controls, >= 10 manual merges, zero escaped defects and zero unauthorised auto-merges; sign-off, date and a rollback plan are required. Every refusal lists its reasons and is audited. **No real pilot report exists** — the real local model (`qwen3.5:4b`) FAILS the thresholds (EVAL-001), so no route is currently eligible; the e2e tests use a synthetic passing report.
- **Rollout controls** (`AutoMergeController`, `@factory/orchestrator`) — each can only REMOVE eligibility: global kill switch (any operator engages it; takes effect on the next evaluation and again inside the merge coordinator; only admin/security officer disarms); per-repository opt-in with allowed risks (DB CHECK: only LOW/MEDIUM), path allowlist (specific globs only), protected paths always veto, daily cap, cooldown; **circuit breaker** (a failed post-merge check on an AUTO-merged job trips the repository until an administrator re-arms; failures on human-approved merges do not trip it); **per-job hold** by an operator/approver; DB CHECK that an enabled repository must carry a sign-off. Decisions are audited once per distinct outcome (allowed/denied + reasons); enable/disable/kill/disarm/trip/rearm/hold are all audited.
- **HIGH/CRITICAL never merge unattended — enforced at four independent layers**: the policy engine (never eligible), `policy_decisions` CHECK (eligible implies LOW/MEDIUM), the domain transition guard (`MERGING` without a human approval needs recorded auto-eligibility AND risk below HIGH), and the merge coordinator (`assessMerge`). Tested with everything armed + a permissive policy + a calibrated repository: a package.json (HIGH) and a workflow (CRITICAL) change both wait for a human; forcing the HIGH job into PREMERGE is still refused; a human approval merges it normally.
- **End to end** (mock GitHub, real pipeline): armed + opted-in + permissive policy => a LOW docs change merges by itself EXACTLY once (`merge_intents.auto = true`, no approval row, `auto_merge.eligible`/`merge.completed` events, audit `allowed`); kill switch engaged before merge => human, then the operator's manual approval merges it (auto=false) and disarming restores automation; kill switch engaged AFTER the job was judged eligible but before the merge call => the coordinator refuses ("auto-merge control: global kill switch is engaged"); hold forces a human; daily cap sends the second change to a human; breaker trips on a post-merge failure and re-arming restores automation.
- **Operator surface**: `GET /auto-merge`, `POST /auto-merge/kill|disarm`, `POST /repositories/:id/auto-merge` (enable/disable/rearm), `POST /jobs/:id/hold-auto-merge` (RBAC: `automerge:read|kill|configure`, `job:hold-auto`; org-scoped; 503 when not configured rather than failing open) and a dashboard "Auto-merge" page with a kill-switch form (releasing is deliberately API-only).
- Fixes found on the way: the freshly re-evaluated policy used CRITICAL routing when the coordinator passed a minimal job object, so required reviews looked missing; it now reads the job's actual risk. The coordinator now surfaces withdrawn auto-merge controls in its blocker list.
- Limits: verified against a fake GitHub, not github.com; auto-merge of MEDIUM is configurable per repository but the shipped allowlist is LOW only and untested at MEDIUM beyond the control checks; no real pilot data exists, so enabling auto-merge in production is an operator decision that the evidence in this repository does NOT support today.
