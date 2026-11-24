# SCM-001 evidence report

- **Status:** ACCEPTED_MOCK_ONLY
- **Date:** 2026-11-19
- **Candidate SHA:** ff5f01bf38a86942624e4e458b837ed2b77c1b2f (branch dev/scm-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44425392823
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
- `migrations/0004_pull_requests.down.sql`
- `migrations/0004_pull_requests.up.sql`
- `packages/db/src/schema.ts`
- `packages/db/tests/db.test.ts`
- `packages/sandboxes/src/gitsafety.ts`
- `packages/sandboxes/tests/adversarial.test.ts`
- `packages/scm/package.json`
- `packages/scm/src/app-auth.ts`
- `packages/scm/src/client.ts`
- `packages/scm/src/index.ts`
- `packages/scm/src/pr.ts`
- `packages/scm/src/push.ts`
- `packages/scm/src/webhook.ts`
- `packages/scm/tests/fake-github.ts`
- `packages/scm/tests/scm.test.ts`
- `packages/scm/tsconfig.json`

## Notes
- `@factory/scm`: GitHub App auth (RS256 app JWT; installation tokens narrowed to one repository and one of three roles — `read`, `branch_write`, `merge`; branch_write has no merge/checks permissions), a deliberately narrow `GitHubClient` (no method exists to change branch protection, rulesets, default branches, merge, or delete), zod-validated responses, GET-only automatic retries, `factory/<job>` branch guard before any network call.
- `ensureDraftPr`: per-job advisory lock + unique job->PR mapping + look-before/after-create; adopts a PR created before a crash; resolves GitHub 422 races; refuses to adopt a branch at a different SHA; always `draft: true`; emits `pr.created` exactly once.
- `pushFactoryBranch`: trusted-side push (the sandbox holds no credential) of an exact SHA to `refs/heads/factory/*` only; re-sanitizes the untrusted repo (hooks/config) first; no force/delete; https://github.com remotes only (local remotes test-only); token passed via env-config header, never argv, and redacted from errors.
- Webhooks: constant-time HMAC over the raw body; forged requests are audited and do NOT consume delivery ids; `(provider, delivery_id)` unique so replays and 12 concurrent copies process once; processing and delivery recording share a transaction (failed processing => redelivery works); PR head changes update job/PR and emit `pr.head_changed` (evidence-invalidation signal); `pr.closed` emitted with merged flag.
- Migration `0004_pull_requests` (+ down).
- Tests use a real-HTTP fake GitHub (`tests/fake-github.ts`) and local bare git repos; they assert that only `access_tokens`, `git/refs` (factory/*) and `pulls` POSTs occur and `main` is never modified.
- Bug found by tests and fixed in RUN-001 code: the git-config sanitizer emitted invalid `[protocol]` keys; real git now parses its output (regression test added).
- **LIMITATION / OPERATOR ACTION:** no GitHub App exists yet, so the acceptance criterion "test repo draft PR opened idempotently" is verified against a local fake GitHub over real HTTP, NOT against github.com. Live verification needs: a GitHub App (contents/pull_requests write on a dedicated test repo), its app id, private key and installation id, and the webhook secret. `Renovachio/unified-ai-factory` must not be used as the test target without approval.
- Next: AGT-001.
