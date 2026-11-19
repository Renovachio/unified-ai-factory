import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents, transitionJob } from "@factory/db";
import { enrollWorker, runOnce, type RunnerConfig } from "@factory/runner";
import { detectBackend } from "@factory/sandboxes";
import { claimTask, completeTask, StaleLeaseError } from "@factory/scheduler";
import { MockAdapter, type MockBehavior } from "@factory/runtimes";
import { createTestDb } from "../../db/src/testing";
import { agentTaskExecutor, FileArtifactStore, mockPorts, Orchestrator, type MockPortOptions } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
let org: string;
let repo: string;
let n = 0;
const store = new FileArtifactStore(mkdtempSync(join(tmpdir(), "cas-")));
const wsRoot = mkdtempSync(join(tmpdir(), "orc-ws-"));
const HAPPY = ["QUEUED>INTAKE", "INTAKE>SPECIFYING", "SPECIFYING>READY", "READY>PROVISIONING", "PROVISIONING>BUILDING", "BUILDING>GATING", "GATING>REVIEWING", "REVIEWING>PREMERGE", "PREMERGE>AWAITING_HUMAN"];

beforeAll(async () => {
  db = await createTestDb();
  const [o] = await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`;
  org = o!.id;
  const [r] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`;
  repo = r!.id;
});
afterAll(async () => { await db.drop(); });

async function job(maxRounds = 3): Promise<string> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id, max_rounds) VALUES (${req!.id}, ${repo}, ${maxRounds}) RETURNING id`;
  return j!.id;
}
const runnerCfg = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({ sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" }, heartbeatMs: 1000, ...over });
const executor = (behavior: MockBehavior = "ok") => agentTaskExecutor({ sql: db.sql, adapter: new MockAdapter({ behavior }), store, modelFor: () => "mock", contextUri: (j, r) => `ctx://${j}/${r}` });

/** Drive a job to a resting point by alternating orchestrator ticks and worker polls. A throw from the fault hook = crash + restart. */
async function drive(jobId: string, mk: () => Orchestrator, worker: string, opts: { behavior?: MockBehavior; maxSteps?: number; cfg?: Partial<RunnerConfig> } = {}) {
  let orch = mk();
  let crashes = 0;
  for (let i = 0; i < (opts.maxSteps ?? 200); i++) {
    try {
      const t = await orch.tick(jobId);
      if (t.action === "terminal" || t.action === "awaiting-human") return { ...t, crashes };
      if (t.action === "enqueued" || t.action === "waiting") await runOnce(runnerCfg(opts.cfg), worker, executor(opts.behavior));
    } catch (e) {
      if (!String(e).includes("__crash__")) throw e;
      crashes++;
      orch = mk(); // process restart: all in-memory state lost
    }
  }
  throw new Error("did not settle");
}
const history = async (id: string) => (await db.sql`SELECT from_state, to_state, version FROM job_transitions WHERE job_id=${id} ORDER BY version`).map((r) => `${r.from_state}>${r.to_state}`);
const count = async (table: string, id: string) => (await db.sql.unsafe(`SELECT count(*)::int AS c FROM ${table} WHERE job_id='${id}'`))[0]!.c as number;

