# Operating Dispatch

- **State:** `~/Library/Application Support/Dispatch` (override `DISPATCH_HOME`): `config.json`, `state.json` (service records), `start.lock`, `logs/`, `pg/` (private PostgreSQL, unix socket only), `secrets/` (owner token, session secret; 0600), `sessions/`.
- **Config** (`config.json`, strict, schema-versioned; invalid files are never "repaired"): `host` must be `127.0.0.1`; `ports.api` (8787), `ports.web` (3000); `postgres.mode` `managed|external` (+`url`); `browser.open`.
- **Lifecycle:** `Stopped → Starting → Ready | Degraded | Failed`. The dashboard is optional (missing → Degraded). A required failure stops dependents from starting. The "Local runner" is *observed*: Dispatch does not run a worker daemon yet, so it reports Degraded until one registers.
- **Concurrency:** one startup lock; two terminals starting at once yield one set of services. Processes are identified by PID **and** start time (and instance marker or working directory), so a recycled PID is never signalled.
- **Crash recovery:** the next `dispatch` restarts only what is down. There is no background watchdog or launch-at-login for the factory itself (the optional menu-bar app can launch at login; the factory still needs `dispatch`).
- **Upgrading:** install the new package (`./install.sh`). The next `dispatch` reports the database as not ready with "pending migration(s)" (the factory is not started on an un-migrated database); run `dispatch migrate` (review and confirm, or `--yes`), then `dispatch`. Migration 0014 (local projects) is additive; its rollback refuses if local projects exist.
- **Migrations:** only run automatically for a database Dispatch just created. An existing database with pending migrations is reported "not ready"; review and run `dispatch migrate`.
- **Diagnostics:** `dispatch doctor` (read-only), dashboard `/diagnostics`, `bun scripts/diagnostics.ts`. Logs: `<home>/logs/`.
- **Pilot check:** `DISPATCH_HOME=… bun scripts/dispatch-pilot.ts` reports which real-pilot gates are unmet and runs the deliberately failing pilot.
