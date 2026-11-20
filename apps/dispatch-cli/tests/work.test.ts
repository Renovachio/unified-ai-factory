import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeLaunch, claudeEnv, guardSettings, shQuote, type ClaudeLaunch } from "../src/claude-launch";
import { runWork, type WorkDeps } from "../src/commands/work";

const approved = { approved: true as const, reviewedOn: "2026-11-19", scope: "interactive" };
function deps(over: Partial<WorkDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "work-")); const out: string[] = []; const err: string[] = []; const launches: ClaudeLaunch[] = [];
  const d: WorkDeps = {
    home, terms: () => approved, which: () => "/usr/local/bin/claude", plugin: () => "/opt/dispatch/claude-plugin",
    nextJob: async () => ({ title: "Write notes", project: { name: "Notes", path: "/Users/me/Notes" } }),
    spawn: async (l) => { launches.push(l); return 0; },
    env: { PATH: "/usr/bin", HOME: "/Users/me", ANTHROPIC_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp_secret", AWS_SECRET_ACCESS_KEY: "x", DATABASE_URL: "postgres://x", CLAUDE_CODE_OAUTH_TOKEN: "t" },
    guardCommand: "'/opt/dispatch/bin/dispatch' 'guard-write'", mcpCommand: { cmd: "/opt/dispatch/bin/dispatch", args: ["mcp"] }, out: (s) => out.push(s), err: (s) => err.push(s), ...over,
  };
  return { d, out, err, launches, home, done: () => rmSync(home, { recursive: true, force: true }) };
}

describe("dispatch work: starts Claude Code only when every precondition holds", () => {
  test("refuses, naming the operator step, until a provider-terms approval is recorded; nothing is launched", async () => {
    const t = deps({ terms: () => ({ approved: false, reason: "no approval is recorded" }) }); try {
      expect(await runWork(t.d)).toBe(1); expect(t.launches).toEqual([]); expect(t.err.join("\n")).toContain("provider-terms"); expect(t.err.join("\n")).toContain("never writes that file");
    } finally { t.done(); }
  });
  test("refuses when claude, the plugin or the factory is missing, and says what to do; with an empty queue it launches nothing", async () => {
    for (const [over, text] of [[{ which: () => null }, "not found on your PATH"], [{ plugin: () => undefined }, "plugin"], [{ nextJob: async () => { throw new Error("ECONNREFUSED"); } }, "Run `dispatch` first"]] as const) {
      const t = deps(over as Partial<WorkDeps>); try { expect(await runWork(t.d)).toBe(1); expect(t.err.join("\n")).toContain(text); expect(t.launches).toEqual([]); } finally { t.done(); }
    }
    const e = deps({ nextJob: async () => null }); try { expect(await runWork(e.d)).toBe(0); expect(e.launches).toEqual([]); expect(e.out.join("\n")).toContain("Nothing is queued"); } finally { e.done(); }
  });
  test("launch: restricted mode, Opus, the plugin, the work folder, writes pre-approved only inside it, project as cwd, and a scrubbed environment", async () => {
    const t = deps(); try {
      expect(await runWork(t.d)).toBe(0); expect(t.launches.length).toBe(1); const l = t.launches[0] as ClaudeLaunch; const work = join(t.home, "work");
      expect(l.command).toBe("/usr/local/bin/claude"); expect(l.cwd).toBe("/Users/me/Notes"); expect(existsSync(work)).toBe(true);
      expect(l.args).toEqual(["/dispatch:work", "--restricted", "--model", "opus", "--plugin-dir", "/opt/dispatch/claude-plugin", "--add-dir", work, "--allowedTools", `Edit(/${work}/**),Write(/${work}/**)`, "--settings", guardSettings("'/opt/dispatch/bin/dispatch' 'guard-write'"), "--tools", "Task,Read,Glob,Grep,Write,Edit", "--mcp-config", '{"mcpServers":{"dispatch":{"command":"/opt/dispatch/bin/dispatch","args":["mcp"]}}}', "--strict-mcp-config"]);
      expect(l.args[l.args.indexOf("--tools") + 1]).not.toMatch(/Bash|Web|Cron|Schedule|Push|Send|Worktree/);
      const hook = JSON.parse(l.args[l.args.indexOf("--settings") + 1] as string).hooks.PreToolUse[0]; expect(hook.matcher).toBe("Write|Edit|MultiEdit|NotebookEdit"); expect(hook.hooks[0].command).toBe("'/opt/dispatch/bin/dispatch' 'guard-write'");
      expect(l.args).not.toContain("--dangerously-skip-permissions"); expect(l.args.join(" ")).not.toContain("bypassPermissions");
      expect(l.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/me" }); // no API key, no token, no cloud credentials, no database url
      expect(t.out.join("\n")).toContain("COPY");
    } finally { t.done(); }
  });
  test("the environment is an allowlist: credential-like and unknown variables never pass", () => {
    const e = claudeEnv({ PATH: "p", HOME: "h", TERM: "xterm", LANG: "en", LC_ALL: "C", SHELL: "/bin/zsh", USER: "u", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", GH_TOKEN: "k", AWS_ACCESS_KEY_ID: "k", HTTPS_PROXY: "http://x", NODE_OPTIONS: "--require x", ANTHROPIC_BASE_URL: "https://evil" });
    expect(Object.keys(e).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "USER"]);
    expect(buildClaudeLaunch({ claude: "c", pluginDir: "p", projectPath: "/x", workDir: "/w", env: { ANTHROPIC_API_KEY: "k" }, guardCommand: "g", mcpCommand: { cmd: "d", args: ["mcp"] } }).env).toEqual({});
    expect(shQuote("a b'c")).toBe("'a b'\\''c'");
  });
});
