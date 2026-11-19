import { describe, expect, test } from "bun:test";
import { dispatchPaths } from "@factory/dispatch-core";
import { pgOptions } from "../src/launcher/postgres";
import { verifiedLocalUrl, openBrowser } from "../src/launcher/browser";
import { selfCommand, migrationsDir } from "../src/launcher/runtime";
import { DEFAULT_CONFIG } from "@factory/dispatch-core";

describe("postgres options (regression: macOS 'Application Support' path)", () => {
  test("paths with spaces are single-quoted so pg_ctl's shell re-split keeps them whole; a quote in a path is refused", () => {
    const p = dispatchPaths({ DISPATCH_HOME: "/Users/x/Library/Application Support/Dispatch" });
    const o = pgOptions(p); expect(o).toContain(`unix_socket_directories='${p.pgSocket}'`); expect(o).toContain("listen_addresses=''");
    // the way pg_ctl hands -o to /bin/sh: the quoted path must survive as ONE word
    const words = Bun.spawnSync(["/bin/sh", "-c", `for w in ${o}; do echo "[$w]"; done`]).stdout.toString().trim().split("\n");
    expect(words).toContain(`[unix_socket_directories=${p.pgSocket}]`);
    expect(() => pgOptions(dispatchPaths({ DISPATCH_HOME: "/Users/o'brien/Dispatch" }))).toThrow(/unsupported character/);
  });
});

describe("browser opening (verified local URL only)", () => {
  test("only the factory's own loopback origins are ever opened; remote, userinfo, other ports and non-http are refused", () => {
    const c = DEFAULT_CONFIG;
    expect(verifiedLocalUrl("http://127.0.0.1:3000/", c)?.port).toBe("3000"); expect(verifiedLocalUrl("http://127.0.0.1:8787/api/v1/local/enter?code=x", c)).not.toBeNull();
    for (const bad of ["https://evil.example/", "http://127.0.0.1:9999/", "http://localhost:3000/", "http://127.0.0.1:3000@evil.com/", "http://user:pw@127.0.0.1:3000/", "file:///etc/passwd", "javascript:alert(1)", "not a url", "http://127.0.0.1.evil.com:3000/"]) expect(verifiedLocalUrl(bad, c)).toBeNull();
    expect(openBrowser("https://evil.example/", c)).toMatchObject({ opened: false, reason: expect.stringMatching(/refused/) });
    expect(openBrowser("http://127.0.0.1:3000/", c, "win32")).toMatchObject({ opened: false });
  });
});

describe("self re-exec and install layout", () => {
  test("script mode re-runs the source file; a compiled binary re-execs itself with no extra path", () => {
    expect(selfCommand("/b/bun.exe", "/r/main.ts", () => true)).toEqual({ cmd: "/b/bun.exe", prefix: ["/r/main.ts"] });
    expect(selfCommand("/i/bin/dispatch", "/$bunfs/root/dispatch", () => false)).toEqual({ cmd: "/i/bin/dispatch", prefix: [] });
    expect(selfCommand("/i/bin/dispatch", "", () => false)).toEqual({ cmd: "/i/bin/dispatch", prefix: [] });
  });
  test("migrations are found next to the install, by override, or fall back to the source checkout", () => {
    expect(migrationsDir({}, "/i/bin/dispatch", (p) => p === "/i/migrations/0001_core.up.sql")).toBe("/i/migrations");
    expect(migrationsDir({ DISPATCH_MIGRATIONS_DIR: "/m" }, "/i/bin/dispatch", (p) => p === "/m/0001_core.up.sql")).toBe("/m");
    expect(migrationsDir({}, "/i/bin/dispatch", () => false)).toBeUndefined();
  });
});
