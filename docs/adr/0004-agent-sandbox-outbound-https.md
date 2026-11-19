# ADR-0004: how a model CLI (Claude Code) is confined when it must reach its provider

Status: **superseded in practice by the decision below** (2026-11-19). Not an independent security review.

## Context
The repo runs subscription CLIs inside an OS sandbox whose Seatbelt profile contains `(deny network*)`, so Claude Code (which must reach Anthropic) could never run there. `AGENTS.md` forbids weakening a safeguard without an ADR.

## What was tried
1. **Per-port outbound network in the sandbox** (`allowNetworkPorts`, macOS only; bwrap refuses). Implemented and tested with real processes (default deny; listed port reachable; unlisted port blocked). Kept as a capability, **not used** by Dispatch.
2. **Letting the sandboxed `claude` use the subscription login.** The login is in the macOS keychain. With network, `~/.claude`, the Keychains folders and the obvious keychain services allowed, `claude auth status` inside the sandbox still reported `loggedIn:false`; the extra rules were removed (unverified widening). The alternative, `CLAUDE_CODE_OAUTH_TOKEN`, is rejected by the repo's env policy (`_TOKEN$` names are forbidden) and was not weakened.

## Decision (operator: "run all this inside Claude")
Claude Code runs as the user, with its own login, **outside** the repo sandbox, started by `dispatch work` with: `--restricted` (no Bash/code tools, no web fetch, personal settings ignored, file tools confined to working folders), an allowlisted environment (no keys/tokens), the Dispatch plugin (planner command, tiered agents, tool server, a write guard on writers), and work only in a throwaway copy of the project, applied after a typed human approval bound to the diff digest. Agents authenticate to Dispatch with a separate `editor` identity that the API refuses for approval. See `docs/dispatch/AGENTS.md`.

## Consequences / residual risks
* No OS-level file boundary around Claude: confinement is Claude Code's own permission system, the plugin's guard hook, and Dispatch's server-side checks (scope check, recomputed diff, conflict refusal, warning when the real folder changes during a run).
* Anything in the project folder that Claude reads is sent to Anthropic; Claude's login is Claude Code's own and is never exposed to Dispatch code.
* Provider-terms approval (`config/provider-terms.json`, adapter `claude-code`) is required by `dispatch work` and is the operator's to record; Dispatch never writes it. Inference stays subscription-only (no API key anywhere); a rate limit stops the work.
