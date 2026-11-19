# Installing Dispatch (macOS, Apple silicon)

```sh
tar xzf dispatch-2.3.0-darwin-arm64.tar.gz && cd dispatch-2.3.0-darwin-arm64
./install.sh          # verifies SHA256SUMS, installs under ~/Library/Application Support/Dispatch, links ~/.local/bin/dispatch
dispatch doctor       # read-only diagnosis
dispatch              # start or attach, open the dashboard, enter the prompt
```

- **Build the package yourself:** `bun install && bun scripts/package-dispatch.ts` (needs Bun 1.4.4; writes `dist/`). Prints the tarball SHA-256.
- **Requires:** macOS, PostgreSQL 17 on `PATH` or in `/opt/homebrew/opt/postgresql@17/bin` (Dispatch runs its own private cluster; it never touches an existing one unless you set `postgres.mode: "external"`). Bun is **not** needed at run time.
- **Installer:** no sudo; refuses a package whose checksums do not match; adds a marked block to `~/.zprofile` only if `~/.local/bin` is not on `PATH` (`--no-path` to skip). Open a new terminal afterwards.
- **Unsigned:** the package is not code-signed or notarized. If macOS quarantines a downloaded tarball: `xattr -d com.apple.quarantine <file>`.
- **Uninstall:** `uninstall.sh` removes the binary and link; your data (`~/Library/Application Support/Dispatch`: database, config, token) is kept unless you delete it yourself.
- **Menu bar (optional):** `apps/dispatch-menubar` (see its README).
