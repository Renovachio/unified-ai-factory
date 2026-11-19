# RUN-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-18
- **Candidate SHA:** c582918028c103c9b33f54df28bb1c3e4cc3dc7c (branch dev/run-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44424525540
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
- `packages/sandboxes/src/backends.ts`
- `packages/sandboxes/src/process.ts`
- `packages/sandboxes/tests/adversarial.test.ts`

## Notes
- `@factory/sandboxes`: OS-level confinement backends — macOS Seatbelt (`sandbox-exec`, deny-default profile: workspace-only read/write, no network) and Linux bubblewrap (`--unshare-all`, ro-bind system dirs, tmpfs /tmp); `NoIsolationBackend` fails closed (untrusted code is never run without confinement; `trusted_repository_only` needs explicit opt-in). Git worktrees are NOT treated as isolation.
- Workspace lifecycle: private 0700 per-task workspaces, safe id, `resolveInside` (traversal/absolute/NUL/symlink/dangling-symlink escapes), safe teardown (refuses anything not a direct child of the base, never follows symlinks, handles read-only trees), stale sweep for crash recovery.
- Git safety: `.git/config` rewritten as an allowlist (hooks, fsmonitor, sshCommand, aliases, credential helpers, filters, includes, non-https remotes dropped; hooksPath=/dev/null), all hooks removed, gitfile/symlink `.git` refused; `SAFE_GIT_ENV` neutralises system/global config.
- Secrets: sandbox env is built from scratch (never from process.env); credential-like names (API keys, tokens, AWS/GitHub/SSH agent, *_BASE_URL) rejected; output redacted.
- Supervision: own process group, timeout and AbortSignal cancellation with SIGTERM->SIGKILL escalation including backgrounded grandchildren, output cap, CPU and file-size ulimits.
- `apps/runner`: enrollment checks (not root, no credentials in the worker env, real isolation or explicit trusted mode), `runLeasedTask` (heartbeat; lease loss aborts the process group, removes the workspace and reports nothing for the stale attempt; cleanup status recorded before completion), `runOnce`.
- Adversarial suite proves: host file read/write blocked, home/ssh/aws paths unreadable, symlink-based escape blocked, other jobs' workspaces unreadable, loopback and metadata-IP network blocked (listener saw no connection), host env secrets never visible, poisoned git hooks/config neutralised, timeouts/cancel kill grandchildren, teardown safe.
- Platform caveats: Seatbelt (`sandbox-exec`) is deprecated by Apple but functional (macOS 27 verified locally); Linux bubblewrap path is verified in CI only (ubuntu-24.04 with unprivileged userns enabled). Quarantine-on-violation detection is NOT implemented here (a denied access is blocked but not auto-escalated); noted for ORC-001/OBS-001. A dedicated OS account for the worker remains an operator action.
- Quirk found: `ls /home` inside Seatbelt on macOS hangs on the autofs mount until the timeout kills it (contained, not an escape).
- Next: SCM-001.
- Fix after first CI run: bubblewrap `--clearenv` also wiped the scrubbed sandbox env on Linux (HOME/PATH missing); the scrubbed env is now re-applied with `--setenv` and covered by a unit test of the bwrap argv. Linux backend verified by the CI adversarial suite.