describe("mock request reaches PR-ready", () => {
  test("full pipeline: exact legal path, durable artifacts, evidence rows, draft PR recorded, no merge", async () => {
    const id = await job();
    const w = await enrollWorker(runnerCfg());
    const res = await drive(id, () => new Orchestrator({ sql: db.sql, ports: mockPorts() }), w);
    expect(res.state).toBe("AWAITING_HUMAN");
    expect(await history(id)).toEqual(HAPPY);
    const kinds = (await db.sql`SELECT kind, digest FROM artifacts WHERE job_id=${id} ORDER BY kind`);
    expect(kinds.map((k) => k.kind)).toEqual(["build.r0.json", "design.json", "intake.json", "requirements.json", "spec.json", "test-plan.r0.json"]);
    for (const k of kinds) expect(JSON.parse(store.get(k.digest as string).toString())).toHaveProperty("artifactUri"); // integrity-verified read
    expect(await count("gate_results", id)).toBe(1);
    expect(await count("review_results", id)).toBe(1);
    const [pd] = await db.sql`SELECT eligible FROM policy_decisions WHERE job_id=${id}`;
    expect(pd!.eligible).toBe(false); // pilot: never auto-merge
    const [j] = await db.sql`SELECT pr_number, head_sha, base_sha, spec_digest, policy_digest, state FROM jobs WHERE id=${id}`;
    expect(j).toMatchObject({ state: "AWAITING_HUMAN", pr_number: 1 });
    expect(j!.spec_digest).toMatch(/^sha256:/);
    expect(await count("merge_intents", id)).toBe(0);
    const evs = await readEvents(db.sql, id, 0, 500);
    expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i + 1));
    expect(evs.filter((e) => e.type === "job.transitioned").length).toBe(HAPPY.length);
    expect(evs.some((e) => e.type === "approval.requested")).toBe(true);
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE resource=${"job:" + id}`)[0]!.c).toBe(HAPPY.length);
    // idle resting state: repeated ticks change nothing
    const o = new Orchestrator({ sql: db.sql, ports: mockPorts() });
    for (let i = 0; i < 3; i++) expect((await o.tick(id)).action).toBe("awaiting-human");
    expect(await history(id)).toEqual(HAPPY);
  });
});

describe("crash / restart at every point", () => {
  test("a crash at any fault point and any occurrence resumes to the identical coherent history", async () => {
    // 1. discover the fault points reached by a clean run
    const seen: string[] = [];
    const id0 = await job();
    const w0 = await enrollWorker(runnerCfg());
    await drive(id0, () => new Orchestrator({ sql: db.sql, ports: mockPorts(), fault: (p) => { seen.push(p); } }), w0);
    const points = [...new Set(seen)];
    expect(points.length).toBeGreaterThanOrEqual(HAPPY.length * 2 + 4);
    // 2. for every point crash exactly once (first occurrence) and once more at its last occurrence
    for (const point of points) {
      for (const which of ["first", "last"] as const) {
        const occurrences = seen.filter((p) => p === point).length;
        const target = which === "first" ? 1 : occurrences;
        const id = await job();
        const w = await enrollWorker(runnerCfg());
        let hits = 0;
        let fired = false;
        const mk = () => new Orchestrator({ sql: db.sql, ports: mockPorts(), fault: (p) => { if (p === point && !fired && ++hits === target) { fired = true; throw new Error("__crash__"); } } });
        const res = await drive(id, mk, w);
        expect(res.state).toBe("AWAITING_HUMAN");
        expect(fired).toBe(true);
        expect(await history(id)).toEqual(HAPPY);
        expect(await count("tasks", id)).toBe(6);
        expect((await db.sql`SELECT status FROM tasks WHERE job_id=${id}`).every((t) => t.status === "succeeded")).toBe(true);
        expect(await count("artifacts", id)).toBe(6);
        expect(await count("gate_results", id)).toBe(1);
        expect(await count("review_results", id)).toBe(1);
        expect(await count("policy_decisions", id)).toBe(1);
        const evs = await readEvents(db.sql, id, 0, 500);
        expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i + 1));
        expect(evs.filter((e) => e.type === "job.transitioned").length).toBe(HAPPY.length);
      }
    }
  }, 120_000);

  test("stale worker: a worker that dies mid-task is fenced out; the task is retried by another worker; history stays coherent", async () => {
    const id = await job();
    const orch = new Orchestrator({ sql: db.sql, ports: mockPorts() });
    const w1 = await enrollWorker(runnerCfg());
    const w2 = await enrollWorker(runnerCfg());
    await orch.tick(id); // QUEUED -> INTAKE
    await orch.tick(id); // enqueue intake
    const lease = (await claimTask(db.sql, { workerId: w1, ttlMs: 50 }))!;
    expect(lease.role).toBe("intake");
    await new Promise((r) => setTimeout(r, 120)); // w1 "dies"; lease expires
    await orch.tick(id); // expiry sweep requeues (attempt 2)
    await db.sql`UPDATE tasks SET not_before = now() WHERE id=${lease.taskId}`; // skip retry backoff in the test
    const res = await drive(id, () => new Orchestrator({ sql: db.sql, ports: mockPorts() }), w2);
    expect(res.state).toBe("AWAITING_HUMAN");
    await expect(completeTask(db.sql, { taskId: lease.taskId, workerId: w1, leaseToken: lease.leaseToken, outcome: "succeeded" })).rejects.toBeInstanceOf(StaleLeaseError);
    expect(await history(id)).toEqual(HAPPY);
    expect(await count("tasks", id)).toBe(6);
    expect((await db.sql`SELECT attempt FROM tasks WHERE id=${lease.taskId}`)[0]!.attempt).toBe(2);
    expect((await readEvents(db.sql, id, 0, 500)).some((e) => e.type === "task.expired")).toBe(true);
  });

  test("concurrent orchestrators + workers on one job still produce one coherent history", async () => {
    const id = await job();
    const w = await Promise.all([enrollWorker(runnerCfg()), enrollWorker(runnerCfg())]);
    const mk = () => new Orchestrator({ sql: db.sql, ports: mockPorts() });
    const results = await Promise.all([drive(id, mk, w[0]!), drive(id, mk, w[1]!), drive(id, mk, w[0]!)]);
    expect(results.every((r) => r.state === "AWAITING_HUMAN")).toBe(true);
    expect(await history(id)).toEqual(HAPPY);
    expect(await count("tasks", id)).toBe(6);
    expect(await count("artifacts", id)).toBe(6);
  });
});

describe("rework, failure, cancel and invalid transitions", () => {
  test("gate failure -> REWORK -> new round with a new candidate; evidence is per head SHA", async () => {
    const id = await job();
    const w = await enrollWorker(runnerCfg());
    const opts: MockPortOptions = { gateFailRounds: [0] };
    await drive(id, () => new Orchestrator({ sql: db.sql, ports: mockPorts(opts) }), w);
    expect(await history(id)).toEqual([...HAPPY.slice(0, 6), "GATING>REWORK", "REWORK>BUILDING", "BUILDING>GATING", "GATING>REVIEWING", "REVIEWING>PREMERGE", "PREMERGE>AWAITING_HUMAN"]);
    const gates = await db.sql`SELECT head_sha, verdict FROM gate_results WHERE job_id=${id} ORDER BY created_at`;
    expect(gates.map((g) => g.verdict)).toEqual(["fail", "pass"]);
    expect(gates[0]!.head_sha).not.toBe(gates[1]!.head_sha);
    expect((await db.sql`SELECT kind FROM artifacts WHERE job_id=${id} AND kind LIKE 'build.%' ORDER BY kind`).map((a) => a.kind)).toEqual(["build.r0.json", "build.r1.json"]);
    expect((await db.sql`SELECT current_round FROM jobs WHERE id=${id}`)[0]!.current_round).toBe(1);
  });
  test("reviewer requesting changes sends the job back to rework and re-runs gates and reviews on the new SHA", async () => {
    const id = await job();
    const w = await enrollWorker(runnerCfg());
    await drive(id, () => new Orchestrator({ sql: db.sql, ports: mockPorts({ reviewChangesRounds: [0], roles: ["code", "security"] }) }), w);
    expect((await history(id)).filter((h) => h === "REVIEWING>REWORK").length).toBe(1);
    expect(await count("gate_results", id)).toBe(2);
    const heads = new Set((await db.sql`SELECT head_sha FROM review_results WHERE job_id=${id}`).map((r) => r.head_sha));
    expect(heads.size).toBe(2);
  });
  test("rework budget exhausted -> escalates to a human; never loops forever, never merges", async () => {
    const id = await job(2);
    const w = await enrollWorker(runnerCfg());
    const res = await drive(id, () => new Orchestrator({ sql: db.sql, ports: mockPorts({ gateFailRounds: [0, 1, 2, 3, 4] }) }), w);
    expect(res.state).toBe("AWAITING_HUMAN");
    expect((await history(id)).filter((h) => h === "REWORK>BUILDING").length).toBe(2);
    expect(await count("gate_results", id)).toBe(3);
    expect(await count("merge_intents", id)).toBe(0);
  });
  test("an agent task that exhausts its budget fails the job with an error code and revokes leases", async () => {
    const id = await job();
    const w = await enrollWorker(runnerCfg());
    const res = await drive(id, () => new Orchestrator({ sql: db.sql, ports: mockPorts() }), w, { behavior: "fail" });
    expect(res.state).toBe("FAILED");
    expect((await db.sql`SELECT last_error_code, state FROM jobs WHERE id=${id}`)[0]).toMatchObject({ state: "FAILED", last_error_code: "task-failed:intake" });
    expect((await db.sql`SELECT count(*)::int AS c FROM tasks WHERE job_id=${id} AND status IN ('pending','leased','running')`)[0]!.c).toBe(0);
  });
  test("cancel revokes leases first, is idempotent, and fences the worker", async () => {
    const id = await job();
    const orch = new Orchestrator({ sql: db.sql, ports: mockPorts() });
    const w = await enrollWorker(runnerCfg());
    await orch.tick(id); await orch.tick(id);
    const lease = (await claimTask(db.sql, { workerId: w }))!;
    expect(await orch.cancel(id, "operator")).toMatchObject({ state: "CANCELLED", action: "transitioned" });
    expect(await orch.cancel(id, "again")).toMatchObject({ action: "terminal" });
    await expect(completeTask(db.sql, { taskId: lease.taskId, workerId: w, leaseToken: lease.leaseToken, outcome: "succeeded" })).rejects.toBeInstanceOf(StaleLeaseError);
    expect((await orch.tick(id)).action).toBe("terminal");
  });
  test("invalid transitions are impossible from every layer: orchestrator API, transitionJob, raw SQL", async () => {
    const id = await job();
    await expect(transitionJob(db.sql, { jobId: id, expectedVersion: 1, next: "MERGING", actor: "x" })).rejects.toThrow(/illegal transition/);
    await expect(db.sql`UPDATE jobs SET state='MERGED', version=2 WHERE id=${id}`).rejects.toThrow(/illegal job transition/);
    await expect(db.sql`UPDATE jobs SET state='GATING', version=2 WHERE id=${id}`).rejects.toThrow(/illegal job transition/);
    expect((await db.sql`SELECT state, version FROM jobs WHERE id=${id}`)[0]).toMatchObject({ state: "QUEUED", version: 1 });
  });
  test("paused jobs do not advance; resumed jobs continue where they stopped", async () => {
    const id = await job();
    const orch = new Orchestrator({ sql: db.sql, ports: mockPorts() });
    await db.sql`UPDATE jobs SET paused_at = now(), pause_reason = 'operator' WHERE id=${id}`;
    expect((await orch.tick(id)).action).toBe("paused");
    expect(await history(id)).toEqual([]);
    await db.sql`UPDATE jobs SET paused_at = NULL, pause_reason = NULL WHERE id=${id}`;
    expect((await orch.tick(id)).state).toBe("INTAKE");
  });
});
