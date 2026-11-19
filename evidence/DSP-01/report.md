# DSP-01 — Single-command installation and launcher

**Status: implemented; verified locally on macOS (arm64) with a packaged install. Live browser opening was NOT observed on a display; see limits.**
Spec: `dispatch-v2.3/TASKS/DSP-01.md`. Branch `dev/v23-dispatch` (stacked on `dev/v22-sai`). Versions: Bun 1.4.4, Node v26.13.1, PostgreSQL 17.12, macOS 27.2.

## What exists
- `apps/dispatch-cli` — the `dispatch` program: `dispatch`, `start`, `status`, `doctor`, `stop [--yes]`, `migrate [--yes]`, `--no-browser`, `--help`, `--version` (and an internal `__serve api`).
- `packages/dispatch-core` — config (schema-versioned, strict), paths, startup lock, process identity, lifecycle engine.
- `scripts/package-dispatch.ts` + `packaging/dispatch/{install,uninstall}.sh` — builds a self-contained package: compiled single binary (`bun build --compile`, no global Bun needed), Next.js standalone dashboard, migrations, `SHA256SUMS`, tarball.
- API additions: `LocalOwnerAuthenticator` (per-install random token, loopback only), `bootstrapLocalOwner`, one-time browser entry (`/api/v1/local/enter`, `/api/v2/dispatch/browser-code`), `GET /api/v2/dispatch/summary`.

## Verification actually performed
| Check | Result |
|---|---|
| `bun scripts/package-dispatch.ts` | built; 140 MB dir, 51 MB tarball (sha256 recorded by the script) |
| Install into a throwaway `HOME` (`install.sh`) | installed under `Library/Application Support/Dispatch/versions/2.3.0`, symlink in `~/.local/bin`, PATH block added to the fake `.zprofile` only |
| Tampered package (`VERSION` altered) | **refused**: "checksum verification FAILED", exit 1 |
| "New terminal" (`env -i`, only the installed PATH, cwd `/`): `which dispatch`, `dispatch --version`, `dispatch doctor` | all correct; no Bun on PATH required |
| `dispatch --no-browser` from `/`, first use | postgres (managed) + API + dashboard online in 2.5 s; schema 0013 created; exit 0 |
| Browser sign-in flow (curl): mint code -> `/local/enter` -> cookie -> dashboard page | dashboard rendered authenticated data; same code reused -> 401 |
| `bun test apps/dispatch-cli apps/api/tests/dispatch.test.ts packages/dispatch-core` | all pass (see DSP-02 for the stack test) |

## Defects found by running it for real (all fixed, all with regression tests)
1. `pg_ctl -o` re-splits its option string through a shell; the macOS data dir is `.../Application Support/...` so Postgres refused to start. Fixed by quoting (`pgOptions`), plus a short-path fallback for the 103-byte unix-socket limit. A source-checkout test in `/tmp` could never have caught this.
2. Next.js rewrites its process title, so the `--dispatch-instance` marker never appeared in `ps`; the dashboard would never have been stopped. Fixed by also accepting a matching working directory (still requires the same PID and start time).
3. `/api/v2/dispatch/*` local routes were shadowed by the v2 router's 404; reordered.
4. `bun.exe` was not recognised as "script mode"; replaced the name check with an on-disk source-file check.

## Limits / not verified
- The browser was not actually opened on a display during these runs (`open` was not invoked with a GUI observer). URL verification (`verifiedLocalUrl`) and the no-shell argument-array launch are unit-tested; `--no-browser` and `browser.open=false` skip it.
- Not code-signed or notarized; Gatekeeper may quarantine a downloaded tarball (`xattr -d com.apple.quarantine`). Only darwin-arm64 was built.
- Linux/Windows are unsupported.
- No live provider, GitHub or model was involved (none is needed for this work order).
