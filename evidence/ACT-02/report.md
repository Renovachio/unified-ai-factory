# ACT-02 — End-to-end coding pilot (v2.1)

**Status: `blocked`.** Not attempted; every precondition is missing, so a "pilot" would only be a mock.

## Blockers
1. No **qualified builder model** for any (runtime, model, prompt, toolset, role) — see `evidence/ACT-06/report.md` (dataset 12 builder tasks vs >= 30 required; `qwen3.5:4b` fails EVAL-001).
2. **Provider terms** for subscription CLIs are not approved (`config/provider-terms.json`); the Claude Code / Codex adapters stay disabled.
3. No **GitHub App** and no **disposable protected repository** (`Renovachio/unified-ai-factory` must not be the target without explicit approval).
4. No independent human reviewer assigned for the pilot PRs.

## Safe preparation that exists
The controlled local tool loop, the sandbox enforcement self-test, the runtime selection with `MODEL_NOT_QUALIFIED` fail-closed, and the pilot fixture used by `packages/evals` tests (local, fake GitHub over real HTTP).

## Exit criteria to unblock
A recorded provider-terms approval or a role-qualified local model; a throwaway repo with branch protection; a GitHub App scoped to it; then run >= 3 tasks end to end with a human reviewing every draft PR and record real outputs here. Auto-merge stays disabled throughout.
