# DSP-10 — Verification, operational hardening and release gate

**Status: in_progress. Everything that can be verified locally was; the real authorized pilot is BLOCKED (see below). Dispatch v2.3 is NOT released.**

## Commands and results (this checkout, macOS arm64, Bun 1.4.4, PostgreSQL 17.12, Swift 6.4.2)
| Command | Result |
|---|---|
| `bun run ci` (validate:package, license, gates:lock, lint, typecheck, test, build) | exit 0 — 25 tasks/DAG/contracts pass; 153 packages license-clean; **1236 tests pass, 0 fail** across 69 files (~193 s); Next build lists all new routes |
| `bun scripts/package-dispatch.ts` | package `dispatch-2.3.0-darwin-arm64`, tarball sha256 `f7ccc285995d18087383a8acd003eeec5717f0b554776bb7f2fb2824b0e31eb0` |
| `./install.sh` into a fresh fake `HOME`; `dispatch` from `/` in a scrubbed environment | installs, links, starts managed Postgres+API+dashboard, prints real health, REPL works, re-launch attaches, `dispatch stop --yes` leaves no process |
| `DISPATCH_HOME=… bun scripts/dispatch-pilot.ts` | real pilot **BLOCKED** (4 unmet gates); failing pilot **PASS (blocks safely)** — see `pilot-run.md` |
| `swiftc … main.swift; dispatch-menubar --selftest` | compiles; live status OK; negative cases refuse safely (DSP-09) |

## TESTS.md coverage (all automated, against the real API/Postgres/processes unless noted)
- **Unit:** CLI parser every command/missing args/invalid ids/unknown (`intent.test.ts`); lifecycle stale PID, duplicate lock, readiness vs liveness, failed dependency, timeout (`lifecycle.test.ts`); intent schema/ambiguity/invalid model output/immutable confirmations; context expiry/scoping/ambiguity; shared client idempotency/cursor/gap/dedupe (`sync.test.ts`).
- **Integration:** managed Postgres+API start with an injected missing optional (dashboard) and a pending-migration/required failure; two and three concurrent launchers → one owned instance; duplicate create with one idempotency key → one job; terminal (bearer) and browser (cookie) clients in sync; dropped streams reconnect from the cursor; registry/qualification status read without activating anything.
- **Security/adversarial:** prompt injection and malformed/over-privileged model output, shell/SQL-shaped ids, traversal, cross-organisation project/job/event isolation, stale confirmation (job changes mid-confirmation), wrong/expired credential, terminal escape sequences, secret not echoed, fail-closed when provider policy is unreadable, deterministic commands never call the interpreter and only issue GETs, `/shutdown` refusal and unknown slash commands, env stripping of provider variables.
- **Browser/E2E:** NOT performed with a real browser. Dashboard pages were fetched authenticated over HTTP from the packaged install and rendered/structure-checked in unit tests.

## User acceptance checklist (honest)
- [x] Fresh installed `dispatch` works from any directory (fake HOME, `/`, scrubbed env).  [x] Repeated launch does not duplicate services.  [~] Dashboard opens automatically unless `--no-browser` — logic and URL verification tested; the actual browser window was not observed.
- [x] Startup health reflects real service health.  [x] Interactive CLI with slash commands; [~] NL requests limited to fixed phrases (no qualified model).  [x] Deterministic commands invoke no AI.  [x] Router rejects malformed/unauthorized actions.
- [x] `/exit` leaves jobs running.  [~] Terminal and dashboard synchronised — shared engine tested against the real API; the browser pages are server-rendered and refresh on reload.  [x] Context scoped; ambiguity safe.  [x] Human approval for consequential changes (typed, revision-bound).
- [x] Models/skills show availability/qualification/authorization separately.  [x] No metered inference path.  [x] Recovery after process failure/restart.  [x] `/shutdown` stops only owned services and honours active jobs.  [~] Menu bar closes without stopping the factory — by construction and compile-verified, not clicked.
- [ ] **macOS packaged install completes one real coding pilot — BLOCKED.**  [x] Deliberately failing pilot blocks safely.

## The real authorized pilot — BLOCKED, reported truthfully
Unmet gates (from the live gate check): no configured runtime executable (`config/runtime-allowlist.json` empty), no model qualified for any role (`model-qualification.json` empty; the only measured model failed thresholds), no provider-terms approval (`provider-terms.json` empty), **no worker daemon exists in this repository to run jobs** (`apps/runner` is a library), and no GitHub App / disposable repository. The v2.1 release gates (ACT-01/02/03/06) are themselves `blocked` (`evidence/V21-RELEASE/report.md`). No draft PR was produced; none can be claimed. The "GitHub-linked project" gate in the pilot output only checks a `provider` label — the project there was inserted by hand into the throw-away database for the pilot demonstration and is not a real GitHub link.

## Defects found during verification (all fixed with tests)
`pg_ctl` option quoting with spaces in the macOS data path; dashboard process identity (Next rewrites its title); local routes shadowed by the v2 router; EOF crash in the prompt; flattened multi-line output; `owner/name` project references; an idempotent-activation race in the v2.2 skill registry (`APPROVAL_CONSUMED` instead of replay; 12/12 under CPU load after the fix); two time-margin fragilities in tests that failed only on a loaded machine (scheduler `T0`, real-process startup timeouts).

## Remaining external dependencies
A qualified local model or authorized subscription CLI with recorded provider terms; a worker daemon/runner process; a GitHub App and disposable repository; code signing/notarization for distribution; Linux/Windows support; a real-browser accessibility/E2E pass; launchd/background supervision of the factory.
