# DSP-09 — Optional macOS menu-bar companion (P2)

**Status: in_progress (compiles; headless status path verified; GUI interaction not observed).**
Code: `apps/dispatch-menubar/main.swift` (+README). Build: `swiftc -O -swift-version 5 -o dispatch-menubar main.swift` (Apple Swift 6.4.2, arm64, macOS 27.2) — compiled with no errors or warnings.

- `--selftest` runs the same status code path as the menu against the live packaged factory: `status=◆ detail=0 running · 0 need you · 0 workers`, exit 0. Negative runs: token file mode 0644 → "Not signed in" (token refused), exit 3; no setup → "not set up", exit 3; factory stopped → "not reachable", exit 3.
- Launched as an accessory app and stayed alive; menu items: health line, Open Dashboard (mints the single-use browser code), Open Terminal (`dispatch`), Launch at login (opt-in LaunchAgent), Quit (exits only the app).
- No model keys or merge secrets; reads only the 0600 owner token; loopback only; no approve/cancel actions; backs off up to 60 s when the factory is away.

**Not verified:** I did not see the status item or click any menu item; Terminal automation and launch-at-login were not exercised; no notifications are posted; not an app bundle, not signed/notarized.
