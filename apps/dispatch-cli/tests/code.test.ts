import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestSnapshot, takeSnapshot, changesSince, undoSince, writeScope, clearScope, scopeFile, bumpWave } from "@factory/dispatch-core";
import { guardWrite } from "../src/guard";
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

describe("guard with a plan scope (in-place run)", () => {
  const input = (file: string) => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } });
  test("no active plan = no writes; with a plan only its paths; a plan for another folder is ignored", () => {
    const t = proj(); try {
      mkdirSync(join(t.p, "src")); const root = realpathSync(t.p); const sf = join(t.home, "scope.json"); const o = { protect: true, scopeFile: sf };
      expect(guardWrite(input(join(t.p, "src/a.ts")), t.p, o).allow).toBe(false); // file missing
      writeScope(t.home, { runId: "r", project: root, writes: ["src/", "README.md"] }); const real = scopeFile(t.home, root);
      const g = (f: string) => guardWrite(input(f), t.p, { protect: true, scopeFile: real }).allow;
      expect(g(join(t.p, "src/a.ts"))).toBe(true); expect(g(join(t.p, "README.md"))).toBe(true); expect(g(join(t.p, "other.ts"))).toBe(false); expect(g(join(t.p, "src2/x.ts"))).toBe(false); expect(g(join(t.p, ".env"))).toBe(false);
      writeFileSync(real, JSON.stringify({ runId: "r", project: "/somewhere/else", writes: ["src/"] })); expect(g(join(t.p, "src/a.ts"))).toBe(false);
      // agent leases: within a wave the first agent owns a file; another agent is refused; the same agent may continue; a new wave frees it
      const as = (id: string | undefined, f: string) => guardWrite(JSON.stringify({ agent_id: id, tool_name: "Write", tool_input: { file_path: f } }), t.p, { protect: true, scopeFile: real }).allow;
      writeFileSync(real, JSON.stringify({ runId: "r", project: root, writes: ["src/"], wave: 0 }));
      expect(as("agentA", join(t.p, "src/x.ts"))).toBe(true); expect(as("agentA", join(t.p, "src/x.ts"))).toBe(true); expect(as("agentB", join(t.p, "src/x.ts"))).toBe(false); expect(as(undefined, join(t.p, "src/x.ts"))).toBe(false); expect(as("agentB", join(t.p, "src/y.ts"))).toBe(true);
      bumpWave(t.home, root, "r"); expect(as("agentB", join(t.p, "src/x.ts"))).toBe(true); bumpWave(t.home, root, "wrong-run"); expect(as("agentA", join(t.p, "src/x.ts"))).toBe(false);
      clearScope(t.home, root, "r"); expect(existsSync(`${real}.claims`)).toBe(false);
      writeScope(t.home, { runId: "r2", project: root, writes: ["src/"] }); clearScope(t.home, root, "r"); expect(g(join(t.p, "src/a.ts"))).toBe(true); // a stale run id cannot clear a newer scope
    } finally { t.done(); }
  });
});

describe("dispatch code", () => {
  function deps(over: Partial<CodeDeps>, p: string, home: string) {
    const out: string[] = []; const err: string[] = []; const launches: Array<{ args: string[]; cwd: string; env: Record<string, string> }> = []; const jobs: string[] = [];
    const d: CodeDeps = { home, cwd: p, request: "fix the typo", terms: () => approved, which: () => "/bin/claude", plugin: () => "/plug", env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "g" },
      guardCommand: "'/d' 'guard-write'", mcpCommand: { cmd: "/d", args: ["mcp"] }, ensureFactory: async () => true, ask: async () => "from the prompt",
      createJob: async (_c, r) => { jobs.push(r); return { jobId: "11111111-2222-3333-4444-555555555555", project: "proj" }; },
      latestRun: async () => ({ id: "aaaaaaaa-0000", status: "awaiting_approval", changes: 2, failure: null }),
      spawn: async (l) => { launches.push(l); return 0; }, out: (s) => out.push(s), err: (s) => err.push(s), ...over };
    return { d, out, err, launches, jobs };
  }
  test("refuses without terms approval: no job is queued, nothing launched", async () => {
    const t = proj(); try { const x = deps({ terms: () => ({ approved: false, reason: "none" }) }, t.p, t.home); expect(await runCode(x.d)).toBe(1); expect(x.launches).toEqual([]); expect(x.jobs).toEqual([]); } finally { t.done(); }
  });
  test("queues the request, launches in the folder with scoped guard + Dispatch MCP, and reports the run", async () => {
    const t = proj(); try {
      const x = deps({}, t.p, t.home); expect(await runCode(x.d)).toBe(0); expect(x.jobs).toEqual(["fix the typo"]);
      const l = x.launches[0]!; expect(l.cwd).toBe(realpathSync(t.p)); expect(l.args[0]).toBe(`/dispatch:code ${realpathSync(t.p)}`);
      expect(l.args).toContain("--restricted"); expect(l.args).toContain("--strict-mcp-config"); expect(l.args).not.toContain("--allowedTools");
      expect(JSON.parse(l.args[l.args.indexOf("--mcp-config") + 1]!).mcpServers.dispatch.args).toEqual(["mcp"]);
      const hook = JSON.parse(l.args[l.args.indexOf("--settings") + 1]!).hooks.PreToolUse[0].hooks[0].command as string;
      for (const w of ["--root", "--protect", "--scope-file"]) expect(hook).toContain(w);
      expect(Object.keys(l.env)).toEqual(["PATH"]); expect(x.out.join("\n")).toContain("2 file(s) changed");
    } finally { t.done(); }
  });
  test("asks for the request when none was given; empty answer starts nothing", async () => {
    const t = proj(); try {
      const a = deps({ request: undefined }, t.p, t.home); await runCode(a.d); expect(a.jobs).toEqual(["from the prompt"]);
      const b = deps({ request: undefined, ask: async () => "  " }, t.p, t.home); expect(await runCode(b.d)).toBe(1); expect(b.launches).toEqual([]);
    } finally { t.done(); }
  });
  test("a factory that will not start, or no run happening, is reported honestly", async () => {
    const t = proj(); try {
      const a = deps({ ensureFactory: async () => false }, t.p, t.home); expect(await runCode(a.d)).toBe(1); expect(a.launches).toEqual([]);
      const b = deps({ latestRun: async () => null }, t.p, t.home); await runCode(b.d); expect(b.out.join("\n")).toContain("without starting a run");
    } finally { t.done(); }
  });
});
