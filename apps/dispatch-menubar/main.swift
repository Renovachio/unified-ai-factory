// Dispatch menu-bar companion (optional, DSP-09). A thin client of the factory's shared API: it reads status, opens the dashboard and a terminal, and nothing else.
// It holds NO model keys or merge secrets, never starts or stops the factory, and quitting it does not affect running jobs.
import AppKit
import Foundation

struct Summary: Decodable {
    struct Jobs: Decodable { let inFlight: Int; let waitingOnHuman: Int; let total: Int }
    struct Approvals: Decodable { let pending: Int }
    struct Workers: Decodable { let active: Int }
    let jobs: Jobs; let approvals: Approvals; let projects: Int; let workers: Workers
}
enum Health: Equatable { case ready(Summary), unreachable, signedOut, starting }
extension Summary: Equatable { static func == (a: Summary, b: Summary) -> Bool { a.jobs.inFlight == b.jobs.inFlight && a.approvals.pending == b.approvals.pending && a.workers.active == b.workers.active } }

/// Local settings location, mirroring the CLI (DISPATCH_HOME override, else macOS Application Support).
func dispatchHome() -> URL {
    if let h = ProcessInfo.processInfo.environment["DISPATCH_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Dispatch")
}
struct Config { let host: String; let apiPort: Int; let webPort: Int }
func loadConfig() -> Config? {
    guard let d = try? Data(contentsOf: dispatchHome().appendingPathComponent("config.json")),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let host = o["host"] as? String, host == "127.0.0.1",
          let ports = o["ports"] as? [String: Any], let api = ports["api"] as? Int, let web = ports["web"] as? Int else { return nil }
    return Config(host: host, apiPort: api, webPort: web)
}
/// The owner token is a 0600 file owned by this user; refuse to use it if its permissions are looser.
func loadToken() -> String? {
    let f = dispatchHome().appendingPathComponent("secrets/local-owner-token")
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: f.path), let perm = attrs[.posixPermissions] as? Int, perm & 0o077 == 0,
          let s = try? String(contentsOf: f, encoding: .utf8) else { return nil }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? nil : t
}

func request(_ cfg: Config, _ path: String, method: String = "GET", token: String) async -> (Int, Data)? {
    guard let url = URL(string: "http://\(cfg.host):\(cfg.apiPort)\(path)") else { return nil }   // loopback only, by construction
    var r = URLRequest(url: url, timeoutInterval: 4); r.httpMethod = method
    r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    if method != "GET" { r.setValue(UUID().uuidString, forHTTPHeaderField: "idempotency-key") }
    guard let (d, resp) = try? await URLSession.shared.data(for: r), let h = resp as? HTTPURLResponse else { return nil }
    return (h.statusCode, d)
}
func fetchHealth() async -> Health {
    guard let cfg = loadConfig() else { return .starting }
    guard let tok = loadToken() else { return .signedOut }
    guard let (code, data) = await request(cfg, "/api/v2/dispatch/summary", token: tok) else { return .unreachable }
    if code == 401 || code == 403 { return .signedOut }
    if code == 200, let s = try? JSONDecoder().decode(Summary.self, from: data) { return .ready(s) }
    return .unreachable
}
func describe(_ h: Health) -> (title: String, detail: String) {
    switch h {
    case .ready(let s): return (s.approvals.pending > 0 ? "◆ \(s.approvals.pending)" : (s.jobs.inFlight > 0 ? "◆ \(s.jobs.inFlight)…" : "◆"), "\(s.jobs.inFlight) running · \(s.approvals.pending) need you · \(s.workers.active) workers")
    case .unreachable: return ("◇", "Factory not reachable — run `dispatch` in a terminal")
    case .signedOut: return ("◇", "Not signed in — run `dispatch` once to set up")
    case .starting: return ("◇", "Dispatch is not set up yet — run `dispatch`")
    }
}

if CommandLine.arguments.contains("--selftest") {      // headless check of the same code path the menu uses (no GUI)
    let sem = DispatchSemaphore(value: 0)
    Task { let h = await fetchHealth(); let d = describe(h); print("status=\(d.title) detail=\(d.detail)"); if case .ready = h { exit(0) } else { exit(3) }; sem.signal() }
    sem.wait()
}

final class App: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var health: Health = .starting; var failures = 0; var timer: Timer?
    let agent = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/dev.dispatch.menubar.plist")
    func applicationDidFinishLaunching(_ n: Notification) { rebuild(); schedule(5) }
    func schedule(_ s: TimeInterval) { timer?.invalidate(); timer = Timer.scheduledTimer(withTimeInterval: s, repeats: false) { [weak self] _ in self?.refresh() } }
    func refresh() {
        Task { @MainActor in
            let h = await fetchHealth(); health = h
            if case .ready = h { failures = 0 } else { failures += 1 }
            rebuild(); schedule(min(60, 5 * pow(2, Double(min(failures, 4)))))   // back off while the factory is away
        }
    }
    func rebuild() {
        let d = describe(health); item.button?.title = d.title; item.button?.toolTip = d.detail
        let m = NSMenu(); m.addItem(withTitle: d.detail, action: nil, keyEquivalent: "").isEnabled = false; m.addItem(.separator())
        for (t, a) in [("Open Dashboard", #selector(openDashboard)), ("Open Terminal (dispatch)", #selector(openTerminal))] { let i = NSMenuItem(title: t, action: a, keyEquivalent: ""); i.target = self; m.addItem(i) }
        m.addItem(.separator())
        let login = NSMenuItem(title: "Launch at login", action: #selector(toggleLogin), keyEquivalent: ""); login.target = self; login.state = FileManager.default.fileExists(atPath: agent.path) ? .on : .off; m.addItem(login)
        let q = NSMenuItem(title: "Quit menu bar (jobs keep running)", action: #selector(quit), keyEquivalent: "q"); q.target = self; m.addItem(q)
        item.menu = m
    }
    @objc func openDashboard() {
        Task { @MainActor in
            guard let cfg = loadConfig(), let tok = loadToken() else { return }
            var url = URL(string: "http://\(cfg.host):\(cfg.webPort)")!
            if let (c, d) = await request(cfg, "/api/v2/dispatch/browser-code", method: "POST", token: tok), c == 200, let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let code = o["code"] as? String,
               let enc = code.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed), let u = URL(string: "http://\(cfg.host):\(cfg.apiPort)/api/v1/local/enter?code=\(enc)") { url = u }
            NSWorkspace.shared.open(url)
        }
    }
    @objc func openTerminal() { let s = NSAppleScript(source: "tell application \"Terminal\" to do script \"dispatch\"\ntell application \"Terminal\" to activate"); var e: NSDictionary?; s?.executeAndReturnError(&e) }
    @objc func toggleLogin() {
        if FileManager.default.fileExists(atPath: agent.path) { try? FileManager.default.removeItem(at: agent) }
        else if let exe = Bundle.main.executablePath {
            let plist: [String: Any] = ["Label": "dev.dispatch.menubar", "ProgramArguments": [exe], "RunAtLoad": true, "KeepAlive": false]
            try? FileManager.default.createDirectory(at: agent.deletingLastPathComponent(), withIntermediateDirectories: true)
            (plist as NSDictionary).write(to: agent, atomically: true)
        }
        rebuild()
    }
    @objc func quit() { NSApp.terminate(nil) }   // only this app exits; the factory's lifetime is independent
}
let app = NSApplication.shared; let delegate = App(); app.delegate = delegate; app.setActivationPolicy(.accessory); app.run()
