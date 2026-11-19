/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are untyped JSON */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestDb } from "../../../packages/db/src/testing";
import { bootstrapLocalOwner, CompositeAuthenticator, createApi, LOCAL_AGENT_SUBJECT, LocalOwnerAuthenticator } from "../src/index";

const OWNER = "o".repeat(48); const AGENT = "a".repeat(48); const OTHER = "x".repeat(48);
let db: Awaited<ReturnType<typeof createTestDb>>; let api: (r: Request) => Promise<Response>; let orgId = ""; let n = 0;
let home = ""; let proj = "";
const saved = { tok: process.env.DISPATCH_LOCAL_TOKEN_FILE, home: process.env.DISPATCH_HOME };
const put = (rel: string, body: string, dir = proj) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "runs-home-"))); process.env.DISPATCH_HOME = home; process.env.DISPATCH_LOCAL_TOKEN_FILE = "/unused";
  db = await createTestDb(); orgId = await bootstrapLocalOwner(db.sql);
  const [o2] = await db.sql`INSERT INTO organizations (name) VALUES ('other') RETURNING id`; await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${o2!.id}, 'other-admin', 'admin')`;
  api = createApi({ log: (l) => { if (process.env.RUNS_DEBUG) console.error(JSON.stringify(l)); }, sql: db.sql, rateLimit: { capacity: 100000, refillPerSec: 100000 }, authenticator: new CompositeAuthenticator([new LocalOwnerAuthenticator(OWNER), new LocalOwnerAuthenticator(AGENT, LOCAL_AGENT_SUBJECT), new LocalOwnerAuthenticator(OTHER, "other-admin")]) });
});
afterAll(async () => { await db.drop(); rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); if (saved.tok === undefined) delete process.env.DISPATCH_LOCAL_TOKEN_FILE; else process.env.DISPATCH_LOCAL_TOKEN_FILE = saved.tok; if (saved.home === undefined) delete process.env.DISPATCH_HOME; else process.env.DISPATCH_HOME = saved.home; });

const call = async (path: string, o: { method?: string; token?: string; body?: unknown } = {}) => {
  const r = await api(new Request(`http://api.test/api/v2/dispatch${path}`, { method: o.method ?? "GET", headers: { authorization: `Bearer ${o.token ?? OWNER}`, ...(o.method === "POST" ? { "idempotency-key": `k${++n}`, "content-type": "application/json" } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }));
  const body = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (typeof body.type === "string") body.code = body.type.split("/").pop(); // problem+json carries its code in the type URL
  return { status: r.status, body };
};
const agent = (path: string, body?: unknown, method = "POST") => call(path, { token: AGENT, method, ...(body !== undefined ? { body } : {}) });
const t = (id: string, o: Record<string, unknown> = {}) => ({ id, goal: "do " + id, model: "haiku", reads: [], writes: [], dependsOn: [], ...o });
const plan = (...tasks: unknown[]) => ({ summary: "s", tasks });

async function freshJob(): Promise<string> {
  proj = realpathSync(mkdtempSync(join(tmpdir(), "runs-proj-")));
  put("notes/a.txt", "alpha\n"); put("notes/b.txt", "beta\n"); put(".env", "SECRET=1\n");
  const [repo] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name, local_path) VALUES (${orgId}, 'local', ${"p" + n++}, 'local', 'proj', ${proj}) RETURNING id`;
  const [rq] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo!.id}, 'dispatch', ${"s" + n++}, 'x', 'feature', 'Write notes', 'summarise the notes folder') RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id, state) VALUES (${rq!.id}, ${repo!.id}, 'QUEUED') RETURNING id`; return j!.id as string;
}
const goodPlan = () => plan(t("read", { reads: ["notes/"] }), t("write", { model: "sonnet", writes: ["notes/", "out/"], dependsOn: ["read"] }));

