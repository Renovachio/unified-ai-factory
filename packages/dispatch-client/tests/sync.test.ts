import { describe, expect, test } from "bun:test";
import { ApiError, DispatchClient, OutcomeUnknown, SseParser, StaleRevision, SyncEngine, type FeedEvent, type JobView, type Snapshot, type SyncTransport } from "../src/index";

const job = (id: string, rev = 1, state = "QUEUED"): JobView => ({ id, projectId: "p", project: "o/r", state, revision: rev, risk: "LOW", prNumber: null, title: { text: "t", trust: "untrusted" }, paused: false, updatedAt: "2026-01-01T00:00:00Z" });
const snap = (cursor: number, jobs: JobView[]): Snapshot => ({ cursor, generatedAt: "", jobs, summary: { jobs: { inFlight: jobs.length, waitingOnHuman: 0, total: jobs.length }, approvals: { pending: 0, jobDecisions: 0, capabilityApprovals: 0 }, projects: 1, workers: { active: 0 } } });
let ev = 0; const E = (jobId: string, sequence: number, globalSeq: number, id = `e${++ev}`): FeedEvent => ({ eventId: id, globalSeq, jobId, sequence, type: "job.transitioned", at: "", payload: {} });

class Fake implements SyncTransport {
  snaps: Snapshot[] = []; jobs = new Map<string, { id: string; state: string; version: number }>(); streams: Array<(cursor: number) => AsyncIterable<FeedEvent> | Error> = []; cursors: number[] = []; snapshotCalls = 0; jobCalls: string[] = [];
  async snapshot() { this.snapshotCalls++; return this.snaps[Math.min(this.snapshotCalls - 1, this.snaps.length - 1)] as Snapshot; }
  stream(cursor: number, signal?: AbortSignal): AsyncIterable<FeedEvent> { this.cursors.push(cursor); const s = this.streams.shift(); if (!s) return (async function* (): AsyncGenerator<FeedEvent> { await new Promise<void>((res) => { if (signal?.aborted) res(); signal?.addEventListener("abort", () => res(), { once: true }); }); yield* []; })(); const r = s(cursor); if (r instanceof Error) throw r; return r; }
  async job(id: string) { this.jobCalls.push(id); const j = this.jobs.get(id); if (!j) throw new Error("no job"); return j; }
}
async function* of(...es: FeedEvent[]) { for (const e of es) yield e; }
const until = async (f: () => boolean, ms = 2000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout waiting for condition"); await new Promise((r) => setTimeout(r, 5)); } };

describe("SyncEngine: events are hints, snapshots are truth (DSP-05)", () => {
  test("duplicates are ignored; state comes from the authoritative job read, not from the event payload", async () => {
    const t = new Fake(); t.snaps = [snap(10, [job("a", 1)])]; t.jobs.set("a", { id: "a", state: "BUILDING", version: 2 });
    const e1 = E("a", 1, 11, "same"); const eng = new SyncEngine(t);
    await eng.reconcile(); expect(await eng.apply(e1)).toBe(true); expect(await eng.apply({ ...e1 })).toBe(false); expect(t.jobCalls).toEqual(["a"]);
    expect(eng.state.jobs.get("a")).toMatchObject({ state: "BUILDING", revision: 2 }); expect(eng.state.cursor).toBe(11);
  });
  test("an older job read can never overwrite a newer revision", async () => {
    const t = new Fake(); t.snaps = [snap(1, [job("a", 5, "GATING")])]; t.jobs.set("a", { id: "a", state: "QUEUED", version: 2 });
    const eng = new SyncEngine(t); await eng.reconcile(); await eng.apply(E("a", 1, 2)); expect(eng.state.jobs.get("a")).toMatchObject({ state: "GATING", revision: 5 });
  });
  test("reordered or missing per-job sequences are detected as a gap and repaired by a fresh snapshot; old sequences are ignored", async () => {
    const t = new Fake(); t.snaps = [snap(5, [job("a", 1)]), snap(9, [job("a", 4, "REVIEWING")])]; t.jobs.set("a", { id: "a", state: "BUILDING", version: 2 });
    const eng = new SyncEngine(t); await eng.reconcile(); await eng.apply(E("a", 1, 6)); expect(eng.state.reconciliations).toBe(1);
    await eng.apply(E("a", 4, 9)); // seq 2,3 never arrived
    expect(eng.state.reconciliations).toBe(2); expect(eng.state.jobs.get("a")).toMatchObject({ state: "REVIEWING", revision: 4 });
    await eng.apply(E("a", 2, 7)); expect(eng.state.jobs.get("a")).toMatchObject({ state: "REVIEWING", revision: 4 }); // a late event can never roll the view back
  });
  test("a job the snapshot has never seen (created elsewhere) triggers reconciliation rather than being invented", async () => {
    const t = new Fake(); t.snaps = [snap(1, []), snap(2, [job("new", 1)])]; t.jobs.set("new", { id: "new", state: "QUEUED", version: 1 });
    const eng = new SyncEngine(t); await eng.reconcile(); await eng.apply(E("new", 1, 2)); expect(eng.state.jobs.get("new")).toBeDefined(); expect(eng.state.reconciliations).toBe(2);
  });
  test("reconnect resumes from the last cursor with capped, jittered exponential backoff and re-syncs from a snapshot first", async () => {
    const t = new Fake(); t.snaps = [snap(10, [job("a", 1)]), snap(20, [job("a", 3)])]; t.jobs.set("a", { id: "a", state: "BUILDING", version: 2 });
    t.streams = [() => of(E("a", 1, 15)), () => new Error("connection reset"), () => new Error("connection reset"), () => of(E("a", 2, 21))];
    const delays: number[] = []; const eng = new SyncEngine(t, { baseMs: 100, maxMs: 250, random: () => 1, sleep: async (ms) => { delays.push(ms); } });
    eng.start(); await until(() => t.cursors.length >= 4); await eng.stop();
    expect(t.cursors[0]).toBe(10); expect(t.cursors.slice(1).every((c) => c >= 15)).toBe(true); // never restarts from 0 or from before what it already applied
    expect(delays.length).toBeGreaterThanOrEqual(3); expect(Math.max(...delays)).toBeLessThanOrEqual(250); expect(delays[1]!).toBeGreaterThanOrEqual(delays[0]!);
    expect(eng.state.reconnects).toBeGreaterThanOrEqual(3); expect(eng.state.status).toBe("stopped");
  });
  test("an authentication failure stops the engine (no retry storm) and says so", async () => {
    const t = new Fake(); t.snaps = [snap(1, [])]; t.streams = [() => { throw new ApiError(401, "Unauthorized"); }];
    const eng = new SyncEngine(t, { sleep: async () => undefined }); eng.start(); await until(() => eng.state.status === "auth-failed"); expect(t.cursors).toHaveLength(1); expect(eng.state.lastError).toMatch(/401/); await eng.stop();
  });
  test("the dedupe memory is bounded", async () => {
    const t = new Fake(); t.snaps = [snap(0, [job("a", 1)])]; t.jobs.set("a", { id: "a", state: "BUILDING", version: 2 });
    const eng = new SyncEngine(t, { maxSeen: 50 }); await eng.reconcile(); for (let i = 1; i <= 200; i++) await eng.apply(E("a", i, i));
    expect((eng as unknown as { seen: Set<string> }).seen.size).toBeLessThanOrEqual(50);
  });
});

describe("SSE parsing", () => {
  test("handles partial chunks, CRLF, comments, multi-line data and unknown fields", () => {
    const p = new SseParser(); const out = [...p.push("id: 5\nevent: x\nda"), ...p.push("ta: {\"a\":\n"), ...p.push("data: 1}\r\n\r\n: keep-alive\n\nretry: 10\ndata: z\n\n")];
    expect(out).toEqual([{ id: "5", event: "x", data: '{"a":\n1}' }, { data: "z" }]);
  });
});

describe("mutations: idempotency and unknown outcomes", () => {
  const mk = (handler: (req: Request) => Response | Promise<Response>) => { const seen: Request[] = []; const c = new DispatchClient({ baseUrl: "http://x", headers: () => ({ authorization: "Bearer t" }), newKey: () => "key-" + (seen.length + 1) + "-fixed-0000000000", fetch: (async (u: string | URL | Request, i?: RequestInit) => { const r = new Request(u as string, i); seen.push(r); return handler(r); }) as unknown as typeof fetch }); return { c, seen }; };
  test("a timeout/connection loss yields OutcomeUnknown; retry reuses the SAME key and succeeds once", async () => {
    let n = 0; const { c, seen } = mk(() => { if (++n === 1) throw new TypeError("network down"); return Response.json({ id: "j1" }, { status: 201 }); });
    const m = c.mutation("POST", "/api/v1/jobs", { a: 1 }); const err = await c.send(m).catch((e) => e); expect(err).toBeInstanceOf(OutcomeUnknown); expect((err as OutcomeUnknown).mutation).toBe(m);
    expect(await c.retry(m)).toEqual({ id: "j1" }); expect(seen).toHaveLength(2); expect(seen[0]!.headers.get("idempotency-key")).toBe(seen[1]!.headers.get("idempotency-key")); expect(m.attempts).toBe(2);
  });
  test("5xx is an unknown outcome; 4xx is definitive; a stale revision is a distinct error; expectedRevision travels with the request", async () => {
    const { c, seen } = mk((r) => (r.url.endsWith("/boom") ? new Response("x", { status: 503 }) : r.url.endsWith("/bad") ? Response.json({ title: "Unprocessable", detail: "nope" }, { status: 422 }) : Response.json({ type: "https://f/problems/stale-version", title: "Conflict", detail: "version conflict: expected 3, found 4" }, { status: 409 })));
    expect(await c.send(c.mutation("POST", "/boom")).catch((e) => e)).toBeInstanceOf(OutcomeUnknown);
    expect(await c.send(c.mutation("POST", "/bad")).catch((e) => e)).toMatchObject({ status: 422, detail: "nope" });
    const st = await c.send(c.mutation("POST", "/api/v1/jobs/1/cancel", { reason: "x" }, { expectedRevision: 3 })).catch((e) => e); expect(st).toBeInstanceOf(StaleRevision);
    expect(JSON.parse(await seen[2]!.text())).toEqual({ reason: "x", expectedRevision: 3 });
  });
  test("every mutation carries an idempotency key and the caller's auth, even when a different request is built", async () => {
    const { c, seen } = mk(() => Response.json({}, { status: 200 })); await c.send(c.mutation("POST", "/a")); await c.send(c.mutation("POST", "/b"));
    expect(seen.map((r) => r.headers.get("idempotency-key"))).toEqual(["key-1-fixed-0000000000", "key-2-fixed-0000000000"]); expect(seen.every((r) => r.headers.get("authorization") === "Bearer t")).toBe(true);
  });
});
