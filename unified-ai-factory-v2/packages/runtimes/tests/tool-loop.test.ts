import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxEnv, createWorkspace, detectBackend, runSandboxed, teardownWorkspace } from "@factory/sandboxes";
import { InferenceSourcePolicy, loadPolicyConfig, runToolLoop, ToolHost, toolsetDigest } from "../src/index";

const policy = new InferenceSourcePolicy(loadPolicyConfig(join(import.meta.dir, "../../../config")));
type Turn = { content?: string; tool_calls?: Array<{ name: string; args: unknown }> } | "429" | "500";
function scripted(turns: Turn[]) {
  const seen: unknown[] = []; let i = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as { messages: unknown[]; tools: unknown[] };
    seen.push(body);
    const t = turns[Math.min(i++, turns.length - 1)]!;
    if (t === "429") return new Response("x", { status: 429 });
    if (t === "500") return new Response("x", { status: 500 });
    return Response.json({ choices: [{ message: { content: t.content ?? null, tool_calls: t.tool_calls?.map((c, n) => ({ id: `c${i}_${n}`, function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) } })) } }], usage: { prompt_tokens: 5 } });
  } });
  return { endpoint: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}
let repo = ""; let outside = "";
beforeAll(() => {
  outside = mkdtempSync(join(tmpdir(), "outside-")); writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
  repo = mkdtempSync(join(tmpdir(), "repo-")); mkdirSync(join(repo, "src")); mkdirSync(join(repo, ".git")); mkdirSync(join(repo, ".github"));
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n"); symlinkSync(outside, join(repo, "link"));
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
const run = (turns: Turn[], o: Partial<Parameters<typeof runToolLoop>[0]> = {}, host = new ToolHost({ repoDir: repo, checks: { test: async () => ({ exitCode: 0, output: "ok" }) } })) => {
  const s = scripted(turns); const events: Array<[string, Record<string, unknown>]> = [];
  return runToolLoop({ endpoint: s.endpoint, policy, env: {}, modelId: "m", system: "sys", task: "do it", host, onEvent: (t, p) => events.push([t, p]), ...o }).then((r) => { s.stop(); return { r, events, seen: s.seen, host }; });
};

describe("tool loop: read/edit/test/tool-result iteration", () => {
  test("reads, edits, runs a named check, then finishes; events are audited and carry no file content", async () => {
    const { r, events, host } = await run([
      { tool_calls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
      { tool_calls: [{ name: "replace_in_file", args: { path: "src/a.ts", find: "= 1", replace: "= 2" } }, { name: "write_file", args: { path: "src/b.ts", content: "export const b = 2;\n" } }] },
      { tool_calls: [{ name: "run_check", args: { name: "test" } }] },
      { content: "done" },
    ]);
    expect(r).toMatchObject({ status: "finished", finalMessage: "done", iterations: 4, toolCalls: 4, invalidCalls: 0, changedFiles: ["src/a.ts", "src/b.ts"] });
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(events.map((e) => e[0])).toEqual(["loop.turn", "loop.tool_call", "loop.turn", "loop.tool_call", "loop.tool_call", "loop.turn", "loop.tool_call", "loop.turn", "loop.finished"]);
    expect(JSON.stringify(events)).not.toContain("export const");
    expect(host.changed.size).toBe(2);
  });
  test("tool results are fed back to the model on the next turn", async () => {
    const { seen } = await run([{ tool_calls: [{ name: "read_file", args: { path: "src/b.ts" } }] }, { content: "ok" }]);
    expect(JSON.stringify((seen[1] as { messages: unknown[] }).messages)).toContain("export const b = 2;");
  });
});

describe("tool confinement and validation (invalid calls are reported to the model, never executed)", () => {
  const bad = async (calls: Array<{ name: string; args: unknown }>) => (await run([{ tool_calls: calls }, { content: "x" }], { maxInvalidCalls: 100 }));
  test("path traversal, absolute paths, symlink escapes and protected paths are refused", async () => {
    const { seen, r } = await bad([
      { name: "read_file", args: { path: "../outside.txt" } }, { name: "read_file", args: { path: "/etc/passwd" } },
      { name: "read_file", args: { path: "link/secret.txt" } }, { name: "write_file", args: { path: "link/new.txt", content: "x" } },
      { name: "write_file", args: { path: ".git/config", content: "x" } }, { name: "write_file", args: { path: ".github/workflows/ci.yml", content: "x" } },
      { name: "write_file", args: { path: ".env", content: "x" } }, { name: "read_file", args: { path: ".env" } },
    ]);
    expect(r.invalidCalls).toBe(8);
    const back = JSON.stringify((seen[1] as { messages: unknown[] }).messages);
    expect(back).not.toContain("TOPSECRET");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(existsSync(join(repo, ".github/workflows/ci.yml"))).toBe(false);
  });
  test("unknown tools, bad JSON, extra/missing args, ambiguous replace and unknown checks are errors", async () => {
    const { r } = await bad([{ name: "bash", args: { cmd: "id" } }, { name: "read_file", args: "{not json" }, { name: "read_file", args: { path: "a", extra: 1 } }, { name: "write_file", args: { path: "x" } }, { name: "replace_in_file", args: { path: "src/a.ts", find: "t", replace: "T" } }, { name: "run_check", args: { name: "rm -rf /" } }]);
    expect(r.invalidCalls).toBe(6);
  });
  test("a model that keeps emitting invalid calls is stopped (retry budget)", async () => {
    const { r } = await run([{ tool_calls: [{ name: "bash", args: {} }] }], { maxInvalidCalls: 3, maxIterations: 50 });
    expect(r.status).toBe("invalid-calls");
  });
});

describe("bounds and failure handling", () => {
  test("iteration budget, context limit, wall time, 429 and server errors end the loop with a distinct status", async () => {
    const call = { tool_calls: [{ name: "list_dir", args: { path: "." } }] };
    expect((await run([call], { maxIterations: 3 })).r).toMatchObject({ status: "iteration-budget", iterations: 3 });
    expect((await run([call], { maxContextChars: 50 })).r.status).toBe("context-limit");
    expect((await run(["429"])).r.status).toBe("rate-limited");
    expect((await run(["500"])).r.status).toBe("model-error");
    expect((await run([call], { maxWallMs: -1 })).r.status).toBe("wall-time");
    const ac = new AbortController(); ac.abort();
    expect((await run([call], { signal: ac.signal })).r.status).toBe("aborted");
  });
  test("write budget and file-size limit", async () => {
    const host = new ToolHost({ repoDir: repo, checks: {}, maxWrites: 1, maxFileBytes: 10 });
    expect(await host.call("write_file", { path: "src/c.ts", content: "tiny" })).toMatch(/wrote/);
    await expect(host.call("write_file", { path: "src/d.ts", content: "tiny" })).rejects.toThrow(/write budget/);
    await expect(new ToolHost({ repoDir: repo, checks: {}, maxFileBytes: 10 }).call("write_file", { path: "src/e.ts", content: "x".repeat(11) })).rejects.toThrow(/exceeds/);
  });
  test("the loop refuses metered endpoints and credential-bearing environments before any request", async () => {
    await expect(runToolLoop({ endpoint: "https://api.openai.com", policy, env: {}, modelId: "m", system: "s", task: "t", host: new ToolHost({ repoDir: repo, checks: {} }) })).rejects.toThrow(/metered|allowlisted/);
    await expect(runToolLoop({ endpoint: "http://127.0.0.1:1", policy, env: { ANTHROPIC_API_KEY: "x" }, modelId: "m", system: "s", task: "t", host: new ToolHost({ repoDir: repo, checks: {} }) })).rejects.toThrow(/credential/);
  });
  test("toolset digest changes when the available checks change", () => {
    expect(toolsetDigest(["test"])).not.toBe(toolsetDigest(["test", "lint"]));
    expect(toolsetDigest(["b", "a"])).toBe(toolsetDigest(["a", "b"]));
  });
});

describe("with the real OS sandbox: a model-written change is verified by an actual command", () => {
  test("run_check executes inside the sandbox backend; the loop's result is a real exit code", async () => {
    const base = mkdtempSync(join(tmpdir(), "wsb-")); const ws = createWorkspace(base, "tl1");
    try {
      writeFileSync(join(ws.repoDir, "check.sh"), "grep -q 'ok' value.txt\n");
      const backend = detectBackend();
      const check = async () => { const r = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: "/bin/sh", args: ["check.sh"], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 10_000 }); return { exitCode: r.exitCode, output: r.stdout + r.stderr }; };
      const host = new ToolHost({ repoDir: ws.repoDir, checks: { test: check } });
      expect(await host.call("run_check", { name: "test" })).toMatch(/^exit [12]/); // value.txt missing -> failing check
      await host.call("write_file", { path: "value.txt", content: "ok\n" });
      expect(await host.call("run_check", { name: "test" })).toMatch(/^exit 0/);
    } finally { teardownWorkspace(base, ws); rmSync(base, { recursive: true, force: true }); }
  });
});
