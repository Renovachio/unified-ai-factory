import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardWrite } from "../src/guard";
import { createMcpHandler, serveMcp, TOOLS, type ApiCall } from "../src/mcp";

const calls: Array<[string, string, unknown]> = [];
const ok: ApiCall = async (m, p, b) => { calls.push([m, p, b]); return { ok: true, status: 200, body: { echoed: p } }; };
const rpc = (method: string, params?: Record<string, unknown>, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

describe("dispatch mcp: the Claude-facing tool server", () => {
  test("handshake and tool list: exactly four tools and NOTHING that can approve, apply or decide", async () => {
    const h = createMcpHandler(ok);
    expect(await h(rpc("initialize", { protocolVersion: "2024-11-05" }))).toMatchObject({ result: { capabilities: { tools: {} }, serverInfo: { name: "dispatch" } } });
    const l = (await h(rpc("tools/list")) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(l).toEqual(["dispatch_next_job", "dispatch_start_run", "dispatch_progress", "dispatch_finish_run"]);
    expect(l.join(" ")).not.toMatch(/approve|apply|decide|decision|reject/); expect(TOOLS.length).toBe(4);
    expect(await h({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull(); // notifications are never answered
    expect(await h(rpc("ping"))).toMatchObject({ result: {} });
  });
  test("tools call the matching API routes with the right bodies; ids are URL-encoded", async () => {
    calls.length = 0; const h = createMcpHandler(ok);
    await h(rpc("tools/call", { name: "dispatch_next_job", arguments: {} }));
    await h(rpc("tools/call", { name: "dispatch_start_run", arguments: { jobId: "j1", plan: { summary: "s", tasks: [] } } }));
    await h(rpc("tools/call", { name: "dispatch_progress", arguments: { runId: "r/../x", note: "hi" } }));
    await h(rpc("tools/call", { name: "dispatch_finish_run", arguments: { runId: "r1", summary: "done" } }));
    expect(calls).toEqual([["GET", "/api/v2/dispatch/work/next", undefined], ["POST", "/api/v2/dispatch/runs", { jobId: "j1", plan: { summary: "s", tasks: [] } }], ["POST", "/api/v2/dispatch/runs/r%2F..%2Fx/progress", { note: "hi" }], ["POST", "/api/v2/dispatch/runs/r1/finish", { summary: "done" }]]);
  });
  test("refusals are returned to the model as tool errors with the reasons; unreachable factory gives a start hint; bad calls are rejected", async () => {
    const refuse: ApiCall = async () => ({ ok: false, status: 422, body: { detail: "the plan was refused", errors: ["a and b could run in parallel but both write x/"] } });
    const r = (await createMcpHandler(refuse)(rpc("tools/call", { name: "dispatch_start_run", arguments: { jobId: "j", plan: {} } }))) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(r.result.isError).toBe(true); expect(r.result.content[0]?.text).toContain("could run in parallel");
    const down = (await createMcpHandler(async () => { throw new Error("ECONNREFUSED"); })(rpc("tools/call", { name: "dispatch_next_job", arguments: {} }))) as { result: { content: Array<{ text: string }> } };
    expect(down.result.content[0]?.text).toContain("dispatch");
    const h = createMcpHandler(ok);
    expect(await h(rpc("tools/call", { name: "dispatch_approve_run", arguments: {} }))).toMatchObject({ error: { code: -32602 } });
    expect(await h(rpc("tools/call", { name: "dispatch_start_run", arguments: { jobId: 5 } }))).toMatchObject({ result: { isError: true } });
    expect(await h(rpc("nope"))).toMatchObject({ error: { code: -32601 } });
  });
  test("stdio loop: one JSON line in, one line out; garbage lines get a parse error and the loop continues", async () => {
    const out: string[] = []; async function* lines() { yield JSON.stringify(rpc("ping", undefined, 7)); yield "{not json"; yield "[1]"; yield ""; yield JSON.stringify(rpc("tools/list", undefined, 8)); }
    await serveMcp(lines(), (s) => out.push(s), ok);
    const parsed = out.map((l) => JSON.parse(l)); expect(parsed.map((p) => p.id)).toEqual([7, null, null, 8]); expect(parsed[1].error.code).toBe(-32700); expect(parsed[2].error.code).toBe(-32600);
    expect(out.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n"))).toBe(true);
  });
});

describe("dispatch guard-write: Claude may write only inside the Dispatch work copy", () => {
  let base = ""; let work = ""; let outside = "";
  beforeAll(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "guard-"))); work = join(base, "work"); outside = join(base, "project"); mkdirSync(join(work, "run1", "repo", "notes"), { recursive: true }); mkdirSync(outside); symlinkSync(outside, join(work, "run1", "repo", "escape")); });
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const g = (tool: string, file_path: string, cwd?: string) => guardWrite(JSON.stringify({ tool_name: tool, tool_input: { file_path }, ...(cwd ? { cwd } : {}) }), work);
  test("allows existing and not-yet-existing files inside the work copy, absolute or relative to cwd", () => {
    expect(g("Write", join(work, "run1/repo/notes/new.md")).allow).toBe(true); expect(g("Edit", join(work, "run1/repo/a.txt")).allow).toBe(true);
    expect(g("Write", "notes/x.md", join(work, "run1/repo")).allow).toBe(true);
  });
  test("denies the original project, other places, the work root itself, traversal and symlink escapes", () => {
    for (const p of [join(outside, "a.txt"), "/etc/passwd", join(base, "x"), work, join(work, "..", "project", "a"), join(work, "run1/repo/../../../project/a"), join(work, "run1/repo/escape/pwn.txt")]) expect(g("Write", p).allow).toBe(false);
    expect(g("Write", "../../../project/a", join(work, "run1/repo")).allow).toBe(false);
  });
  test("fails closed: unparseable input, missing path, unknown tool, NUL, and a missing work folder all deny", () => {
    expect(guardWrite("not json", work).allow).toBe(false); expect(guardWrite(JSON.stringify({ tool_name: "Write", tool_input: {} }), work).allow).toBe(false);
    expect(g("Bash", join(work, "a")).allow).toBe(false); expect(g("Write", `${work}/a\0b`).allow).toBe(false);
    expect(guardWrite(JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(work, "a") } }), join(base, "does-not-exist")).allow).toBe(false);
    const r = g("Write", "/etc/passwd"); if (!r.allow) expect(r.reason).toContain("only allowed inside");
  });
});
