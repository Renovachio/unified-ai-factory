#!/bin/sh
# Dispatch installer. Installs a versioned copy under the user's application-data directory (no sudo) and links `dispatch` into ~/.local/bin.
# Idempotent. Never touches the database, config or data of an existing install. Options: --no-path (do not edit the shell profile), --bin-dir DIR.
set -eu
SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION")"
case "$(uname -s)" in
  Darwin) DATA="${DISPATCH_HOME:-$HOME/Library/Application Support/Dispatch}" ;;
  *) DATA="${DISPATCH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/dispatch}" ;;
esac
BIN_DIR="${DISPATCH_BIN_DIR:-$HOME/.local/bin}"; ADD_PATH=1
while [ $# -gt 0 ]; do case "$1" in --no-path) ADD_PATH=0 ;; --bin-dir) BIN_DIR="$2"; shift ;; *) echo "unknown option: $1" >&2; exit 2 ;; esac; shift; done

# Integrity: the package carries SHA256SUMS for everything it installs.
if [ -f "$SRC/SHA256SUMS" ]; then (cd "$SRC" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1) || { echo "install: checksum verification FAILED; refusing to install a modified package" >&2; exit 1; }; fi

DEST="$DATA/versions/$VERSION"
mkdir -p "$DATA/versions" "$BIN_DIR"
if [ -d "$DEST" ]; then chmod -R u+w "$DEST" 2>/dev/null || true; fi
TMP="$DATA/versions/.install-$VERSION.$$"; rm -rf "$TMP"; mkdir -p "$TMP"
cp -R "$SRC/bin" "$SRC/migrations" "$SRC/dashboard" "$SRC/VERSION" "$SRC/SHA256SUMS" "$TMP/" 2>/dev/null || cp -R "$SRC/bin" "$SRC/migrations" "$SRC/dashboard" "$SRC/VERSION" "$TMP/"
rm -rf "$DEST"; mv "$TMP" "$DEST"
ln -sfn "$DEST/bin/dispatch" "$BIN_DIR/dispatch"
echo "Installed Dispatch $VERSION -> $DEST"
echo "Linked        $BIN_DIR/dispatch"

case ":$PATH:" in *":$BIN_DIR:"*) ON_PATH=1 ;; *) ON_PATH=0 ;; esac
if [ "$ON_PATH" -eq 0 ] && [ "$ADD_PATH" -eq 1 ]; then
  PROFILE="$HOME/.zprofile"; [ "${SHELL##*/}" = "bash" ] && PROFILE="$HOME/.bash_profile"
  if ! grep -q "# >>> dispatch >>>" "$PROFILE" 2>/dev/null; then
    { echo ""; echo "# >>> dispatch >>>"; echo "export PATH=\"$BIN_DIR:\$PATH\""; echo "# <<< dispatch <<<"; } >> "$PROFILE"
    echo "Added $BIN_DIR to PATH in $PROFILE (open a new terminal, or run: export PATH=\"$BIN_DIR:\$PATH\")"
  fi
elif [ "$ON_PATH" -eq 0 ]; then echo "Add $BIN_DIR to your PATH to run \`dispatch\` from anywhere."; fi
echo "Next: run \`dispatch doctor\`, then \`dispatch\`."
