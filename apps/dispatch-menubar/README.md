# Dispatch menu-bar companion (optional)

A small native macOS status item: health, running jobs, items needing you, **Open Dashboard**, **Open Terminal**, opt-in **Launch at login**, **Quit**.

- Build: `swiftc -O -swift-version 5 -o dispatch-menubar main.swift` (Swift 6.x toolchain). Run: `./dispatch-menubar` (accessory app, no Dock icon). Headless check: `./dispatch-menubar --selftest`.
- Talks only to the local factory API on 127.0.0.1 with the same 0600 owner token the CLI uses (it refuses a token file with loose permissions). It stores no tokens, model keys or merge secrets, and never starts or stops the factory: quitting it leaves jobs running.
- Reads status only; opening the dashboard mints the same single-use browser code the CLI does. It has no approve/cancel actions.
- Network loss / expiry: shows "not reachable" / "not signed in" and backs off up to 60 s. No notifications are posted (the status item changes instead); those need an app bundle.
- Launch at login writes `~/Library/LaunchAgents/dev.dispatch.menubar.plist` pointing at the binary; it is off by default and removed by toggling again. Distributing it to others would need an app bundle, code signing and notarization, which this repository does not do.
