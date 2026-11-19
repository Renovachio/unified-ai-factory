import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendEvent, deliverOutbox, diagnosticsBundle, listDeadLetters, requeueDeadLetter, type OutboxItem } from "../src/index";
import { createTestDb } from "../src/testing";

let db: Awaited<ReturnType<typeof createTestDb>>; let repoId = ""; let n = 0;
beforeAll(async () => {
  db = await createTestDb();
  const [org] = await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`;
  repoId = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org!.id}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id;
});
afterAll(async () => { await db.drop(); });
async function job(): Promise<string> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repoId}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  return (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repoId}) RETURNING id`)[0]!.id;
}
const emit = (jobId: string, i: number, dest: string) => db.sql.begin((tx) => appendEvent(tx, { jobId, type: "agent.progress", source: "t", payload: { i }, destinations: [dest] }));
const FAR = new Date("2099-01-01");

describe("outbox dead letter (ACT-07)", () => {
  test("a poisoned row retries with backoff, then dead-letters with its last error instead of retrying forever", async () => {
    const j = await job(); await emit(j, 1, "dl1");
    const poison = async () => { throw new Error("boom: downstream rejects this payload"); };
    let t = new Date("2026-01-01T00:00:00Z");
    for (let i = 1; i <= 2; i++) { const r = await deliverOutbox(db.sql, { destination: "dl1", handler: poison, maxAttempts: 3, now: t }); expect(r).toMatchObject({ failed: 1, deadLettered: 0 }); t = new Date(t.getTime() + 3600_000); }
    const last = await deliverOutbox(db.sql, { destination: "dl1", handler: poison, maxAttempts: 3, now: t });
    expect(last).toMatchObject({ failed: 1, deadLettered: 1 });
    expect(await deliverOutbox(db.sql, { destination: "dl1", handler: poison, maxAttempts: 3, now: FAR })).toEqual({ delivered: 0, failed: 0, deadLettered: 0 }); // no more retries
    const dead = await listDeadLetters(db.sql);
    expect(dead).toHaveLength(1); expect(dead[0]).toMatchObject({ jobId: j, attempts: 3, destination: "dl1" }); expect(dead[0]!.lastError).toMatch(/boom/);
  });
  test("an operator can requeue after fixing the cause and delivery resumes; requeue of a non-dead row is refused", async () => {
    const [d] = await listDeadLetters(db.sql); const seen: OutboxItem[] = [];
    expect(await requeueDeadLetter(db.sql, d!.outboxId)).toBe(true);
    expect(await requeueDeadLetter(db.sql, d!.outboxId)).toBe(false);
    const r = await deliverOutbox(db.sql, { destination: "dl1", handler: async (i) => { seen.push(i); }, now: FAR });
    expect(r.delivered).toBe(1); expect(seen).toHaveLength(1); expect(await listDeadLetters(db.sql)).toHaveLength(0);
  });
  test("a dead-lettered head blocks its job in that call only; other jobs are unaffected", async () => {
    const a = await job(); const b = await job(); await emit(a, 1, "dl2"); await emit(a, 2, "dl2"); await emit(b, 1, "dl2");
    const seen: string[] = [];
    const r = await deliverOutbox(db.sql, { destination: "dl2", maxAttempts: 1, now: FAR, handler: async (i) => { if (i.jobId === a && i.sequence === 1) throw new Error("bad"); seen.push(`${i.jobId}:${i.sequence}`); } });
    expect(r).toMatchObject({ delivered: 1, deadLettered: 1 }); expect(seen).toEqual([`${b}:1`]);
  });
});

describe("crash mid-delivery (restart fault injection, single process)", () => {
  test("killing the consumer's database connection mid-batch leaves every row pending; redelivery completes with no loss", async () => {
    const j = await job(); for (let i = 1; i <= 3; i++) await emit(j, i, "crash1");
    const pid = { v: 0 }; const delivered: number[] = [];
    await expect(deliverOutbox(db.sql, { destination: "crash1", now: FAR, handler: async (i) => {
      if (i.sequence === 2) { // terminate our own transaction's backend, as a DB restart or network cut would
        const [row] = await db.sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' LIMIT 1`; pid.v = Number(row?.pid);
        await db.sql`SELECT pg_terminate_backend(${pid.v})`; throw new Error("connection lost");
      }
      delivered.push(i.sequence);
    } })).rejects.toThrow();
    expect(pid.v).toBeGreaterThan(0);
    const states = await db.sql`SELECT status FROM outbox WHERE destination = 'crash1'`; expect(states.every((s) => s.status === "pending")).toBe(true);
    const again: number[] = [];
    await deliverOutbox(db.sql, { destination: "crash1", now: FAR, handler: async (i) => { again.push(i.sequence); } });
    expect(again).toEqual([1, 2, 3]); // at-least-once: seq 1 was redelivered (consumers dedupe by sequence)
  });
});

describe("diagnostics bundle", () => {
  test("reports migrations, counts and alerts, and contains no request text or payloads", async () => {
    const j = await job(); await emit(j, 1, "dg"); await db.sql`UPDATE outbox SET status = 'failed', dead_at = now(), last_error = 'x' WHERE destination = 'dg'`;
    const b = await diagnosticsBundle(db.sql);
    expect(b.migrations.pending).toEqual([]); expect(b.migrations.applied).toContain("0013");
    expect(b.outbox.deadLettered).toBeGreaterThanOrEqual(1); expect(b.alerts.join(" ")).toMatch(/dead-lettered/);
    expect(b.jobsByState.QUEUED).toBeGreaterThan(0);
    const text = JSON.stringify(b); expect(text).not.toContain("title"); expect(text).not.toContain("description");
  });
});
