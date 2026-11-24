#!/bin/sh
# Supervised smoke test of the Dispatch plugin with a REAL Claude Code session (uses YOUR subscription). Run it yourself:
#   scripts/dispatch-smoke.sh          # launches Claude Code (interactive, restricted) on a SYNTHETIC transcript
#   scripts/dispatch-smoke.sh --print  # only prints the command; starts nothing
# Same launch shape as `dispatch work` (restricted mode, Opus, plugin, work folder, scrubbed environment), minus the Dispatch job.
set -eu
PRINT=0; [ "${1:-}" = "--print" ] && PRINT=1
HEADLESS=0; [ "${1:-}" = "--headless" ] && HEADLESS=1   # non-interactive (claude -p): used when an agent runs the test; output to $SMOKE/run.jsonl
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="${DISPATCH_PLUGIN_DIR:-$ROOT/packaging/dispatch/claude-plugin}"
case "$(uname)" in Darwin) HOMEDIR="${DISPATCH_HOME:-$HOME/Library/Application Support/Dispatch}";; *) HOMEDIR="${DISPATCH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/dispatch}";; esac
WORK="$HOMEDIR/work"; OUT="$WORK/smoke-meeting-notes"; SMOKE="${DISPATCH_SMOKE_DIR:-$HOME/dispatch-smoke}"
command -v claude >/dev/null || { echo "claude not found on PATH" >&2; exit 1; }
command -v dispatch >/dev/null || { echo "dispatch not found on PATH (the write guard is 'dispatch guard-write')" >&2; exit 1; }
mkdir -p "$WORK" "$SMOKE"; rm -f "$SMOKE/GUARD_PROBE.txt"; rm -rf "$OUT"
cat > "$SMOKE/transcript.txt" <<'T'
Weekly product sync, 18 November 2026.
Present: Ana (product), Bruno (engineering), Carla (design).
Ana: We agreed last week to ship the export feature. Bruno, is the CSV format settled?
Bruno: Yes, CSV with UTF-8, semicolon separated because of the Brazilian locale. I'll have the API change ready by Friday the 27th.
Carla: The export button needs a loading state. I'll send the mock-ups on Wednesday.
Ana: Decision: we launch export to 10 percent of users first. Nobody has decided yet whether to add a PDF option.
Bruno: Someone should ask legal whether exported files may contain email addresses.
Ana: I'll ask legal and report back next sync.
T
# DISPATCH_SMOKE_ISOLATE_GUARD=1: ALSO pre-approve writes in the probe folder, so Claude's permission system would allow the probe and ONLY Dispatch's guard hook can block it.
ALLOW="Edit(/$WORK/**),Write(/$WORK/**)"; [ "${DISPATCH_SMOKE_ISOLATE_GUARD:-}" = "1" ] && ALLOW="$ALLOW,Write(/$SMOKE/**),Edit(/$SMOKE/**)"
SETTINGS='{"hooks":{"PreToolUse":[{"matcher":"Write|Edit|MultiEdit|NotebookEdit","hooks":[{"type":"command","command":"dispatch guard-write"}]}]}}'
MCP='{"mcpServers":{"dispatch":{"command":"dispatch","args":["mcp"]}}}'
set -- /usr/bin/env -i "HOME=$HOME" "PATH=$PATH" "TERM=${TERM:-xterm}" "LANG=${LANG:-en_US.UTF-8}" "SHELL=${SHELL:-/bin/sh}" "USER=${USER:-}" \
  claude "/dispatch:meeting-notes $SMOKE/transcript.txt $OUT" --restricted --model opus --plugin-dir "$PLUGIN" --add-dir "$WORK" \
  --allowedTools "$ALLOW" --settings "$SETTINGS" --tools "Task,Read,Glob,Grep,Write,Edit" --mcp-config "$MCP" --strict-mcp-config
if [ "$PRINT" = "1" ]; then echo "cd $SMOKE &&"; printf ' %s' "$@" | sed 's/^ //'; echo; exit 0; fi
[ "$HEADLESS" = "1" ] || cat <<M
About to start Claude Code (your subscription) on a synthetic transcript. Expect: Opus coordinates, a Haiku reader and a Sonnet writer run,
notes are written to: $OUT/meeting-notes.md
Afterwards check (copy-paste):
  open "$OUT"                      # the notes (inside ~/Library, which Finder hides; this opens it)
  ls "$SMOKE"                      # transcript.txt only: GUARD_PROBE.txt must NOT be here
Press Ctrl-C now to cancel, or Enter to continue.
M
if [ "$HEADLESS" = "1" ]; then
  cd "$SMOKE" && exec "$@" -p --output-format stream-json --verbose --include-hook-events > "$SMOKE/run.jsonl" 2> "$SMOKE/run.err"
fi
read -r _
cd "$SMOKE" && exec "$@"
