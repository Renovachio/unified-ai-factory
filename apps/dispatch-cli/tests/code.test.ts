import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestSnapshot, takeSnapshot, changesSince, undoSince } from "@factory/dispatch-core";
import { guardWrite } from "../src/guard";
import { buildHereLaunch } from "../src/claude-launch";
import { cmdChanges, cmdUndo, runCode, type CodeDeps } from "../src/commands/code";

function proj() {
  const root = mkdtempSync(join(tmpdir(), "code-")); const p = join(root, "proj"); const home = join(root, "home"); mkdirSync(p); mkdirSync(home);
  writeFileSync(join(p, "a.txt"), "one\n"); writeFileSync(join(p, "b.txt"), "two\n"); writeFileSync(join(p, ".env"), "SECRET=1\n");
  return { p, home, done: () => rmSync(root, { recursive: true, force: true }) };
}
const approved = { approved: true as const, reviewedOn: "2026-11-19", scope: "interactive" };

describe("in-place work: snapshot, changes, undo", () => {
  test("undo restores modified, deleted and added files; never touches .env", () => {
    const t = proj(); try {
      const s = takeSnapshot(t.p, t.home); expect(Object.keys(s.manifest).sort()).toEqual(["a.txt", "b.txt"]);
      writeFileSync(join(t.p, "a.txt"), "CHANGED\n"); rmSync(join(t.p, "b.txt")); writeFileSync(join(t.p, "new.txt"), "x"); writeFileSync(join(t.p, ".env"), "SECRET=2\n");
      expect(changesSince(s).map((c) => `${c.kind}:${c.path}`)).toEqual(["modify:a.txt", "delete:b.txt", "add:new.txt"]);
      const r = undoSince(s); expect(r.ok).toBe(true);
      expect(readFileSync(join(t.p, "a.txt"), "utf8")).toBe("one\n"); expect(readFileSync(join(t.p, "b.txt"), "utf8")).toBe("two\n");
      expect(existsSync(join(t.p, "new.txt"))).toBe(false); expect(readFileSync(join(t.p, ".env"), "utf8")).toBe("SECRET=2\n"); // protected file untouched
      expect(changesSince(s)).toEqual([]);
    } finally { t.done(); }
  });
  test("keeps only the newest snapshots", () => {
    const t = proj(); try { for (let i = 0; i < 5; i++) takeSnapshot(t.p, t.home); expect(latestSnapshot(t.p, t.home)).not.toBeNull(); } finally { t.done(); }
  });
  test("changes/undo commands: preview without --yes, nothing without a snapshot", () => {
    const t = proj(); const out: string[] = []; const err: string[] = [];
    try {
      expect(cmdChanges(t.p, t.home, (s) => out.push(s), (s) => err.push(s))).toBe(1);
      takeSnapshot(t.p, t.home); writeFileSync(join(t.p, "a.txt"), "CHANGED\n");
      expect(cmdChanges(t.p, t.home, (s) => out.push(s), (s) => err.push(s))).toBe(0); expect(out.join("\n")).toContain("~ a.txt");
      expect(cmdUndo(t.p, t.home, false, (s) => out.push(s), (s) => err.push(s))).toBe(0); expect(readFileSync(join(t.p, "a.txt"), "utf8")).toBe("CHANGED\n");
      expect(cmdUndo(t.p, t.home, true, (s) => out.push(s), (s) => err.push(s))).toBe(0); expect(readFileSync(join(t.p, "a.txt"), "utf8")).toBe("one\n");
    } finally { t.done(); }
  });
});

describe("guard with --protect (in place)", () => {
  const input = (file: string) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } });
  test("allows ordinary project files; blocks .git, .env, keys, outside the folder and symlink escapes", () => {
    const t = proj(); try {
      mkdirSync(join(t.p, "src")); mkdirSync(join(t.p, ".git"));
      expect(guardWrite(input(join(t.p, "src/new.ts")), t.p, { protect: true }).allow).toBe(true);
      for (const f of [join(t.p, ".git/config"), join(t.p, ".env"), join(t.p, ".github/workflows/x.yml"), join(t.p, "node_modules/x.js"), join(t.home, "evil.txt"), "/etc/hosts"]) expect(guardWrite(input(f), t.p, { protect: true }).allow).toBe(false);
      expect(guardWrite("not json", t.p, { protect: true }).allow).toBe(false);
    } finally { t.done(); }
  });
});

describe("dispatch code", () => {
  function deps(over: Partial<CodeDeps>, p: string, home: string) {
    const out: string[] = []; const err: string[] = []; const launches: Array<{ args: string[]; cwd: string; env: Record<string, string> }> = [];
    const d: CodeDeps = { home, cwd: p, terms: () => approved, which: () => "/bin/claude", plugin: () => "/plug", env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "g" }, guardCommand: "'/d' 'guard-write'",
      spawn: async (l) => { launches.push(l); writeFileSync(join(p, "a.txt"), "edited by agent\n"); return 0; }, out: (s) => out.push(s), err: (s) => err.push(s), ...over };
    return { d, out, err, launches };
  }
  test("refuses without terms approval and launches nothing (no snapshot either)", async () => {
    const t = proj(); try { const x = deps({ terms: () => ({ approved: false, reason: "none" }) }, t.p, t.home); expect(await runCode(x.d)).toBe(1); expect(x.launches).toEqual([]); expect(latestSnapshot(t.p, t.home)).toBeNull(); } finally { t.done(); }
  });
  test("snapshots first, launches in the folder with the folder-scoped guard and no MCP, then reports changes", async () => {
    const t = proj(); try {
      const x = deps({ request: "fix the typo" }, t.p, t.home); expect(await runCode(x.d)).toBe(0);
      const l = x.launches[0]!; expect(l.cwd).toBe(t.p); expect(l.args[0]).toBe("/dispatch:here fix the typo");
      expect(l.args).toContain("--restricted"); expect(l.args[l.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}'); expect(l.args).toContain("--strict-mcp-config");
      expect(l.args).not.toContain("--allowedTools"); // writes are not pre-approved: Claude asks
      const hook = JSON.parse(l.args[l.args.indexOf("--settings") + 1]!).hooks.PreToolUse[0].hooks[0].command as string; expect(hook).toContain("--root"); expect(hook).toContain("--protect");
      expect(Object.keys(l.env)).toEqual(["PATH"]);
      expect(x.out.join("\n")).toContain("1 file changed"); expect(latestSnapshot(t.p, t.home)).not.toBeNull();
    } finally { t.done(); }
  });
  test("a request is optional", () => { expect(buildHereLaunch({ claude: "c", pluginDir: "p", projectPath: "/x", env: {}, guardCommand: "g" }).args[0]).toBe("/dispatch:here"); });
});
