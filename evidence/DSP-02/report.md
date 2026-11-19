# DSP-02 — Idempotent service lifecycle and health

**Status: implemented; verified locally with real processes (separate OS processes, real PostgreSQL, real API). No launchd integration.**
Spec: `dispatch-v2.3/TASKS/DSP-02.md`. Tests: `packages/dispatch-core/tests/lifecycle.test.ts` (14), `apps/dispatch-cli/tests/{launcher,stack}.test.ts` (10), `apps/api/tests/dispatch.test.ts` (5).

## Design
`Stopped -> Starting -> Ready | Degraded | Failed`, `Degraded -> Ready | Stopping`, `Failed -> Starting`, `Ready -> Stopping -> Stopped` — illegal edges throw (`IllegalTransition`). Services: PostgreSQL (managed, or **external**: never started/stopped/migrated), API (required), dashboard (optional -> Degraded), runner (observed only). Liveness vs readiness are distinct probes; managed vs external is reported per service. Startup is serialised by a cross-process lock whose holder is validated by PID **and** start time (a stale or PID-reused lock is reclaimed; reclaim renames first so two reclaimers cannot both win). Supervisor state lives in `state.json` (0600), independent of any REPL. Ownership of a process = same PID, same start time, and either the instance marker in its command line or its launch working directory — never a PID alone. `stop` signals only owned processes (SIGTERM, then SIGKILL after re-verifying identity), never external ones, and refuses with in-flight jobs unless confirmed. Existing databases are **never migrated implicitly**: pending migrations make the database "not ready" with the instruction to run `dispatch migrate`; only a database that Dispatch itself just created gets its initial schema.

## Evidence (observed)
- Two concurrent launcher OS processes -> exactly one service process, both report ready (`ps` count = 1).
- Three concurrent real `dispatch start` processes -> exactly one `__serve api` process.
- Launcher exits (terminal closed) -> service keeps running; later launch re-attaches to the same PID.
- Stale record (dead PID, or an unrelated `sleep` that "reused" the PID with a different start time) -> record dropped, a fresh service started, the unrelated process **not signalled** (asserted alive).
- `stop` with 3 in-flight jobs unconfirmed -> refused; confirmed -> owned processes gone, no listener, no lock, phase Stopped; an external service in the same spec is reported `left-external` and untouched.
- API SIGKILLed -> `status` shows it Stopped; next start restarts only the API and reuses the same database process.
- Pending migration (deleted `0013` row) -> start fails, database "failed: 1 pending migration(s) (0013): review and run `dispatch migrate`", API/dashboard "not started".
- Required failure => Failed with dependents not started; optional failure => Degraded; bounded readiness wait (fake clock) => failed with the timeout in the message.
- Packaged install, from `/`: start -> re-launch attaches (no duplicates) -> `status` Ready -> `stop --yes` -> zero Dispatch/Postgres processes left.
- Model-provider variables (`ANTHROPIC_*`, `OPENAI_*`, `*_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, ...) are detected, warned about, and stripped from every child environment (allowlisted env only).

## Limits / not verified
- No launchd/login-item integration: services are detached children, not restarted at login or after a reboot (state is correctly recovered on the next `dispatch`).
- **No worker daemon exists in this repository** (`apps/runner` is a library of `runOnce`), so "Local runner" is *observed* (workers registered in the database) and reports "no worker registered" rather than Ready. Dispatch cannot yet start one.
- Crash recovery is by the next launch, not an active watchdog.
- Linux/Windows process-identity paths (`ps`/`lsof` parsing) are only exercised on macOS.
