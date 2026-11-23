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

## Supervised smoke test (do this before trusting a real job)
`scripts/dispatch-smoke.sh` (use `--print` to only show the command) starts a real, interactive Claude Code session with the Dispatch plugin on a **synthetic** transcript (no real data is sent) using the plugin command `/dispatch:meeting-notes`. It exercises exactly the unverified items: plugin and command loading, Opus coordinating, a Haiku reader and a Sonnet writer, writes into the work folder (did it prompt?), and a deliberate **guard probe**: a write to `GUARD_PROBE.txt` outside the work folder that must be blocked. Pass criteria, checked on disk, not by what the model says: `<work>/smoke-meeting-notes/meeting-notes.md` exists and matches the transcript (owners, the 27th, the 10 percent launch, the open PDF and legal questions, nothing invented); `GUARD_PROBE.txt` does **not** exist next to the transcript (`~/dispatch-smoke`). The notes are under `~/Library/Application Support/Dispatch/work/` (Finder hides `~/Library`: use `open "$HOME/Library/Application Support/Dispatch/work"`). The session log under `~/.claude/projects/` shows which model each agent used. It uses your subscription and needs `dispatch` on your PATH (the guard is `dispatch guard-write`).

## Working in place: `dispatch code` (like `claude`, in the folder you are in)
```sh
cd ~/some/folder
dispatch code "what you want done"     # request is optional: it asks if you leave it out
dispatch changes                       # what changed since the snapshot
dispatch undo [--yes]                  # restore the snapshot (preview without --yes)
```
The folder you are in becomes the project (GitHub is not needed), the request is queued as a job, and Claude Code opens in it with the same Dispatch tools as `dispatch work` (command `/dispatch:code`). Opus plans; Haiku/Sonnet agents execute in parallel **on the real files**. Controls:
1. **Plan validation** as for `work` (≤12 tasks, ≤2 Opus, safe paths, parallel tasks write disjoint paths); an in-place plan must declare the paths it writes.
2. **Snapshot** of the folder (no `.git`, `.env`, keys, symlinks; max 5000 files / 200 MB) taken by Dispatch when the plan is accepted, not by the model.
3. **Plan-scoped write guard**, session-wide (applies to subagents): a write is allowed only inside the union of the paths the accepted plan declares, never `.git`, `.github`, `.env*`, keys or `node_modules`; with no accepted plan nothing is writable. The scope file is written by the API and removed when the run ends.
4. **Finish**: Dispatch recomputes the diff against the snapshot and fails the run (with an `undo` hint) if anything changed outside the plan.
5. **Review after the fact**: `/runs`, `/review` show the diff; `/accept` keeps the changes (type "keep"); `/discard` restores the snapshot (type "restore"). Both refuse if the folder changed after the review you saw (digest-bound). One in-place run per folder at a time.
6. No shell, web search or connectors; only the Dispatch tool server. Claude still asks before each file change, as usual.

7. **Per-wave file leases**: Claude passes `agent_id` (and `agent_type`) in the hook input for subagent writes (verified live, 2026-11-19; the main session has none). Within a wave the first agent to write a file owns it; a different agent writing the same file is refused. `dispatch_progress` (called after each wave) starts the next wave, which frees earlier files for later agents. Not enforced: which *task* an agent was given (the guard does not know the plan-to-agent mapping), so an agent may still write another task's file if the plan's union scope allows it and nobody has written it yet in that wave. Gives up compared with `dispatch work`: the approval comes after the files change, not before. **Not run live yet** with `dispatch code`: it needs your provider-terms approval, like `dispatch work`.

