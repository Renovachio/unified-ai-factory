#!/bin/sh
# Supervised smoke test of the Dispatch plugin with a REAL Claude Code session (uses YOUR subscription). Run it yourself:
#   scripts/dispatch-smoke.sh          # launches Claude Code (interactive, restricted) on a SYNTHETIC transcript
#   scripts/dispatch-smoke.sh --print  # only prints the command; starts nothing
# Same launch shape as `dispatch work` (restricted mode, Opus, plugin, work folder, scrubbed environment), minus the Dispatch job.
set -eu
PRINT=0; [ "${1:-}" = "--print" ] && PRINT=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="${DISPATCH_PLUGIN_DIR:-$ROOT/packaging/dispatch/claude-plugin}"
case "$(uname)" in Darwin) HOMEDIR="${DISPATCH_HOME:-$HOME/Library/Application Support/Dispatch}";; *) HOMEDIR="${DISPATCH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/dispatch}";; esac
WORK="$HOMEDIR/work"; OUT="$WORK/smoke-meeting-notes"; SMOKE="${TMPDIR:-/tmp}/dispatch-smoke"; SMOKE="${SMOKE%/}"
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
set -- /usr/bin/env -i "HOME=$HOME" "PATH=$PATH" "TERM=${TERM:-xterm}" "LANG=${LANG:-en_US.UTF-8}" "SHELL=${SHELL:-/bin/sh}" "USER=${USER:-}" \
  claude "/dispatch:meeting-notes $SMOKE/transcript.txt $OUT" --restricted --model opus --plugin-dir "$PLUGIN" --add-dir "$WORK" \
  --allowedTools "Edit(/$WORK/**),Write(/$WORK/**)"
if [ "$PRINT" = "1" ]; then echo "cd $SMOKE &&"; printf ' %s' "$@" | sed 's/^ //'; echo; exit 0; fi
cat <<M
About to start Claude Code (your subscription) on a synthetic transcript. Expect: Opus coordinates, a Haiku reader and a Sonnet writer run,
notes are written to: $OUT/meeting-notes.md.  Afterwards this folder must NOT contain GUARD_PROBE.txt: $SMOKE
Press Ctrl-C now to cancel, or Enter to continue.
M
read -r _
cd "$SMOKE" && exec "$@"
