# Claude Code as Dispatch's workforce

`dispatch work` starts **Claude Code** on the oldest queued local-folder job. Opus plans; cheaper agents execute in parallel; everything happens in a **copy** of your folder; nothing reaches your real folder until you approve a diff in Dispatch.

## One-time setup (yours, not Dispatch's)
1. **Provider terms.** Read Anthropic's terms for using Claude Code this way and, if you accept them, add an entry for adapter `claude-code` to `config/provider-terms.json` (fields: `adapterId`, `provider`, `termsUrl`, `termsReviewedOn`, `approvedBy`, `scope`, optional `expiresOn`). Dispatch never writes this file and `dispatch work` refuses to start without it. See `docs/third-party/provider-terms/README.md`.
2. Claude Code installed and logged in with your subscription (`claude auth status`). Dispatch never reads or stores your login and never uses an API key.

## Daily use
```sh
dispatch --project ~/Documents/MeetingNotes make meeting notes from the transcript   # queue the request
dispatch work                                                                        # Claude does it, in a copy
dispatch                                                                             # then: /runs  /review  /accept  (or /discard)
```
`/accept` shows the diff again and needs you to type `apply`. The approval is bound to the digest of exactly what you reviewed. If you edited the same file meanwhile, nothing is applied and the conflict is named.

## How the work is organised
* `/dispatch:work` (Claude Code plugin shipped with Dispatch) makes **Opus** read the request and the project (read-only) and submit a **plan**: tasks, each with a model tier (`haiku` reads/extracts, `sonnet` writes/edits, `opus` only for judgement, at most 2), the paths it may write, and its dependencies.
* Dispatch validates the plan (strict schema; ≤12 tasks; no unsafe paths; **tasks that can run in parallel must write different paths**) and returns waves. Opus launches each wave's agents in parallel with Claude Code's own subagent mechanism (`dispatch-reader` on Haiku, `dispatch-writer` on Sonnet).
* Agents write **only** inside the work copy. When Opus calls `dispatch_finish_run`, **Dispatch recomputes the diff itself**; a change outside the plan's write scopes fails the run.
* Cost control: the plan's relative cost (haiku 1 / sonnet 3 / opus 15, a heuristic, not tokens), the caps above, and subscription limits (when one is hit the job pauses; there is no paid-API fallback).

## What protects your files (defence in depth)
| Layer | Enforced by |
|---|---|
| Claude runs with `--restricted`: no Bash/code tools, no web fetch, your personal settings ignored, file tools confined to the project + work folder | Claude Code |
| Claude's environment is an allowlist (`PATH HOME USER SHELL TERM LANG…`): no API keys, cloud or GitHub tokens, proxies | Dispatch (`claude-launch.ts`) |
| Writers carry a `dispatch guard-write` hook that denies any write outside the work folder | plugin + Dispatch |
| The tool server `dispatch mcp` has **four tools and no approval tool**; it uses a separate **agent token** (role `editor`) that the API refuses for approval | Dispatch API (RBAC) |
| The diff is measured by Dispatch, scope-checked, and applied only after a typed human approval bound to its digest; nothing is overwritten if your file changed | Dispatch API |
| If your real folder changes while a run is in progress, the run log and finish reply carry a warning | Dispatch API |
| Secrets (`.env`, keys, `.git`, `node_modules`, symlinks) are never copied into the work copy, so they cannot be changed or applied back | Dispatch |

## What is NOT verified, and limits
* **Never run against a real Claude session.** Tested: the plan validator, copy/diff/apply, the API, the MCP server (over stdio against the real API), the write guard, the REPL approval flow, and `dispatch work`'s launch (with a stand-in `claude` that records its arguments). Unverified until your first supervised run: that the plugin loads as intended, that `/dispatch:work` runs as the initial prompt, that subagents honour their `model:` and `tools:` settings, that the per-agent write-guard hook fires, that the `Edit(//…)`/`Write(//…)` permission pattern pre-approves the work folder (if not you will simply be asked), and how good the results are.
* Claude Code's `--restricted` mode and permissions are **software** limits; there is no OS sandbox around Claude here (see ADR-0004: the repo's sandbox blocks the network Claude needs and could not carry its keychain login). Claude can still read what Claude Code can read in the project folder and sends it to Anthropic as part of normal use.
* Subagent depth: Opus coordinates and its subagents do the work; Claude Code subagents are not expected to spawn their own.
* The copy excludes big folders (limits: 5000 files, 200 MB, 20 MB per file). Applying is all-or-nothing per approval but is not a single atomic filesystem transaction.
* Jobs on local folders stay in state `QUEUED` in `/jobs` (the GitHub job state machine does not apply); their status is the run status in `/runs`.
* Linux, a Dashboard view of runs, and unattended (`claude -p`) operation are not implemented.
