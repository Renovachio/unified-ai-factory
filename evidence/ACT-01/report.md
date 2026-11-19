# ACT-01 — Runtime activation & provider compliance (v2.1)

**Status: `blocked` (partially verified).** Candidate: the commit that adds this file on `dev/v21-act-01` (see `git log`). Host: macOS 27.2.1 arm64, Bun 1.4.4, Seatbelt sandbox, Ollama 0.33.3.

## Baseline (audited before changing)
- v2.0 already had: `InferenceSourcePolicy` (forbidden env, loopback-only endpoints, denied metered hosts, provider-terms gate, executable allowlist), subscription-CLI adapters (blocked, no terms approval), a streaming local adapter with **no tool loop**, a router with no API fallback, Seatbelt/bwrap sandbox with `(deny network*)`.
- Gaps found: no runtime discovery, no ordered selection with reason codes, no role qualification registry, no local tool loop, no fail-closed enforcement self-test, no DNS/IP-bypass egress tests.

## Implemented
| Task | Change |
|---|---|
| RT-01 | `packages/runtimes/src/discovery.ts` — finds binaries, runs only `<bin> --version` with a scrubbed environment, records path/version/OS/capability flags (`evidence/ACT-01/discovery.json`: claude-code 2.1.328 found, codex not installed, ollama 0.33.3 found). |
| RT-02 | Discovery never reads credentials or session files; it does not claim authentication. Unverified auth stays an operator attestation (see blockers). |
| RT-03 | Unchanged gate: `config/provider-terms.json` stays empty, so subscription CLIs are blocked (`PROVIDER_NOT_APPROVED`). Uncertainty is blocking. |
| RT-05 | `packages/runtimes/src/tool-loop.ts` — bounded read/edit/test loop with explicit tool schemas (`list_dir`, `read_file`, `write_file`, `replace_in_file`, `run_check`), workspace confinement (traversal, absolute, symlink, protected `.git`/`.github`/`.env`), write/size budgets, invalid-call budget, iteration/context/wall-time/abort/429 handling, audit events with lengths only (a test caught and fixed content leaking into events). The model never receives a shell; checks are operator-named commands. |
| RT-06 | Distinct loop statuses: `iteration-budget`, `invalid-calls`, `context-limit`, `wall-time`, `aborted`, `rate-limited`, `model-error`. 429 stops (no paid fallback). |
| RT-07 | Policy rejects metered endpoints/credential env before any request (tested for the loop). OS-level egress proof added to `packages/sandboxes/tests/adversarial.test.ts`: metered hosts by name, raw IP, IPv6, decimal/hex IP, localhost, with proxy/base-url variables set, plus DNS — all unreachable from inside the sandbox; listener saw 0 connections. New `verifySandboxEnforcement` (fail-closed self-test) used as `sandboxEnforced` input to selection. |
| Selection | `selectRuntime` (`selection.ts`): installed → permitted → role-qualified → sandbox enforced → no metered inference; reasons `RUNTIME_UNAVAILABLE`/`PROVIDER_NOT_APPROVED`/`MODEL_NOT_QUALIFIED`/`INFERENCE_POLICY_DENIED`/`SANDBOX_NOT_ENFORCED`; per-candidate decision log; no silent fallback. No new job state or migration. |
| ACT-06 (foundation) | `qualification.ts` + `config/model-qualification.json` (empty registry; targets 90/90/95/95%, min 30 samples, ≤90-day validity, Wilson bound, zero critical misses/policy violations, builder must use the real tool loop). |

## Tests (this environment)
`bun test packages/runtimes` 112 pass; `bun test packages/sandboxes/tests/adversarial.test.ts` 31 pass (macOS Seatbelt); lint and typecheck clean. All unit/integration tests are local; **no provider was contacted**.

## Live evidence (real local engine, disposable repo, OS sandbox)
`scripts/live-tool-loop-smoke.ts` → `evidence/ACT-01/live-tool-loop.json`: `qwen3.5:4b` via Ollama read the fixture, edited `src/slug.js`, ran the sandboxed check, finished in 4 iterations / 4 tool calls / 0 invalid calls; an independent post-loop check exited 0. **This model is not qualified for builder** (EVAL-001 and the empty registry): it proves the mechanism only, and `selectRuntime` refuses it for builder work.

## Acceptance criteria
- [~] Real runtime reads and modifies a file in a disposable repo — **local engine only**; no approved subscription CLI run.
- [x] Structured events, runtime/version provenance (discovery + loop events) and exit status.
- [~] Cancellation/timeout: process-group kill verified by existing RUN-001 suite; loop abort/wall-time covered; not re-run against a live CLI.
- [x] Forbidden inference endpoints unreachable under OS-enforced policy (adversarial tests above).
- [x] Quota exhaustion (429 / rate-limited) stops; never switches to paid mode (router/loop tests).
- [ ] Provider compliance approval recorded — **BLOCKED**: needs the operator's decision (see below).

## Blockers / open risks
1. **Provider terms**: no documented approval for unattended factory use of Claude Code (2.1.328 is installed) or Codex. Not interpreted by the agent; `config/provider-terms.json` unchanged. Owner: operator.
2. **No qualified builder model**: stop condition "unqualified local model for builder role" applies; real pilot (ACT-02) cannot proceed until ACT-06 qualifies a route.
3. Subscription CLI authentication cannot be verified without reading provider session state; requires operator attestation.