### What was verified live, and how (supervised, synthetic folders, your subscription, `claude -p`, restricted, compiled `dispatch guard-write`)
- Plugin loads; `/dispatch:meeting-notes` ran: Opus coordinated, Haiku read, Sonnet wrote (models read from the session event log, not from what Claude said).
- The frontmatter hook on the writer agent did **not** fire; the `--settings` PreToolUse hook did, for subagents. The guard blocked the out-of-folder write and `GUARD_PROBE.txt` did not exist afterwards.
- Restricted mode alone still exposed WebSearch and claude.ai connectors; `--tools` and `--strict-mcp-config` fixed that (init event lists exactly the six built-in tools and the Dispatch server).
- Hook input carries `agent_id`/`agent_type` for subagents. Three parallel writers with a plan scope of `src/`: one claimed `src/shared.txt`, the second was blocked by the lease (`shared.txt` contained only the first agent's text), a write to `outside.txt` was blocked by the scope, and the allowed write succeeded.
- **Still not run live:** `dispatch code` / `dispatch work` end to end (needs the provider-terms approval, which only you record), the Dispatch MCP tools from a real Claude session, `/review` `/accept` `/discard` on a real run.

## Plugin mode: use Dispatch from inside Claude (no provider-terms file needed)
```sh
dispatch plugin install        # once: builds a local marketplace from the shipped plugin and installs it with `claude plugin install`
cd ~/some/folder && claude     # you start Claude yourself
/dispatch:do add a footer to every page
```
Here **Dispatch launches nothing**: you run Claude Code, and Dispatch is a plugin (command `/dispatch:do`, five MCP tools, a write-guard hook). That is why the launcher's provider-terms gate (`dispatch work`, `dispatch code`) does not apply: Dispatch does not automate your subscription, you use Claude Code interactively. Whether that is acceptable under Anthropic's terms is your call; Dispatch does not decide it.
What it does: `dispatch_begin` registers the folder Claude was started in and queues your request (it starts the factory if it is not running), Opus plans with `dispatch_start_run` (validated, snapshot, plan scope), cheaper agents execute in parallel, `dispatch_finish_run` measures the diff; you keep or restore with `/accept` `/discard` in `dispatch`, or `dispatch undo` in the folder.
**Compared with the launcher modes you lose:** `--restricted` and the explicit tool list (plain Claude keeps Bash and the web: the write guard covers only Write/Edit tools, so a Bash command can still write anywhere your Claude permissions allow), strict MCP (your other connectors stay), the scrubbed environment, and the guarantee that a run happens through Dispatch at all (nothing forces you to use `/dispatch:do`). The guard hook is installed for every session while the plugin is enabled, but acts only while a Dispatch run is active for the folder; before `dispatch_start_run` and after the run ends, Claude writes unguarded. At finish Dispatch still recomputes the diff and fails the run if anything changed outside the plan.

### Plugin mode, verified live (2026-11-20, plain `claude -p` with `--plugin-dir`, compiled binary, sandboxed Dispatch home and ports)
`/dispatch:do` from an ordinary Claude session: the MCP server connected and auto-started the factory; `dispatch_begin` registered the folder and queued the job; the plan (haiku, sonnet, sonnet) was accepted in place with a snapshot; a Haiku agent read, two Sonnet agents wrote in parallel (models read from the event log); the plugin's `--from-cwd` hook blocked an undeclared `notes.txt` (file absent afterwards); the API listed the run `awaiting_approval`/`in_place` with the exact diff; `dispatch changes` matched it; rejecting through the API restored `src/app.txt` and removed `docs/overview.md`; `.env` untouched. **Not verified:** installing through `dispatch plugin install` into your real Claude (only into a sandbox HOME), that the command's `model: opus` switches the model (the test session already ran Opus), and the keep path via the dashboard/terminal `/accept` prompt text.

## Project memory (what Claude remembers about a project)
* **You** record and approve it, in the project folder: `dispatch memory note <text>` (becomes *proposed*, inert), `dispatch memory list proposed`, `dispatch memory approve <id>` or `reject <id>`. `dispatch memory revise <id> <text>` proposes a correction to an approved memory (approve it to replace the old one), `erase <id>` removes a proposed/rejected/superseded memory, `export` prints everything as JSON. `dispatch memory consent on|off` controls whether anonymous "memory was missing" signals go to the improvement supervisor (default off).
* **Claude** gets two extra tools, `dispatch_memory` (read approved memory relevant to the task, framed as reference data) and `dispatch_memory_feedback` (useful / wrong / stale / missing). It cannot write, approve, reject, erase or change consent; the API refuses the agent token for those routes.
* Notes are proposed by the dispatch agent identity and approved by you, so the "author cannot approve their own memory" rule holds for one person.
* Retrieval is lexical (no embedding model is qualified). Rendered packs are stored under `<Dispatch home>/memory-packs`. The retention sweep (`docs/operator/MEMORY_RETENTION.md`) is not scheduled yet.

