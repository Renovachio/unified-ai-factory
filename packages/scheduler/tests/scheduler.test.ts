import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readEvents } from "@factory/db";
import { createTestDb } from "../../db/src/testing";
import { claimTask, completeTask, enqueueTask, expireLeases, heartbeatTask, LEASE_TTL_MS, registerWorker, reportTaskEvent, revokeJobLeases, setWorkerStatus, StaleLeaseError } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
let org: string;
let repo: string;
let n = 0;
beforeAll(async () => {
  db = await createTestDb();
  const [o] = await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`;
  org = o!.id;
  const [r] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`;
  repo = r!.id;
});
afterAll(async () => { await db.drop(); });

async function job(state = "QUEUED", priority = "normal"): Promise<string> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id, priority) VALUES (${req!.id}, ${repo}, ${priority}) RETURNING id`;
  if (state !== "QUEUED") await db.sql`ALTER TABLE jobs DISABLE TRIGGER jobs_enforce_transition`.then(() => db.sql`UPDATE jobs SET state=${state} WHERE id=${j!.id}`).then(() => db.sql`ALTER TABLE jobs ENABLE TRIGGER jobs_enforce_transition`);
  return j!.id;
}
const worker = () => registerWorker(db.sql, { organizationId: org, mode: "local" });
const T0 = new Date(Date.now() + 5_000); // tasks become runnable at enqueue time
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("claims", () => {
  test("concurrent claims: each task leased at most once, tokens unique and monotonic", async () => {
    const j = await job();
    for (let i = 0; i < 5; i++) await enqueueTask(db.sql, { jobId: j, stage: `s${i}`, role: "analyst" });
    const workers = await Promise.all(Array.from({ length: 20 }, worker));
    const results = await Promise.all(workers.map((w) => claimTask(db.sql, { workerId: w, now: T0 })));
    const leases = results.filter((r) => r !== null);
    expect(leases.length).toBe(5);
    expect(new Set(leases.map((l) => l!.taskId)).size).toBe(5);
    const tokens = leases.map((l) => l!.leaseToken);
    expect(new Set(tokens).size).toBe(5);
    expect(db.sql`SELECT count(*)::int AS c FROM tasks WHERE job_id=${j} AND status='leased'`).resolves.toEqual([{ c: 5 }] as never);
  });
  test("enqueue is idempotent", async () => {
    const j = await job();
    const a = await enqueueTask(db.sql, { jobId: j, stage: "x", role: "r" });
    expect(await enqueueTask(db.sql, { jobId: j, stage: "x", role: "r" })).toBe(a);
  });
  test("worker capacity (1) and builder-per-job exclusivity", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "a", role: "analyst" });
    await enqueueTask(db.sql, { jobId: j, stage: "b", role: "analyst" });
    const w = await worker();
    expect(await claimTask(db.sql, { workerId: w, now: T0 })).not.toBeNull();
    expect(await claimTask(db.sql, { workerId: w, now: T0 })).toBeNull(); // at capacity
    const j2 = await job();
    await enqueueTask(db.sql, { jobId: j2, stage: "build1", role: "builder" });
    await enqueueTask(db.sql, { jobId: j2, stage: "build2", role: "builder" });
    const w1 = await worker(); const w2 = await worker();
    const l1 = await claimTask(db.sql, { workerId: w1, roles: ["builder"], now: T0 });
    const l2 = await claimTask(db.sql, { workerId: w2, roles: ["builder"], now: T0 });
    expect(l1).not.toBeNull();
    expect(l2).toBeNull();
  });
  test("paused, terminal-state, and non-active-worker claims are refused; priority respected", async () => {
    const paused = await job();
    await db.sql`UPDATE jobs SET paused_at=now(), pause_reason='op' WHERE id=${paused}`;
    await enqueueTask(db.sql, { jobId: paused, stage: "p", role: "pr" });
    const cancelled = await job("CANCELLED");
    await enqueueTask(db.sql, { jobId: cancelled, stage: "c", role: "pr" });
    const w = await worker();
    expect(await claimTask(db.sql, { workerId: w, roles: ["pr"], now: T0 })).toBeNull();
    const low = await job("QUEUED", "low"); const high = await job("QUEUED", "high");
    await enqueueTask(db.sql, { jobId: low, stage: "q", role: "prio" });
    await enqueueTask(db.sql, { jobId: high, stage: "q", role: "prio" });
    const got = await claimTask(db.sql, { workerId: w, roles: ["prio"], now: T0 });
    expect(got?.jobId).toBe(high);
    for (const status of ["draining", "quarantined", "lost"] as const) {
      const bad = await worker();
      await setWorkerStatus(db.sql, bad, status);
      expect(await claimTask(db.sql, { workerId: bad, roles: ["prio"], now: T0 })).toBeNull();
    }
  });
});

describe("leases and fencing", () => {
  test("heartbeat extends the lease; stale worker cannot overwrite the next attempt", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "build", role: "tb" });
    const w1 = await worker(); const w2 = await worker();
    const l1 = (await claimTask(db.sql, { workerId: w1, roles: ["tb"], now: T0 }))!;
    const ext = await heartbeatTask(db.sql, { taskId: l1.taskId, workerId: w1, leaseToken: l1.leaseToken, now: at(10_000) });
    expect(ext.getTime()).toBe(at(10_000 + LEASE_TTL_MS).getTime());
    // w1 goes silent; lease expires; w2 claims attempt 2 with a larger token
    const later = at(10_000 + LEASE_TTL_MS + 5_000);
    expect(await expireLeases(db.sql, { now: later })).toBeGreaterThanOrEqual(1);
    const retryAt = at(10_000 + LEASE_TTL_MS + 5_000 + 10_000);
    const l2 = (await claimTask(db.sql, { workerId: w2, roles: ["tb"], now: retryAt }))!;
    expect(l2.taskId).toBe(l1.taskId);
    expect(l2.attempt).toBe(2);
    expect(l2.leaseToken).toBeGreaterThan(l1.leaseToken);
    // stale w1 is rejected on every channel
    const stale = { taskId: l1.taskId, workerId: w1, leaseToken: l1.leaseToken, now: retryAt };
    await expect(heartbeatTask(db.sql, stale)).rejects.toBeInstanceOf(StaleLeaseError);
    await expect(reportTaskEvent(db.sql, { ...stale, type: "agent.progress" })).rejects.toBeInstanceOf(StaleLeaseError);
    await expect(completeTask(db.sql, { ...stale, outcome: "succeeded" })).rejects.toBeInstanceOf(StaleLeaseError);
    // w1 impersonating w2's token is rejected too; wrong worker with right token as well
    await expect(completeTask(db.sql, { taskId: l1.taskId, workerId: w1, leaseToken: l2.leaseToken, outcome: "succeeded", now: retryAt })).rejects.toThrow(/another worker/);
    // task state untouched by stale attempts; rejections audited; no stale events visible
    expect((await db.sql`SELECT status, attempt FROM tasks WHERE id=${l1.taskId}`)[0]).toMatchObject({ status: "leased", attempt: 2 });
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE action='fencing.rejected' AND resource=${"task:" + l1.taskId}`)[0]!.c).toBe(4);
    const evs = await readEvents(db.sql, j);
    expect(evs.some((e) => e.type === "agent.progress")).toBe(false);
    // the current holder completes normally
    await completeTask(db.sql, { taskId: l2.taskId, workerId: w2, leaseToken: l2.leaseToken, outcome: "succeeded", now: retryAt });
    expect((await db.sql`SELECT status FROM tasks WHERE id=${l1.taskId}`)[0]!.status).toBe("succeeded");
    const mono = (await readEvents(db.sql, j)).map((e) => e.sequence);
    expect(mono).toEqual([...mono].sort((a, b) => a - b));
  });
  test("an expired lease is rejected even before anyone reclaims it", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "x", role: "te" });
    const w = await worker();
    const l = (await claimTask(db.sql, { workerId: w, roles: ["te"], now: T0 }))!;
    await expect(heartbeatTask(db.sql, { taskId: l.taskId, workerId: w, leaseToken: l.leaseToken, now: at(LEASE_TTL_MS + 1) })).rejects.toThrow(/expired/);
    await expect(heartbeatTask(db.sql, { taskId: l.taskId, workerId: w, leaseToken: l.leaseToken, now: at(LEASE_TTL_MS - 1) })).resolves.toBeInstanceOf(Date);
  });
  test("expiry detected within one TTL (<90s SLO) via the next claim; retry budget exhausted -> failed, never silently retried forever", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "x", role: "tbudget" });
    const w = await worker();
    let now = T0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const l = await claimTask(db.sql, { workerId: w, roles: ["tbudget"], now });
      expect(l?.attempt).toBe(attempt);
      now = new Date(now.getTime() + LEASE_TTL_MS + 1_000); // worker dies; < 90s later the next poll recovers it
      expect(LEASE_TTL_MS + 1_000).toBeLessThan(90_000);
      await expireLeases(db.sql, { now });
      now = new Date(now.getTime() + 60_000); // past backoff
    }
    expect(await claimTask(db.sql, { workerId: w, roles: ["tbudget"], now })).toBeNull();
    expect((await db.sql`SELECT status FROM tasks WHERE job_id=${j}`)[0]!.status).toBe("failed");
    const types = (await readEvents(db.sql, j)).filter((e) => e.type === "task.expired").map((e) => e.payload.outcome);
    expect(types).toEqual(["requeued", "requeued", "failed_budget_exhausted"]);
  });
  test("cancellation revokes leases: worker fenced out, no new claims", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "x", role: "tcancel" });
    await enqueueTask(db.sql, { jobId: j, stage: "y", role: "tcancel" });
    const w = await worker();
    const l = (await claimTask(db.sql, { workerId: w, roles: ["tcancel"], now: T0 }))!;
    expect(await revokeJobLeases(db.sql, j, "cancelled by operator", T0)).toBe(2);
    expect(await revokeJobLeases(db.sql, j, "again", T0)).toBe(0); // idempotent
    await expect(heartbeatTask(db.sql, { taskId: l.taskId, workerId: w, leaseToken: l.leaseToken, now: T0 })).rejects.toThrow(/cancelled/);
    expect(await claimTask(db.sql, { workerId: await worker(), roles: ["tcancel"], now: T0 })).toBeNull();
  });
  test("event writes use the lease's fencing token and attempt", async () => {
    const j = await job();
    await enqueueTask(db.sql, { jobId: j, stage: "x", role: "tev" });
    const w = await worker();
    const l = (await claimTask(db.sql, { workerId: w, roles: ["tev"], now: T0 }))!;
    await reportTaskEvent(db.sql, { taskId: l.taskId, workerId: w, leaseToken: l.leaseToken, type: "agent.progress", payload: { message: "hi" }, now: T0 });
    const e = (await readEvents(db.sql, j)).find((x) => x.type === "agent.progress")!;
    expect(e.fencingToken).toBe(l.leaseToken);
    expect(e.attempt).toBe(1);
  });
});
