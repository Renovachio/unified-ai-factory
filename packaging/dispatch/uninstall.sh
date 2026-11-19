#!/bin/sh
# Removes the installed program and PATH entry. Leaves your data (database, config, history) unless --purge-data is given.
set -eu
case "$(uname -s)" in Darwin) DATA="${DISPATCH_HOME:-$HOME/Library/Application Support/Dispatch}" ;; *) DATA="${DISPATCH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/dispatch}" ;; esac
BIN_DIR="${DISPATCH_BIN_DIR:-$HOME/.local/bin}"; PURGE=0
for a in "$@"; do [ "$a" = "--purge-data" ] && PURGE=1; done
if [ -x "$BIN_DIR/dispatch" ]; then "$BIN_DIR/dispatch" stop --yes || { echo "uninstall: could not stop the factory cleanly; stop it first (dispatch stop)" >&2; exit 1; }; fi
rm -f "$BIN_DIR/dispatch"; chmod -R u+w "$DATA/versions" 2>/dev/null || true; rm -rf "$DATA/versions"
for P in "$HOME/.zprofile" "$HOME/.bash_profile"; do [ -f "$P" ] && sed -i.bak '/# >>> dispatch >>>/,/# <<< dispatch <<</d' "$P" && rm -f "$P.bak"; done
if [ "$PURGE" -eq 1 ]; then chmod -R u+w "$DATA" 2>/dev/null || true; rm -rf "$DATA"; echo "Removed program AND data."; else echo "Removed program. Data kept in $DATA (use --purge-data to delete it)."; fi
