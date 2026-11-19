# v2.2 Product & Software Factory — SAI-01..SAI-11 implementation report

Spec: `docs/v2.2/` (copied from the v2.2 package; contracts in `CONTRACTS/v2.2/`). Branch `dev/v22-sai` on top of `dev/v21-act-01`. **Nothing is merged to `main`, nothing is activated, auto-merge stays disabled.** v2.2 says v2.1 gates must pass before real execution authority is enabled; they have not (`evidence/V21-RELEASE/report.md` = NOT READY). Therefore everything here is **inert by default**: all discovery sources ship disabled, no skill/agent exists in the registry, no qualification exists, no model is qualified, and activation needs a human approval that nobody has given.

Status vocabulary: `in_progress` = implemented and tested locally against a real Postgres, real OS file system and real HTTP handler, but **not exercised with a real provider, real model, real catalog, real tracker or real users**. Nothing is `verified`.

| WO | Status | What exists | Main code | Tests |
|---|---|---|---|---|
| SAI-01 inventory | in_progress | approved-root enumeration, private-path refusal (`.ssh`, `.aws`, `/etc`…), symlink non-following, metadata preview with no absolute paths, digest-named read-only quarantine, duplicate digest never rewrites, revocable sources, hardened ZIP import, TOCTOU re-verify | `packages/skills/src/{inventory,archive,digest,frontmatter}.ts` | `inventory.test.ts` |
| SAI-02 discovery | in_progress | source config (all disabled, allowlisted hosts, no metered hosts), adapters via an injected port, pinned-revision/license/trust-tier provenance, entries `unverified` and never installable, unreachable ≠ replaced, bounded HTTPS fetch | `packages/skills/src/discovery.ts`, `config/skill-sources.json` | `discovery.test.ts` |
| SAI-03 matcher | in_progress | approved+active+qualified+compatible+permission-fit only; explainable ranking; safe composition; structured `blocked` (no fallback); tenant-scoped pool | `packages/capabilities/src/matcher.ts` | `matcher.test.ts` |
| SAI-04 gaps | in_progress | opted-in + anonymised signals only (also DB CHECK), normalised-intent dedupe, evidence digests, cause taxonomy (policy refusal ≠ missing capability), recommendations with confidence/cost/risk | `packages/capabilities/src/gaps.ts` | `gaps.test.ts` |
| SAI-05 creator | in_progress | source-only candidate in an isolated dir (refuses live roots), manifest + cases + provenance, scripts written but never run, validated; submitted `awaiting_approval`, never active. The body author is a deterministic template; no model is wired | `packages/skills/src/creator.ts`, `prompts/skill-candidate/` | `creator.test.ts` |
| SAI-06 agent design | in_progress | justified-agent criteria vs skill/workflow/tool adapter; least-privilege manifest; forbidden authority list; permission-review flags; runtime modes limited | `packages/skills/src/agent-designer.ts` | `creator.test.ts` |
| SAI-07 validation | in_progress | static validator: frontmatter, license, references, secrets, hooks, executables, symlinks, unpinned deps, undeclared endpoints, obfuscated/base64 model-API usage, injection/authority claims, permission ceiling; signed (Ed25519) report bound to digest + policy digest, expiring. **Static only: no dynamic/sandboxed behavioural test was built** | `packages/skills/src/validator.ts` | `validator.test.ts` |
| SAI-08 registry | in_progress | migration 0011: immutable content-addressed versions, validation evidence, digest-bound approval requests/decisions (DB trigger: role, no self-approval, no author approval, exact digests, expiry), CAS activation + idempotency + append-only log, rollback to last approved, revocation, emergency disable, job pins | `migrations/0011_*`, `packages/skills/src/registry.ts` | `registry.test.ts` |
| SAI-09 evaluation | in_progress | paired baseline-vs-candidate runner on identical frozen inputs, deterministic checks + independent grader, seeded bootstrap CI, benchmark/holdout/grader digests locked, drift aborts, insufficient confidence ⇒ no recommendation, critical regression ⇒ fail. **Starter benchmarks (3–4 tasks per role) are far below `minSamples`; no candidate can reach `passed` on them** | `packages/evals/src/{paired,pm-benchmarks}.ts` | `paired.test.ts` |
| SAI-10 improvement engine | in_progress | falsifiable hypothesis, one bounded change, copy-only candidate diff, validated, expected benefit + rollback criteria | `packages/improvements/src/engine.ts` | `engine.test.ts` |
| SAI-11 supervisor | in_progress | detect→propose→authorised candidate→independent evaluation→approval package; dedupe; rejected candidates keep evidence; post-release **disable-only** via pre-approved two-human policy; zero promotion authority enforced by DB role/trigger | `packages/improvements/src/supervisor.ts`, `migrations/0012_*`, ADR 0003 | `supervisor.test.ts` |
| PM artifacts | in_progress | versioned content-addressed artifacts, provenance rules (no invented participants, cited decisions, no formal-approval claims, analytics dataset/computation digests), independent exact-digest approval, tracker write only with an explicit digest-bound grant, engineering handoff only from an approved exact version | `packages/product`, `migrations/0012_*` | `product.test.ts` |
| API / UI | in_progress | `/api/v2` routes (imports, skills, approvals, decisions, activations, disable, match, improvements, product artifacts) with RBAC, idempotency keys, 409/412/423 semantics; dashboard pages for skills, improvement backlog, candidate diff, evaluation comparison | `apps/api/src/registry.ts`, `apps/web` | `apps/api/tests/registry.test.ts`, `apps/web/tests/render.test.tsx` |

