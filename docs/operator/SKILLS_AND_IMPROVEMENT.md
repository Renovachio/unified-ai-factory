# Operating the v2.2 skill/agent registry and improvement loop

Everything is **inactive until a human acts**. Read `evidence/SAI/report.md` for what is and is not verified.

## Enabling (nothing is enabled by default)
1. Apply migrations 0011 and 0012. They create NOLOGIN roles `factory_supervisor` and `factory_evaluator` (plus the v2.1 `factory_runner/merge/control`). Create one LOGIN role per deployed component and grant it exactly one of them. The supervisor process must connect as `factory_supervisor`; the evaluator service as `factory_evaluator`; API/orchestrator as `factory_control`.
2. API: pass `skills: { quarantineDir, scratchDir, policy, signer }` to `createApi`. `signer` is the validation-report key (generate and keep it server-side; rotate by key id). `policy` lists allowed licenses, denied hosts and optional permission ceilings; its digest is bound into every approval.
3. Discovery sources live in `config/skill-sources.json`, all `enabled: false`. Enabling one is a conscious edit; it still only yields unverified, non-installable metadata.
4. Approvers are users with role `approver`, `admin` or `security_officer` in the same organisation. The database refuses requester-as-approver and author-as-approver.

## Lifecycle
`quarantined → validated → awaiting_approval → approved` (or `rejected`); `approved → revoked`. Activation moves the registry pointer under a compare-and-swap revision; running jobs keep their pinned digest. Rollback targets only previously approved versions and needs its own approval. **Emergency disable** (`POST /api/v2/skills/disable`) turns a capability off and needs no second approver because it can only reduce authority.

## Failure modes (all fail closed)
| Symptom | Cause | Response |
|---|---|---|
| 412 `digest-mismatch` | approver named different digests, or the package/permissions/policy changed | re-request approval for the current digest |
| 412 `evidence-expired` / `approval-expired` | validation (14 d) or approval (default 24 h) expired | re-validate / re-request |
| 409 `stale_revision` | another activation won | re-read revision, new approval is not needed only if the approval is unconsumed |
| 403 on decision | requester, author, non-approver or other tenant | use an independent approver |
| 423 on handoff | PM artifact not approved | approve the exact artifact digest first |
| `blocked / NO_SUPPORTED_ROUTE` from match | nothing approved + qualified + compatible + within the grant | qualify or approve a capability; there is deliberately no fallback |
| `insufficient_evidence` comparison | sample too small or interval includes 0 | grow the benchmark; do not lower thresholds |

## Audit trail
Append-only tables: `registry_log` (activate/upgrade/rollback/revoke/disable with actor and idempotency key), `approval_decisions`, `skill_validations`, `eval_comparisons`, `experiment_ledger`, `improvement_signals`. Validation reports are Ed25519-signed.

## What you must still do
Provide a real model/runtime to author candidates and run evaluations (provider-terms decision first), grow benchmarks to `minSamples` with a held-out split, insert qualification records through a human process, and complete the v2.1 gates. Until then nothing here may be relied on in production.
