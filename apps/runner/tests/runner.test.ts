import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "@factory/db";
import { createTestDb } from "../../../packages/db/src/testing";
import { detectBackend, NoIsolationBackend, PolicyViolation } from "@factory/sandboxes";
import { enqueueTask, revokeJobLeases, claimTask } from "@factory/scheduler";
import { assertRunnerEligible, enrollWorker, runLeasedTask, runOnce, type RunnerConfig } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
let org: string;
let repo: string;
let n = 0;
const wsRoot = mkdtempSync(join(tmpdir(), "runner-ws-"));
const cfg = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
  sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" }, heartbeatMs: 50, ...over,
});
beforeAll(async () => {
  db = await createTestDb();
  const [o] = await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`;
  org = o!.id;
  const [r] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`;
  repo = r!.id;
});
afterAll(async () => { await db.drop(); });
async function job() {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repo}) RETURNING id`;
  return j!.id as string;
}

describe("enrollment (SECURITY.md worker checks)", () => {
  test("refuses model API keys / credentials in the worker environment", async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN"]) {
      await expect(enrollWorker(cfg({ processEnv: { [k]: "x" } }))).rejects.toThrow(PolicyViolation);
    }
    expect((await db.sql`SELECT count(*)::int AS c FROM workers`)[0]!.c).toBe(0);
  });
  test("refuses root and refuses to run without OS isolation unless explicitly trusted", async () => {
    expect(() => assertRunnerEligible({ backend: detectBackend(), processEnv: {}, uid: 0 })).toThrow(/root/);
    expect(() => assertRunnerEligible({ backend: new NoIsolationBackend(), processEnv: {}, uid: 1000 })).toThrow(/confinement/);
    expect(() => assertRunnerEligible({ backend: new NoIsolationBackend(), processEnv: {}, uid: 1000, trustedRepositoryOnly: true })).not.toThrow();
  });
  test("registers a worker advertising its sandbox", async () => {
    const id = await enrollWorker(cfg());
    const [w] = await db.sql`SELECT capability_json AS c FROM workers WHERE id=${id}`;
    expect(w!.c.isolation).toBe("strong");
  });
});

describe("task execution", () => {
  test("runs a leased task in a confined workspace, reports fenced events, completes, and tears down", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "build", role: "rbuilder" });
    const w = await enrollWorker(cfg());
    const out = await runOnce(cfg(), w, async (ctx) => {
      const r = await ctx.run("/bin/sh", ["-c", "echo hello > out.txt && cat out.txt && cat /etc/hosts >/dev/null 2>&1; echo leaked=$ANTHROPIC_API_KEY"]);
      await ctx.report("agent.progress", { message: "ran" });
      expect(existsSync(ctx.workspace.repoDir)).toBe(true);
      return { ok: r.exitCode === 0 && r.stdout.includes("hello") && r.stdout.includes("leaked=\n"), payload: { stdout: r.stdout } };
    }, ["rbuilder"]);
    expect(out?.status).toBe("succeeded");
    expect(out?.cleanup.removed).toBe(true);
    expect(readdirSync(wsRoot)).toEqual([]);
    const types = (await readEvents(db.sql, j)).map((e) => e.type);
    expect(types).toEqual(["task.claimed", "agent.progress", "runner.cleanup", "agent.completed"]);
    expect((await db.sql`SELECT status FROM tasks WHERE job_id=${j}`)[0]!.status).toBe("succeeded");
  });
  test("executor failure marks the task failed and still cleans up", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "build", role: "rfail" });
    const w = await enrollWorker(cfg());
    const out = await runOnce(cfg(), w, async (ctx) => { const r = await ctx.run("/bin/sh", ["-c", "exit 3"]); return { ok: r.exitCode === 0 }; }, ["rfail"]);
    expect(out?.status).toBe("failed");
    expect(out?.cleanup.removed).toBe(true);
    expect(readdirSync(wsRoot)).toEqual([]);
  });
  test("executor exception: no completion reported, workspace removed", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "build", role: "rthrow" });
    const w = await enrollWorker(cfg());
    const out = await runOnce(cfg(), w, async () => { throw new Error("kaboom"); }, ["rthrow"]);
    expect(out?.status).toBe("error");
    expect(out?.error).toBe("kaboom");
    expect(readdirSync(wsRoot)).toEqual([]);
    expect((await db.sql`SELECT status FROM tasks WHERE job_id=${j}`)[0]!.status).toBe("leased"); // left for lease expiry / retry
  });
  test("cancellation mid-run: lease revoked -> process group killed, workspace removed, stale attempt reports nothing", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "build", role: "rcancel" });
    const w = await enrollWorker(cfg());
    const lease = (await claimTask(db.sql, { workerId: w, roles: ["rcancel"] }))!;
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const run = runLeasedTask(cfg(), w, lease, async (ctx) => {
      const p = ctx.run("/bin/sh", ["-c", "sleep 60 & sleep 60 & wait"], { timeoutMs: 60_000 });
      started();
      const r = await p;
      expect(r.cancelled).toBe(true);
      expect(r.groupGone).toBe(true);
      await ctx.report("agent.progress", { message: "should never be accepted" }).catch(() => undefined);
      return { ok: true };
    });
    await ready;
    await new Promise((r) => setTimeout(r, 100));
    await revokeJobLeases(db.sql, j, "operator cancel");
    const out = await run;
    expect(out.status).toBe("lease_lost");
    expect(out.cleanup.removed).toBe(true);
    expect(readdirSync(wsRoot)).toEqual([]);
    const types = (await readEvents(db.sql, j)).map((e) => e.type);
    expect(types).not.toContain("agent.completed");
    expect(types).not.toContain("agent.progress");
    expect((await db.sql`SELECT status FROM tasks WHERE job_id=${j}`)[0]!.status).toBe("cancelled");
  });
  test("a malicious task script cannot reach host files, network, or secrets", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "gate", role: "rmal" });
    const w = await enrollWorker(cfg());
    const out = await runOnce(cfg(), w, async (ctx) => {
      const r = await ctx.run("/bin/sh", ["-c", "cat ~/../../etc/hosts 2>/dev/null | head -c 5; curl -s -m 2 http://127.0.0.1:9/ ; ls /Users 2>/dev/null; env | grep -i -E 'key|token|secret' ; true"]);
      return { ok: r.stdout.trim() === "", payload: { len: r.stdout.length } };
    }, ["rmal"]);
    expect(out?.status).toBe("succeeded");
  });
});
