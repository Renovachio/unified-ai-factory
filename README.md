# Unified AI Factory and logbook

This repository holds two projects:

| Project | Path | What it is |
|---|---|---|
| **Unified AI Factory** (with the `dispatch` command) | [`unified-ai-factory-v2/`](unified-ai-factory-v2/) | A software factory: a request goes through intake, spec, build, quality gates, review, policy checks and a guarded merge. A human approves by default. |
| **logbook** | [`logbook/`](logbook/) | A Claude Code plugin that remembers decisions, constraints and preferences across sessions. |

---

## 1. Unified AI Factory

### What it does
- Takes a request from intake to a merged change, in stages: intake → spec → build → gates → review → policy → guarded merge.
- Keeps a human in the loop by default. High and critical risk changes never merge unattended, and an approval is bound to the exact commit SHA that was reviewed.
- Makes no metered model API calls. Inference is limited to a local model or a subscription CLI, and subscription CLIs stay disabled until provider terms are recorded as approved.
- Ships as a Bun/TypeScript monorepo with an HTTP API, a worker runner, a Next.js dashboard, and the `dispatch` command-line front end (macOS, Apple silicon).

### Status
Built and passing its own CI, **not production-ready**. It has not run against a real GitHub App, a real Claude Code or Codex runtime, a cloud provider, or real project data. No model currently qualifies for real work: the only one measured fails the quality thresholds. Open operator actions and known limits are in [`docs/operator/OPEN_ACTIONS.md`](unified-ai-factory-v2/docs/operator/OPEN_ACTIONS.md).

### Run it from source
Requires Bun 1.4.4 and PostgreSQL 17. Tests start a temporary database cluster.

```sh
cd unified-ai-factory-v2
bun install
bun run ci          # package check, license check, gates lock, lint, typecheck, tests, build
bun run demo        # seeded demo with synthetic data
```

`bun run demo` starts a throwaway Postgres, seeds example skills and proposals, and serves the API on `127.0.0.1:8787` and the dashboard on `127.0.0.1:3000`. Open `http://127.0.0.1:8787/demo/login` to pick an identity, then visit `/skills` and `/improvements`. The demo login exists only in `scripts/demo.ts`, is loopback-only, and must never be used in a deployment.

### Install the `dispatch` command (macOS, Apple silicon)
Requires PostgreSQL 17 (`brew install postgresql@17`). Dispatch runs its own private database cluster on a unix socket and binds its services to `127.0.0.1`.

```sh
cd unified-ai-factory-v2
bun install
bun scripts/package-dispatch.ts                       # builds dist/dispatch-2.3.0-darwin-arm64/
cd dist/dispatch-2.3.0-darwin-arm64 && ./install.sh   # no sudo; installs to ~/Library/Application Support/Dispatch
dispatch doctor                                       # read-only health check
dispatch                                              # start, open the dashboard, enter the prompt
```

Bun is not needed to run the installed command. The package is unsigned, so macOS may quarantine a downloaded tarball (`xattr -d com.apple.quarantine <file>`).

| Command | Purpose |
|---|---|
| `dispatch` | Start or attach to the factory, open the dashboard, enter the prompt |
| `dispatch <request>` | Create a request in the active project, e.g. `dispatch add dark mode to settings` |
| `dispatch --project <folder> [request]` | Use a local folder as the project. GitHub is optional. Dispatch will not register system, credential or app-data folders. |
| `dispatch status` / `doctor` / `start` / `stop` / `migrate` | Report health, diagnose, start or stop services Dispatch owns, apply migrations |
| `dispatch plugin install` | Add Dispatch to Claude Code as a plugin, so you can use `/dispatch:do <request>` from your own `claude` session |
| `dispatch work` / `dispatch code` | Ask Claude Code to do queued work or edit the current folder. You review the diff before it is applied. **Not yet verified against a live Claude session.** |

Useful commands inside the prompt: `/jobs`, `/projects`, `/project use`, `/approvals`, `/approve <id>`, `/cancel <id>`, `/logs <id>`, `/dashboard`, `/help`, `/exit`. `/exit` leaves jobs running. `/shutdown` stops only services Dispatch started.

Plain sentences are matched against a small fixed set of phrases (for example, "show my jobs"). Anything else is refused until a qualified, authorized model interpreter is configured. Requests stay `QUEUED` until a worker with a qualified model exists, so today a new request will wait rather than run.

Full details: [`docs/dispatch/INSTALLATION.md`](unified-ai-factory-v2/docs/dispatch/INSTALLATION.md), [`docs/dispatch/COMMANDS.md`](unified-ai-factory-v2/docs/dispatch/COMMANDS.md), [`docs/dispatch/OPERATIONS.md`](unified-ai-factory-v2/docs/dispatch/OPERATIONS.md), [`docs/dispatch/SECURITY.md`](unified-ai-factory-v2/docs/dispatch/SECURITY.md).

### Layout
- `apps/api`, `apps/runner`, `apps/web`, `apps/dispatch-cli`, `apps/dispatch-menubar` (optional Swift menu bar)
- `packages/*` for the domain model, database, scheduler, sandboxes, SCM, runtimes, orchestrator, gates, skills, memory and evals
- `migrations/` reversible SQL migrations, `CONTRACTS/` JSON schemas and OpenAPI, `config/` policies and gate manifests
- `docs/` architecture decisions, security, operator notes and the blueprint; `evidence/` per-task acceptance reports and eval results

Start with [`unified-ai-factory-v2/README.md`](unified-ai-factory-v2/README.md), then [`ARCHITECTURE.md`](unified-ai-factory-v2/ARCHITECTURE.md) and [`SECURITY.md`](unified-ai-factory-v2/SECURITY.md).

---

## 2. logbook

### What it does
logbook keeps the decisions, constraints, requirements and preferences that come up while you work with Claude Code, and brings the relevant ones back in later sessions, so you stop re-explaining your project.

- **Two layers.** Project memories live in `<folder>/.claude/logbook/memory/`, one Markdown file each, which you can review in git. Personal memories live in `~/.claude/logbook/memory/` and apply in every folder.
- **Standing memories** (constraints, preferences, requirements, decisions) go into the system prompt, within a size budget.
- **Recall.** Each prompt gets the memories that match it, added beside the prompt and not shown to you.
- **Capture.** Before a compaction and every 20 turns, a small haiku call reads the recent conversation and proposes memories. Duplicates are skipped. A newer memory that contradicts an older one supersedes it, and the link is kept. A toast reports what was saved.
- Claude can also save and look up memories itself with the `remember`, `recall` and `forget` tools.

It is a Claude Code plugin with no server, no database and no API key. Capture uses a small call on your own Claude Code session.

### Use it
```sh
claude --plugin-dir ./logbook        # run Claude Code with logbook loaded
```

Inside Claude Code:

```
/memory               active memories (★ standing, ◆ recalled this session)
/memory all           include superseded and revoked
/memory search <q>    search both layers
/memory forget <id>   revoke one          /memory restore <id>
/memory undo          revoke the newest capture batch
/memory capture       capture from this conversation now
/memory mode [on|read|off]   read: inject only, no capture
/memory reload        re-read files after editing them by hand
```

To pin the mode for one folder, put `on`, `read` or `off` in `.claude/logbook/mode`.

### Develop and test
```sh
cd logbook
claude plugin test .
claude plugin validate .
```

### Limits (v0.1)
Lexical search only, with English and Portuguese stemming. Nothing is shared between machines except the memory files themselves. Adapted ideas from [helm](https://github.com/ninjanazal/helm) (MIT); see [`logbook/NOTICE`](logbook/NOTICE).