## Acceptance tests T-01..T-30
| ID | Coverage | Layer / honesty |
|---|---|---|
| T-01 | `inventory.test.ts` | real FS; scripts proven not run |
| T-02 | `discovery.test.ts` | injected catalog port, not a live catalog |
| T-03 | `validator.test.ts`, `discovery.test.ts` | |
| T-04 | `validator.test.ts` (archive), `inventory.test.ts`, API 422 | real extractor, hostile ZIPs built by a test writer |
| T-05 | `inventory.test.ts`, `registry.test.ts` | |
| T-06 | `validator.test.ts`, `creator.test.ts` | static validation only |
| T-07 | `registry.test.ts`, API (412) | real Postgres triggers |
| T-08 | `registry.test.ts`, `product.test.ts`, API (403) | real Postgres triggers |
| T-09 | `registry.test.ts` (pin validity after revoke; new pins blocked) | active-lease revocation is a pin check, not a live worker kill |
| T-10 | validator hidden model API (obfuscated/base64/env), no-SDK scan of supervisor, v2.1 OS egress tests | OS egress proof is from v2.1 (`packages/sandboxes`), not re-run for skill scripts because skill scripts are never executed |
| T-11 | v2.0/v2.1 provider-terms and runtime selection; evaluator refuses unsupported runtimes | no live provider evidence exists |
| T-12 | `matcher.test.ts` (runtime-incompatible excluded) | no adaptation/testing path for cross-runtime skills |
| T-13 | `matcher.test.ts`, API | |
| T-14 | `gaps.test.ts` | |
| T-15 | `creator.test.ts` | template author; no model |
| T-16 | `creator.test.ts` | |
| T-17..T-19 | `product.test.ts`, API | rules are structural; they do not judge content truthfulness |
| T-20, T-21 | `paired.test.ts` | synthetic benchmark + scripted subjects |
| T-22 | `supervisor.test.ts` under `SET ROLE factory_supervisor` | real Postgres roles, not mocks |
| T-23, T-24 | `engine.test.ts`, `supervisor.test.ts` | scripted evaluator subjects |
| T-25, T-26 | `supervisor.test.ts`, `registry.test.ts` | real Postgres; atomic CAS, policy disable, rollback |
| T-27 | `registry.test.ts` (concurrent same-key), scheduler/outbox tests from v2.0 | no multi-process fault injection |
| T-28 | `matcher`, `gaps`, `product`, API tests | |
| T-29 | **partial**: import → validate → approve → activate → audit over HTTP; no "execute" step with a real runtime | |
| T-30 | **partial**: approved artifact → existing intake job over HTTP; isolated code → reviewed draft PR **not** exercised (no runtime, no GitHub) | |

Release go/no-go requires T-10, T-11, T-22, T-24, T-25, T-26, T-30 independent of mocks: T-22/T-25/T-26 meet that against real Postgres; **T-11 and T-30 do not**, so v2.2 is **NOT READY** for use.

## Known limitations
- No model authors skill bodies or hypotheses; no real evaluator subjects exist. The evaluator and supervisor take injected services.
- Dynamic (sandboxed) skill tests are not implemented; skill scripts are never run anywhere.
- Per-component LOGIN roles for `factory_supervisor` / `factory_evaluator` / `factory_control` are not provisioned (open item, ACT-05).
- Benchmarks are starters. Qualification records are never created by code; they must be inserted by a human-approved process.
- A skill's declared `runtimes` is the author's claim; compatibility is never inferred, and the matcher also requires a role qualification.
- The `/skills/imports` API accepts ZIPs only; browsing a local root from the dashboard is not implemented (library-level only).
- Discovery HTTP adapters for specific catalogs (agentskills.io, GitHub) are not written; only the port, the bounded fetch and the normaliser exist.
