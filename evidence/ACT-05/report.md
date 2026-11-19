# ACT-05 — Security hardening (v2.1)

**Status: `in_progress`.** Verified on macOS 27.2.1 (Seatbelt) with a temp Postgres 17 cluster. Linux bubblewrap coverage runs in CI only; nothing here was run against a container/cloud isolation layer.

## Baseline (v2.0 audit)
Existing: Seatbelt/bwrap sandbox with `(deny network*)`, path-escape/symlink guards, git hook/config sanitising, process-group kill, forbidden-env policy, secret broker that quarantines workers requesting credentials, append-only tables, prompt-injection fixtures, 31 adversarial sandbox tests. Gaps found below.

## SEC task status
| Task | Result |
|---|---|
| SEC-01 filesystem | Existing traversal/symlink/workspace-escape suites pass. New: host credential stores (ssh, gh, claude, codex, git-credentials, netrc, aws, shell history) and host-home listing unreadable from inside the sandbox. |
| SEC-02 processes | Existing process-group termination/resource-limit tests unchanged and passing. |
| SEC-03 egress | **New OS-level proof**: metered hosts by name, raw IPv4/IPv6, decimal/hex IP forms, localhost, with proxy/base-url variables set, and DNS — all unreachable from inside the sandbox; the host listener saw 0 connections. New fail-closed `verifySandboxEnforcement` self-test (network + host read + host write probes). |
| SEC-04 secret isolation | **New**: with GitHub App key, merge token, session/OIDC secrets, DB URL, SSH agent and provider keys all set in the host process, the sandbox `env` contains none; credential-shaped names are refused even via `extra`. **Gap fixed**: `DATABASE_URL`, `PG*`, `*_DSN`, `SESSION_*` were not in the forbidden-name list. |
| SEC-05 privilege separation | **New migration 0010_db_roles**: `factory_runner`, `factory_merge`, `factory_control` NOLOGIN roles with least-privilege grants. Verified with the real scheduler running as `factory_runner` (claim/heartbeat/event/complete work); runner cannot touch approvals, merge intents, users/sessions, credential references, policy, auto-merge controls, job state (column-level grant: `event_seq` only), audit/event deletes; merge role cannot create approvals or read users/sessions; control plane cannot write merge intents. **Not done**: separate OS processes/deployment units and separate login credentials per component — the repository ships roles and tests, deployment must create LOGIN roles per process. |
| SEC-06 prompt injection | Existing intake/review/spec hostile-fixture suites pass (unchanged). No new model-level tests (no qualified model). |
| SEC-07 redaction | **Real gaps found and fixed**: Basic auth, URL credentials, Cookie/Set-Cookie (incl. the new session cookie), query-string tokens, `client_secret`/`code_verifier`, env-style `*_KEY=`/`*_SECRET=`, OIDC `code=` were not redacted. 20 new tests incl. stack traces, error causes, no-over-redaction, and a 64 kB hostile-input timing test (my first version of the new patterns had unbounded quantifiers that slowed the whole suite ~2x; bounded now). |
| SEC-08 adversarial | Existing suites cover review bypass, forced PREMERGE without approval, self-approval, stale-SHA approvals, forged webhook signatures; new ACT-04 suite covers approval-role spoofing via sessions. No external pen-test. |

## Tests
`bun test --timeout 30000`: **989 pass / 0 fail** (45 files); lint clean; typecheck clean. The `--timeout 30000` flag was added to the `test` script because heavy end-to-end tests exceed Bun's 5 s default under full-suite load (assertions unchanged).

## Acceptance criteria
- [x] Worktrees/sandboxes cannot read/write outside allowed paths (macOS Seatbelt).
- [x] An agent cannot access merge credentials (env + filesystem + DB role) or authorise itself (existing self-approval guards + role grants).
- [x] Egress restrictions stop prohibited model traffic in practice (OS-enforced, not config).
- [x] Secret exfiltration attempts reveal nothing via output/logs.
- [x] Critical adversarial tests pass with actual enforcement.
- [x] If isolation is unavailable execution is blocked (`SANDBOX_NOT_ENFORCED`, self-test; `NoIsolationBackend` never reports enforced).
- [~] Linux/bwrap and container/cloud enforcement: CI only / not exercised.

## Unresolved risks (owner: operator)
1. Per-process LOGIN roles/credentials and deployment separation are not provisioned by this repository.
2. Gate/test commands that run inside the sandbox have no dependency installation path (offline sandbox).
3. Seatbelt (`sandbox-exec`) is deprecated by Apple; verify after OS upgrades.
