/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are untyped JSON */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../packages/db/src/testing";
import { bootstrapLocalOwner, CompositeAuthenticator, createApi, LOCAL_AGENT_SUBJECT, LocalOwnerAuthenticator } from "../src/index";

const OWNER = "o".repeat(48); const AGENT = "a".repeat(48);
let db: Awaited<ReturnType<typeof createTestDb>>; let api: (r: Request) => Promise<Response>; let orgId = ""; let home = ""; let n = 0;
const saved = { tok: process.env.DISPATCH_LOCAL_TOKEN_FILE, home: process.env.DISPATCH_HOME };

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "mem-home-"))); process.env.DISPATCH_HOME = home; process.env.DISPATCH_LOCAL_TOKEN_FILE = "/unused";
  db = await createTestDb(); orgId = await bootstrapLocalOwner(db.sql);
  api = createApi({ log: () => {}, sql: db.sql, rateLimit: { capacity: 100000, refillPerSec: 100000 }, authenticator: new CompositeAuthenticator([new LocalOwnerAuthenticator(OWNER), new LocalOwnerAuthenticator(AGENT, LOCAL_AGENT_SUBJECT)]) });
});
afterAll(async () => {
  await db.drop(); rmSync(home, { recursive: true, force: true });
  if (saved.tok === undefined) delete process.env.DISPATCH_LOCAL_TOKEN_FILE; else process.env.DISPATCH_LOCAL_TOKEN_FILE = saved.tok;
  if (saved.home === undefined) delete process.env.DISPATCH_HOME; else process.env.DISPATCH_HOME = saved.home;
});
const call = async (path: string, o: { method?: string; token?: string; body?: unknown } = {}) => {
  const r = await api(new Request(`http://api.test/api/v2/dispatch${path}`, { method: o.method ?? "GET", headers: { authorization: `Bearer ${o.token ?? OWNER}`, ...(o.method === "POST" ? { "idempotency-key": `k${n++}-${Math.random()}`, "content-type": "application/json" } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }));
  const body = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (typeof body.type === "string") body.code = body.type.split("/").pop();
  return { status: r.status, body };
};
async function project(): Promise<{ projectId: string; jobId: string }> {
  const [repo] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name, local_path) VALUES (${orgId}, 'local', ${"m" + n++}, 'local', 'proj', '/tmp/x') RETURNING id`;
  const [rq] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo!.id}, 'dispatch', ${"s" + n++}, 'x', 'feature', 'W', 'D') RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id, state) VALUES (${rq!.id}, ${repo!.id}, 'QUEUED') RETURNING id`;
  return { projectId: repo!.id as string, jobId: j!.id as string };
}
const NOTE = "We decided that the invoice export must always use UTC timestamps for every customer record.";

describe("dispatch memory routes", () => {
  test("a human note becomes PROPOSED memory; the agent cannot write notes or approve", async () => {
    const p = await project();
    expect((await call("/memory/note", { method: "POST", token: AGENT, body: { ...p, text: NOTE } })).status).toBe(403);
    const r = await call("/memory/note", { method: "POST", body: { ...p, text: NOTE } });
    expect(r.status).toBe(201); expect(r.body.proposed).toBeGreaterThan(0);
    const id = r.body.memoryIds[0];
    expect((await call(`/memory/${id}/decision`, { method: "POST", token: AGENT, body: { projectId: p.projectId, decision: "approve" } })).status).toBe(403);
    const list = await call(`/memory?projectId=${p.projectId}&status=proposed`);
    expect(list.body.items.length).toBeGreaterThan(0);
  });
  test("proposed memory is not served to the agent", async () => {
    const p = await project();
    await call("/memory/note", { method: "POST", body: { ...p, text: NOTE } });
    const c = await call(`/memory/context?projectId=${p.projectId}&task=${encodeURIComponent("invoice export timestamps")}`, { token: AGENT });
    expect(c.status).toBe(200); expect(c.body.memoryIds).toEqual([]);
  });
  test("the person who wrote the note approves it; then the agent receives it and gives feedback; consent gates signals", async () => {
    const p = await project();
    const r = await call("/memory/note", { method: "POST", body: { ...p, text: NOTE } });
    const id = r.body.memoryIds[0];
    expect((await call(`/memory/${id}/decision`, { method: "POST", body: { projectId: p.projectId, decision: "approve" } })).status).toBe(200);
    const c = await call(`/memory/context?projectId=${p.projectId}&task=${encodeURIComponent("invoice export timestamps")}`, { token: AGENT });
    expect(c.status).toBe(200); expect(c.body.memoryIds).toContain(id); expect(c.body.text).toContain("UTC");
    const f = await call("/memory/feedback", { method: "POST", token: AGENT, body: { projectId: p.projectId, memoryId: id, verdict: "useful" } });
    expect(f.status).toBe(201); expect(f.body.signalState).toBe("not_requested");
    expect((await call("/memory/consent", { method: "POST", token: AGENT, body: { projectId: p.projectId, optedIn: true, reason: "x" } })).status).toBe(403);
    expect((await call("/memory/consent", { method: "POST", body: { projectId: p.projectId, optedIn: true, reason: "my own project" } })).status).toBe(200);
  });
  test("bad input is refused: unknown project, empty task, bad verdict, other project's memory", async () => {
    const p = await project(); const q = await project();
    expect((await call("/memory/context?projectId=nope&task=x", { token: AGENT })).status).toBe(422);
    expect((await call(`/memory/context?projectId=${p.projectId}&task=`, { token: AGENT })).status).toBe(422);
    const r = await call("/memory/note", { method: "POST", body: { ...p, text: NOTE } });
    const id = r.body.memoryIds[0];
    expect((await call(`/memory/${id}/decision`, { method: "POST", body: { projectId: q.projectId, decision: "approve" } })).status).toBe(404);
    expect((await call("/memory/feedback", { method: "POST", token: AGENT, body: { projectId: p.projectId, memoryId: id, verdict: "great" } })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("review support for the browser (MEM-07)", () => {
  const OVERLAP = "We decided that the invoice export must always use UTC timestamps for every customer record and every invoice line.";
  test("conflicts: a proposed memory that overlaps approved memory lists it; approval needs exactly those ids; the agent cannot read the list", async () => {
    const p = await project();
    const first = (await call("/memory/note", { method: "POST", body: { ...p, text: NOTE } })).body.memoryIds[0];
    expect((await call(`/memory/${first}/decision`, { method: "POST", body: { projectId: p.projectId, decision: "approve" } })).status).toBe(200);
    const second = (await call("/memory/note", { method: "POST", body: { ...p, text: OVERLAP } })).body.memoryIds[0];
    const c = await call(`/memory/${second}/conflicts?projectId=${p.projectId}`);
    expect(c.status).toBe(200); expect(c.body.items.map((x: any) => x.id)).toEqual([first]); expect(c.body.items[0].claim).toContain("UTC");
    expect((await call(`/memory/${second}/conflicts?projectId=${p.projectId}`, { token: AGENT })).status).toBe(403);
    // Plain approval is refused with a conflict; naming the wrong set is refused; naming exactly the overlap erases it and approves.
    expect((await call(`/memory/${second}/decision`, { method: "POST", body: { projectId: p.projectId, decision: "approve" } })).status).toBe(409);
    expect((await call(`/memory/${second}/decision`, { method: "POST", body: { projectId: p.projectId, decision: "approve", acceptErasureOf: [second] } })).status).toBe(409);
    expect((await call(`/memory/${second}/decision`, { method: "POST", token: AGENT, body: { projectId: p.projectId, decision: "approve", acceptErasureOf: [first] } })).status).toBe(403);
    const ok = await call(`/memory/${second}/decision`, { method: "POST", body: { projectId: p.projectId, decision: "approve", acceptErasureOf: [first] } });
    expect(ok.status).toBe(200); expect(ok.body.erased).toEqual([first]); expect(ok.body.memory.status).toBe("approved");
    const all = (await call(`/memory?projectId=${p.projectId}`)).body.items as any[];
    const old = all.find((m) => m.id === first); expect(old.status).not.toBe("approved"); expect(old.usable).toBe(false); expect(old.claim).not.toContain("UTC");
    // Once decided, there is nothing left to resolve.
    expect((await call(`/memory/${second}/conflicts?projectId=${p.projectId}`)).body.items).toEqual([]);
  });
  test("conflicts are project scoped: another project's id is not found", async () => {
    const p = await project(); const q = await project();
    const id = (await call("/memory/note", { method: "POST", body: { ...p, text: NOTE } })).body.memoryIds[0];
    expect((await call(`/memory/${id}/conflicts?projectId=${q.projectId}`)).status).toBe(404);
    expect((await call(`/memory/not-an-id/conflicts?projectId=${p.projectId}`)).status).toBe(422);
  });
  test("consent can be read by anyone in the project; it starts off and follows the latest change", async () => {
    const p = await project();
    const r0 = await call(`/memory/consent?projectId=${p.projectId}`, { token: AGENT });
    expect(r0.status).toBe(200); expect(r0.body.optedIn).toBe(false);
    expect((await call("/memory/consent", { method: "POST", body: { projectId: p.projectId, optedIn: true, reason: "on" } })).status).toBe(200);
    expect((await call(`/memory/consent?projectId=${p.projectId}`)).body.optedIn).toBe(true);
    expect((await call("/memory/consent", { method: "POST", body: { projectId: p.projectId, optedIn: false, reason: "off" } })).status).toBe(200);
    expect((await call(`/memory/consent?projectId=${p.projectId}`)).body.optedIn).toBe(false);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call(`/memory/consent?projectId=${missing}`)).status).toBe(404);
  });
});