describe("work runs: the agent identity may submit work, never approve it", () => {
  test("the agent token is a separate, non-admin identity", async () => {
    const r = await api(new Request("http://api.test/api/v1/session", { headers: { authorization: `Bearer ${AGENT}` } })); expect(await r.json()).toMatchObject({ role: "editor" });
    expect((await db.sql`SELECT count(*) AS c FROM users WHERE auth_subject = ${LOCAL_AGENT_SUBJECT}`)[0]!.c).toBe("1");
    expect(await bootstrapLocalOwner(db.sql)).toBe(orgId); expect((await db.sql`SELECT count(*) AS c FROM users WHERE auth_subject = ${LOCAL_AGENT_SUBJECT}`)[0]!.c).toBe("1");
  });
  test("next work offers the oldest queued local job with its request and folder", async () => {
    const id = await freshJob(); const r = await agent("/work/next", undefined, "GET");
    expect(r.body).toMatchObject({ job: { id, title: "Write notes", request: "summarise the notes folder" }, project: { path: proj } });
  });
  test("a bad plan is refused with reasons: unsafe paths, overlapping parallel writes, unknown model", async () => {
    const id = await freshJob();
    for (const p of [plan(t("a", { writes: ["../x"] })), plan(t("a", { writes: ["x/"] }), t("b", { writes: ["x/y"] })), plan(t("a", { model: "gpt-4" })), { nope: 1 }]) {
      const r = await agent("/runs", { jobId: id, plan: p }); expect(r.status).toBe(422);
    }
    expect((await agent("/runs", { jobId: id, plan: plan(t("a", { writes: ["x/"] }), t("b", { writes: ["x/y"] })) })).body.errors?.join(" ")).toContain("parallel");
    expect((await db.sql`SELECT count(*) AS c FROM work_runs WHERE job_id = ${id}`)[0]!.c).toBe("0");
  });
  test("full lifecycle: start, copy without secrets, progress, finish, human sees the diff, wrong digest refused, approve applies", async () => {
    const id = await freshJob(); const s = await agent("/runs", { jobId: id, plan: goodPlan() }); expect(s.status).toBe(201);
    const { runId, workspace } = s.body as { runId: string; workspace: string };
    expect(s.body).toMatchObject({ waves: [["read"], ["write"]], byModel: { haiku: 1, sonnet: 1, opus: 0 } }); expect(existsSync(join(workspace, "notes/a.txt"))).toBe(true); expect(existsSync(join(workspace, ".env"))).toBe(false);
    expect((await agent("/runs", { jobId: id, plan: goodPlan() })).status).toBe(409); // one live run per job
    expect((await agent("/work/next", undefined, "GET")).body.job?.id).not.toBe(id);
    expect((await agent(`/runs/${runId}/progress`, { note: "reading\u001b[31m notes" })).status).toBe(200);
    put("notes/a.txt", "ALPHA\n", workspace); put("out/summary.md", "# Summary\n", workspace);
    const f = await agent(`/runs/${runId}/finish`, { summary: "uppercased a, wrote a summary" }); expect(f.body).toMatchObject({ status: "awaiting_approval", changes: 2 });
    const digest = f.body.digest as string;
    expect((await agent(`/runs/${runId}/decision`, { decision: "approve", digest })).status).toBe(403); // the agent can NOT approve
    expect((await agent(`/runs/${runId}/progress`, { note: "late" })).status).toBe(409);               // no more work after finishing
    const v = await call(`/runs/${runId}`); expect(v.body.status).toBe("awaiting_approval"); expect(v.body.diff).toContain("+ALPHA"); expect(v.body.diff).toContain("-alpha"); expect(v.body.diff).toContain("+# Summary");
    expect(v.body.log).toEqual([{ at: expect.any(String), note: "reading [31m notes" }]); // real objects; the ESC control character is gone
    expect(JSON.stringify(v.body.log)).not.toContain("\u001b"); expect(v.body.plan.tasks.map((x: any) => x.model)).toEqual(["haiku", "sonnet"]);
    expect(readFileSync(join(proj, "notes/a.txt"), "utf8")).toBe("alpha\n"); // nothing applied yet
    expect((await call(`/runs/${runId}/decision`, { method: "POST", body: { decision: "approve", digest: "sha256:wrong" } })).body.code).toBe("changes-differ");
    const ok = await call(`/runs/${runId}/decision`, { method: "POST", body: { decision: "approve", digest } }); expect(ok.body).toMatchObject({ status: "applied", applied: 2 });
    expect(readFileSync(join(proj, "notes/a.txt"), "utf8")).toBe("ALPHA\n"); expect(readFileSync(join(proj, "out/summary.md"), "utf8")).toBe("# Summary\n"); expect(readFileSync(join(proj, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(existsSync(workspace)).toBe(false);
    expect((await call(`/runs/${runId}/decision`, { method: "POST", body: { decision: "approve", digest } })).status).toBe(409);
    const [row] = await db.sql`SELECT status, decided_by FROM work_runs WHERE id = ${runId}`; expect(row!.status).toBe("applied"); expect(row!.decided_by).not.toBeNull();
    expect((await db.sql`SELECT count(*) AS c FROM audit_entries WHERE resource = ${"run:" + runId}`)[0]!.c).toBe("3"); // start, finish, approve
  });
  test("changes outside the plan's write scopes fail the run, delete the copy and leave the job eligible again", async () => {
    const id = await freshJob(); const s = await agent("/runs", { jobId: id, plan: plan(t("w", { writes: ["out/"] })) });
    const { runId, workspace } = s.body as { runId: string; workspace: string }; put("out/ok.md", "ok\n", workspace); put("notes/a.txt", "sneaky\n", workspace);
    const f = await agent(`/runs/${runId}/finish`, { summary: "done" }); expect(f.body).toMatchObject({ status: "failed" }); expect(f.body.failure).toContain("notes/a.txt");
    expect(existsSync(workspace)).toBe(false); expect(readFileSync(join(proj, "notes/a.txt"), "utf8")).toBe("alpha\n");
    expect((await db.sql`SELECT count(*) AS c FROM work_runs WHERE job_id = ${id} AND status IN ('running', 'awaiting_approval', 'applied')`)[0]!.c).toBe("0"); // eligible again
    const s2 = await agent("/runs", { jobId: id, plan: plan(t("w", { writes: ["out/"] })) }); expect(s2.status).toBe(201);
    const r2 = s2.body as { runId: string; workspace: string }; expect((await agent(`/runs/${r2.runId}/finish`, { summary: "nothing" })).body.failure).toBe("no changes were made");
  });
  test("if you edit the original meanwhile, approval applies NOTHING; you can still reject", async () => {
    const id = await freshJob(); const s = await agent("/runs", { jobId: id, plan: plan(t("w", { writes: ["notes/"] })) }); const { runId, workspace } = s.body as { runId: string; workspace: string };
    put("notes/a.txt", "A2\n", workspace); put("notes/b.txt", "B2\n", workspace); const f = await agent(`/runs/${runId}/finish`, { summary: "x" });
    put("notes/a.txt", "my newer edit\n");
    const ap = await call(`/runs/${runId}/decision`, { method: "POST", body: { decision: "approve", digest: f.body.digest } });
    expect(ap.status).toBe(409); expect(ap.body.code).toBe("apply-conflict"); expect(ap.body.detail).toContain("notes/a.txt");
    expect(readFileSync(join(proj, "notes/a.txt"), "utf8")).toBe("my newer edit\n"); expect(readFileSync(join(proj, "notes/b.txt"), "utf8")).toBe("beta\n");
    expect((await call(`/runs/${runId}`)).body.status).toBe("awaiting_approval");
    expect((await call(`/runs/${runId}/decision`, { method: "POST", body: { decision: "reject", digest: "" } })).body).toMatchObject({ status: "rejected" });
    expect(existsSync(workspace)).toBe(false);
  });
  test("if the real folder changes during a run, the finish response and the run log warn about it", async () => {
    const id = await freshJob(); const s = await agent("/runs", { jobId: id, plan: plan(t("w", { writes: ["out/"] })) }); const { runId, workspace } = s.body as { runId: string; workspace: string };
    put("out/x.md", "x\n", workspace); put("notes/a.txt", "written outside the copy\n"); // simulates an agent writing to the original
    const f = await agent(`/runs/${runId}/finish`, { summary: "x" }); expect(f.body.originalChanged).toEqual(["notes/a.txt"]);
    const lg = (await call(`/runs/${runId}`)).body.log as Array<{ note: string }>; expect(lg.length).toBe(1); expect(lg[0]?.note).toContain("WARNING"); expect(typeof lg[0]).toBe("object");
    await call(`/runs/${runId}/decision`, { method: "POST", body: { decision: "reject", digest: "" } });
  });
  test("another organisation cannot see or decide this run; a viewer-style unknown id is a 404; without local mode the routes do not exist", async () => {
    const id = await freshJob(); const s = await agent("/runs", { jobId: id, plan: plan(t("w", { writes: ["out/"] })) }); const runId = s.body.runId as string;
    expect((await call(`/runs/${runId}`, { token: OTHER })).status).toBe(404); expect((await call("/runs", { token: OTHER })).body.items).toEqual([]);
    expect((await call(`/runs/${runId}/decision`, { token: OTHER, method: "POST", body: { decision: "reject", digest: "" } })).status).toBe(404);
    expect((await call("/runs/not-a-uuid")).status).toBe(404);
    expect((await agent("/runs", { jobId: "00000000-0000-4000-8000-000000000000", plan: goodPlan() })).status).toBe(404);
    delete process.env.DISPATCH_LOCAL_TOKEN_FILE; try { expect((await call("/work/next")).status).toBe(404); } finally { process.env.DISPATCH_LOCAL_TOKEN_FILE = "/unused"; }
  });
  test("a GitHub-backed job cannot be worked this way", async () => {
    const [repo] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${orgId}, 'github', ${"g" + n++}, 'o', 'r') RETURNING id`;
    const [rq] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo!.id}, 'api', ${"g" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
    const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id, state) VALUES (${rq!.id}, ${repo!.id}, 'QUEUED') RETURNING id`;
    expect((await agent("/runs", { jobId: j!.id, plan: goodPlan() })).status).toBe(422);
  });
});
