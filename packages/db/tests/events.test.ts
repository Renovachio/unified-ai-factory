import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { validateEvent } from "@factory/contracts";
import { appendEvent, ConflictError, DedupingConsumer, deliverOutbox, eventStream, readEvents, toEnvelope, transitionJob, type Sql } from "../src/index";
import { createTestDb } from "../src/testing";

let db: Awaited<ReturnType<typeof createTestDb>>;
let repoId: string;
let n = 0;
beforeAll(async () => {
  db = await createTestDb();
  const [org] = await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`;
  const [repo] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org!.id}, 'github', 'r', 'o', 'n') RETURNING id`;
  repoId = repo!.id;
});
afterAll(async () => { await db.drop(); });

async function job(): Promise<string> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description)
    VALUES (${repoId}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repoId}) RETURNING id`;
  return j!.id;
}
const add = (jobId: string, i: number, sql: Sql = db.sql) => sql.begin((tx) => appendEvent(tx, { jobId, type: "agent.progress", source: "t", payload: { i } }));
async function collect(it: AsyncGenerator<string>, count: number): Promise<number[]> {
  const ids: number[] = [];
  for await (const chunk of it) {
    const m = /^id: (\d+)/m.exec(chunk);
    if (m) ids.push(Number(m[1]));
    if (ids.length >= count) break;
  }
  return ids;
}

describe("event log", () => {
  test("20 concurrent appends yield contiguous, unique, monotonic sequences", async () => {
    const id = await job();
    await Promise.all(Array.from({ length: 20 }, (_, i) => add(id, i)));
    const evs = await readEvents(db.sql, id, 0, 100);
    expect(evs.map((e) => e.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
  test("rolled-back transaction leaves no event, no outbox row and no sequence hole", async () => {
    const id = await job();
    await add(id, 1);
    await expect(db.sql.begin(async (tx) => { await appendEvent(tx, { jobId: id, type: "x", source: "t" }); throw new Error("boom"); })).rejects.toThrow("boom");
    await add(id, 2);
    expect((await readEvents(db.sql, id)).map((e) => e.sequence)).toEqual([1, 2]);
    expect((await db.sql`SELECT count(*)::int AS c FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.job_id=${id}`)[0]!.c).toBe(2);
  });
  test("payloads are redacted before persistence; envelope matches CONTRACTS/event.schema.json", async () => {
    const id = await job();
    const e = await db.sql.begin((tx) => appendEvent(tx, { jobId: id, type: "agent.progress", source: "t", payload: { message: "using sk-abcdefghijklmnop1234", api_key: "zzz", ok: true } }));
    expect(JSON.stringify(e.payload)).not.toContain("sk-abcdefghijklmnop1234");
    expect(e.payload.api_key).toBe("[REDACTED]");
    const env = validateEvent(toEnvelope(e));
    expect(env.errors).toEqual([]);
    expect(env.ok).toBe(true);
    expect(validateEvent({ ...toEnvelope(e), sequence: 0 }).ok).toBe(false);
  });
  test("transitionJob is atomic: state, history, event, outbox and audit; conflicts and illegal moves rejected", async () => {
    const id = await job();
    const r = await transitionJob(db.sql, { jobId: id, expectedVersion: 1, next: "INTAKE", actor: "system", evidence: { a: 1 } });
    expect(r.version).toBe(2);
    expect((await db.sql`SELECT state FROM jobs WHERE id=${id}`)[0]!.state).toBe("INTAKE");
    expect((await db.sql`SELECT count(*)::int AS c FROM job_transitions WHERE job_id=${id}`)[0]!.c).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE resource=${"job:" + id}`)[0]!.c).toBe(1);
    await expect(transitionJob(db.sql, { jobId: id, expectedVersion: 1, next: "SPECIFYING", actor: "x" })).rejects.toBeInstanceOf(ConflictError);
    await expect(transitionJob(db.sql, { jobId: id, expectedVersion: 2, next: "MERGING", actor: "x" })).rejects.toThrow(/illegal transition/);
    await expect(transitionJob(db.sql, { jobId: id, expectedVersion: 2, next: "SPECIFYING", actor: "x", guard: () => { throw new Error("guard says no"); } })).rejects.toThrow("guard says no");
    expect((await db.sql`SELECT state, version FROM jobs WHERE id=${id}`)[0]).toMatchObject({ state: "INTAKE", version: 2 });
    expect((await readEvents(db.sql, id)).length).toBe(1);
  });
  test("concurrent transitions with the same expected version: exactly one wins", async () => {
    const id = await job();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => transitionJob(db.sql, { jobId: id, expectedVersion: 1, next: "INTAKE", actor: "w" })));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((await readEvents(db.sql, id)).length).toBe(1);
  });
});

