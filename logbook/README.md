# logbook

Memory for Claude Code sessions. logbook keeps the decisions, constraints, requirements and preferences that come up while you work, and brings the relevant ones back in later sessions, so you stop re-explaining your project.

It is a Claude Code mod (function hooks); no server, no database, no API key.

## How it works
- **Two layers.** Project memories live in the folder you work in (`<folder>/.claude/logbook/memory/`, one Markdown file each, reviewable in git if the folder is a repo). Personal memories (how you like to work) live in `~/.claude/logbook/memory/` and apply in every folder.
- **Standing pack.** Constraints, preferences, requirements and decisions go into the system prompt as one section, within a budget.
- **Recall.** Each prompt you send gets the memories that match it attached beside it (never shown, prompt cache untouched).
- **Capture, auto-approved.** Before a compaction and every 20 turns, a cheap model (haiku, through your own session) reads the recent conversation and proposes memories. logbook validates them, skips duplicates, and saves the rest as active at once; a newer memory that contradicts one supersedes it, and the link is kept. A toast tells you what was saved.
- **Claude can save and look up** with the tools `remember`, `recall` and `forget`.

## Commands
```
/memory               active memories (★ standing, ◆ recalled this session)
/memory all           including superseded and revoked
/memory search <q>    search both layers
/memory forget <id>   revoke one          /memory restore <id>
/memory undo          revoke the newest capture batch
/memory capture       capture from this conversation now
/memory mode [on|read|off]   read: inject only, no capture
/memory reload        re-read files after editing them by hand
```
A file `.claude/logbook/mode` in a folder pins the mode there.

## Try it
```sh
claude --plugin-dir /path/to/logbook
```

## Develop
```sh
claude plugin test .       # unit and engine tests
claude plugin validate .
```

## Limits (v0.1)
Lexical search only (English and Portuguese stemming); characters stand in for tokens; capture spends a small haiku call on your subscription, shown in `/cost`; nothing is shared between machines except through the files themselves.

## Credits
Ideas from [helm](https://github.com/ninjanazal/helm) (MIT, Eurico Martins) — the mod structure, a system-prompt section per concern, per-folder pin files. No helm code is included in this version. See NOTICE.
