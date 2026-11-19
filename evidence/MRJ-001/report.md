# MRJ-001 evidence report

- **Status:** ACCEPTED_MOCK_GITHUB
- **Date:** 2026-11-19
- **Candidate SHA:** 2f60af132483320a240b7fd4696906b18cb389b0 (branch dev/mrj-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44440133843
- **Test totals:**  759 pass  0 fail 
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
- `apps/api/tests/decisions.test.ts`
- `bun.lock`
- `migrations/0007_approval_binding.down.sql`
- `migrations/0007_approval_binding.up.sql`
- `packages/agents/package.json`
- `packages/agents/src/policy-port.ts`
- `packages/agents/tests/merge.test.ts`
- `packages/db/src/schema.ts`
- `packages/orchestrator/src/builder.ts`
- `packages/orchestrator/src/decisions.ts`
- `packages/orchestrator/src/index.ts`
- `packages/orchestrator/src/orchestrator.ts`
- `packages/orchestrator/src/ports.ts`
- `packages/orchestrator/src/snapshot.ts`
- `packages/scm/src/client.ts`
- `packages/scm/src/index.ts`
- `packages/scm/src/merge.ts`
- `packages/scm/tests/fake-github.ts`

## Notes
- **Decisions** (`POST /api/v1/jobs/:id/decisions`, `recordDecision` in `@factory/orchestrator`): approver/admin only (RBAC matrix), CSRF/origin for sessions, `Idempotency-Key` required. Persists a bounded human authorization — NOT a merge. Refuses (409, nothing stored) any approval whose headSha/baseSha/policyDigest no longer equals the job's CURRENT evidence binding, a stale `expectedVersion`, or a job not in AWAITING_HUMAN; requester cannot self-approve HIGH/CRITICAL; other tenants get 404; reject/rework need a reason (rework feeds the builder). Each approval stores the FULL 8-field binding (migration `0007_approval_binding`) in the append-only `approvals` table, atomically with the AWAITING_HUMAN -> PREMERGE transition, event and audit entry. Idempotent replay, same key + different body = 409.
- **Merge coordinator** (`@factory/scm` `merge.ts`, `MergeCoordinator`): the ONLY code path that merges (merge-role credential; `GitHubClient.mergePullRequest` requires the exact 40-hex head SHA and returns a definitive refusal for 405/409/422, throws on unknown outcomes). It re-fetches the PR, base tip and check runs, re-evaluates policy from durable evidence, verifies gate evidence (signature + exact head/base/manifest) and required reviews for the exact head, and runs `assessMerge` over fresh approval bindings. Blocks: head differs from the evaluated candidate (-> QUARANTINED, incident), PR not mapped to the job, base moved, policy changed or risk raised since the decision, evidence unverifiable, review missing, required checks missing/failing (a still-running check just waits), stale/expired approvals, rejection, CRITICAL without two distinct non-requester approvers. A merge performed by someone else without a valid approval is also quarantined.
- **Exactly-once**: PREMERGE -> MERGING (domain guard + unique `merge_intents(repository, PR, head)` inserted in the SAME transaction); only the version-CAS winner calls GitHub; GitHub is asked to merge at the exact head SHA; after a timeout/5xx the coordinator RECONCILES against the authoritative PR before anything else (no blind retry): merge happened => recorded once (`reconciled: true`), not merged => stays MERGING/pending and the retry merges once. A PR already merged for the approved head is reconciled, never merged twice. GitHub refusing (branch protection etc.) => intent `aborted`, job back to a human, no bypass; branch protection/rulesets are never touched (asserted on the request log). The factory opens DRAFT PRs; after a valid approval the coordinator marks them ready (GraphQL, merge credential) and merges.
- **Post-merge**: MERGED -> POSTMERGE_MONITOR; `recordPostmerge` -> DONE or FAILED with a `postmerge.failed` incident event and `postmerge-failed` code (the CI watcher itself is OBS-001).
- Orchestrator: a PREMERGE job with an approval for its head is handed to the coordinator (`MergePort`); refusals map to legal transitions (AWAITING_HUMAN / QUARANTINED); MERGING is resumable after a crash. Without a `merge` port the orchestrator never merges.
- Tests: 17 coordinator scenarios (one merge for 8 concurrent coordinators, head/base/policy/checks/gate/review/approval-expiry blocks, two-person CRITICAL, protection refusal, timeout-after-merge, 502-before-merge, external merge, post-merge, merge-role token != branch-write token) + 7 API decision tests.
- Limits / operator actions: (1) verified against a fake GitHub over real HTTP, NOT github.com — live verification needs the GitHub App (merge permission) and a protected test repo. (2) The coordinator runs as a module invoked by the orchestrator, not yet as a separate privileged service/process with its own DB role (blueprint wants separate credentials/roles). (3) No automatic rebase: when the base moves the job returns to a human instead of re-running gates on a rebased candidate. (4) Required-check names per repository are injected configuration, not yet stored per repo.
- Next: OBS-001.