describe("outbox", () => {
  const addTo = (jobId: string, i: number, dest: string) =>
    db.sql.begin((tx) => appendEvent(tx, { jobId, type: "agent.progress", source: "t", payload: { i }, destinations: [dest] }));

  test("consumer crash mid-batch (handler error): acked prefix kept, rest retried in order, effects dedupe to exactly-once", async () => {
    const id = await job();
    const dest = "d-crash";
    for (let i = 1; i <= 6; i++) await addTo(id, i, dest);
    const consumer = new DedupingConsumer(async () => undefined);
    let handled = 0;
    const r1 = await deliverOutbox(db.sql, { destination: dest, handler: async (item) => { await consumer.receive(item); if (++handled === 3) throw new Error("crash after effect, before ack"); } });
    expect(r1).toEqual({ delivered: 2, failed: 1 });
    expect(consumer.seen.map((s) => s.sequence)).toEqual([1, 2, 3]); // effect of #3 happened but was not acked
    const pending = async () => (await db.sql`SELECT count(*)::int AS c FROM outbox WHERE destination=${dest} AND status='pending'`)[0]!.c;
    expect(await pending()).toBe(4);
    // retry is delayed by backoff
    expect(await deliverOutbox(db.sql, { destination: dest, handler: async () => undefined })).toEqual({ delivered: 0, failed: 0 });
    const later = new Date(Date.now() + 10 * 60_000);
    const r2 = await deliverOutbox(db.sql, { destination: dest, now: later, handler: (item) => consumer.receive(item).then(() => undefined) });
    expect(r2.delivered).toBe(4);
    expect(consumer.seen.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5, 6]); // #3 redelivered but deduped
    expect(await pending()).toBe(0);
  });
  test("process death mid-batch (transaction aborted) leaves all rows pending for redelivery", async () => {
    const id = await job();
    const dest = "d-kill";
    for (let i = 1; i <= 3; i++) await addTo(id, i, dest);
    await db.sql.begin(async (tx) => {
      await tx`UPDATE outbox SET status='delivered' WHERE destination=${dest}`;
      throw new Error("kill -9");
    }).catch(() => undefined);
    const got: number[] = [];
    await deliverOutbox(db.sql, { destination: dest, handler: async (i) => { got.push(i.sequence); } });
    expect(got).toEqual([1, 2, 3]);
  });
  test("duplicate dedupe key does not create a second outbox row", async () => {
    const id = await job();
    await db.sql.begin(async (tx) => {
      await appendEvent(tx, { jobId: id, type: "a", source: "t", dedupeKey: "same", destinations: ["d-dup"] });
      await appendEvent(tx, { jobId: id, type: "b", source: "t", dedupeKey: "same", destinations: ["d-dup"] });
    });
    expect((await db.sql`SELECT count(*)::int AS c FROM outbox WHERE destination='d-dup'`)[0]!.c).toBe(1);
  });
  test("concurrent consumers never double-claim a row", async () => {
    const id = await job();
    const dest = "d-conc";
    for (let i = 1; i <= 8; i++) await addTo(id, i, dest);
    const seen: number[] = [];
    await Promise.all(Array.from({ length: 4 }, () => deliverOutbox(db.sql, { destination: dest, handler: async (it) => { await new Promise((r) => setTimeout(r, 5)); seen.push(it.sequence); } })));
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("SSE", () => {
  test("replays in order from the beginning, then tails new events", async () => {
    const id = await job();
    for (let i = 1; i <= 3; i++) await add(id, i);
    const ac = new AbortController();
    const p = collect(eventStream(db.sql, { jobId: id, signal: ac.signal, pollMs: 20 }), 5);
    await new Promise((r) => setTimeout(r, 60));
    await add(id, 4);
    await add(id, 5);
    expect(await p).toEqual([1, 2, 3, 4, 5]);
    ac.abort();
  });
  test("kill the consumer, resume from Last-Event-ID: no holes, no duplicates, monotonic", async () => {
    const id = await job();
    for (let i = 1; i <= 10; i++) await add(id, i);
    const a = await collect(eventStream(db.sql, { jobId: id, pollMs: 10 }), 4); // consumer dies after 4
    expect(a).toEqual([1, 2, 3, 4]);
    for (let i = 11; i <= 14; i++) await add(id, i); // events keep arriving while disconnected
    const b = await collect(eventStream(db.sql, { jobId: id, lastEventId: a.at(-1) as number, pollMs: 10 }), 10);
    expect([...a, ...b]).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });
  test("streams are scoped to one job; bad cursor falls back to 0; abort stops the stream", async () => {
    const a = await job(); const b = await job();
    await add(a, 1); await add(b, 1); await add(b, 2);
    const ids = await collect(eventStream(db.sql, { jobId: a, lastEventId: "garbage", pollMs: 10 }), 1);
    expect(ids).toEqual([1]);
    const ac = new AbortController();
    const chunks: string[] = [];
    const run = (async () => { for await (const c of eventStream(db.sql, { jobId: a, lastEventId: 1, signal: ac.signal, pollMs: 10, heartbeatMs: 20 })) chunks.push(c); })();
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await run;
    expect(chunks.every((c) => c.startsWith(": keep-alive"))).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
