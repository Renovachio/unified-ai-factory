# logbook slice 1: evidence

Date: 2026-11-24. Claude Code 2.1.331. Not committed yet.

## Built
- `hooks/memory-core.ts`: kinds, lifecycle (active ↔ superseded/revoked), file format, ids.
- `hooks/index-core.ts`: EN+PT tokens with light stemming and accent folding, BM25, overlap for dedupe.
- `hooks/pack-core.ts`: standing pack (system prompt, 3000 chars) and recall block (beside a prompt, 1500 chars).
- `hooks/extract-core.ts`: capture prompt, untrusted reply parsing and validation, plan (dedupe, supersede only active held ids).
- `hooks/book.ts`: both layers on disk through an `Io` seam, apply/setStatus/undo-batch, broken files listed.
- `hooks/register.ts`: prompt.compose, prompt.submit, session.compact, turn.complete, session.end, tools remember/recall/forget, /memory.

## Checks run
| Command | Result |
|---|---|
| `claude plugin test .` | 23 pass, 0 fail (16 pure-core, 7 through the engine host with an in-memory fs and a stubbed model) |
| `claude plugin validate .` | passed; 0 type errors; warnings only for marketplace listing (no icon, no install line) |

## Not verified
- No live Claude Code session yet: hook firing order in a real session, `session.compact` capture timing, the `$.clock.after` capture surviving the hook, `$.fs` writes to `~/.claude/...`, toast display, and capture quality and cost on real conversations.
- Recall quality is unbenchmarked (lexical only).

## Manual smoke test (next)
1. `mkdir /tmp/lb && cd /tmp/lb && claude --plugin-dir ~/Documents/Dispatch/logbook`
2. "Remember that this project uses bun, never npm." → a file appears in `/tmp/lb/.claude/logbook/memory/`.
3. `/clear`, then "how do I install deps?" → the answer uses bun; `/memory` shows it ★.
4. Talk through a decision for a few turns, then `/compact` → toast "saved N memories"; `/memory` lists them; `/memory undo` revokes them.
5. "Remember I prefer short answers" (preference) → appears in `~/.claude/logbook/memory/`; open Claude in another folder and confirm it is in `/memory`.
6. `/cost` → the capture's haiku spend.
