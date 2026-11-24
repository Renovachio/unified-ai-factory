import { describe, expect, test } from "bun:test";
import { createApi, ROLES, PERMISSIONS } from "@factory/api";
import { enrollWorker } from "@factory/runner";
import { claimTask, enqueueTask, expireLeases, heartbeatTask, StaleLeaseError } from "@factory/scheduler";
import { createLogger } from "@factory/telemetry";
import { approve, db, fake, org, prepare, registerHooks, tickUntil, U, cfg } from "./merge-fixture";

registerHooks();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TR = Omit<Response, "json"> & { json(): Promise<any> };
const BILLING = /usd|dollar|price|pricing|cost|invoice|billed|spend|credit/i;
const keysOf = (v: unknown, out: string[] = []): string[] => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };

let api: (r: Request) => Promise<Response>;
const logs: string[] = [];
let ready = false;
async function setup() {
  if (ready) return;
  for (const role of ROLES) await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${"o-" + role}, ${role}) ON CONFLICT DO NOTHING`;
  const other = (await db.sql`INSERT INTO organizations (name) VALUES ('other') RETURNING id`)[0]!.id;
  await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${other}, 'x-admin', 'admin')`;
  api = createApi({
    sql: db.sql, review: { requiredRoles: async () => ["code"] }, log: (l) => logs.push(JSON.stringify(l)),
    authenticator: { authenticate: async (r) => { const s = r.headers.get("x-test-subject"); return s ? { subject: s, via: "bearer" as const } : null; } },
  });
  ready = true;
}
const call = async (method: string, path: string, who: string, body?: unknown): Promise<TR> => {
  await setup();
  return api(new Request(`http://api.test/api/v1${path}`, { method, headers: { "x-test-subject": who, ...(body !== undefined ? { "content-type": "application/json", "idempotency-key": crypto.randomUUID() } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
};

describe("full job timeline", () => {
  test("the ENTIRE history of a merged job is reconstructible, ordered, paged, redacted and free of price metrics", async () => {
    await setup();
    const p = await prepare();
    await approve(p, "approver1");
    await tickUntil(p, (t) => t.state === "MERGED");
    await p.env.coordinator().recordPostmerge(p.jobId, { ok: true, detail: "main CI green" });
    // a hostile/accidental raw secret written straight into evidence tables must still never leave the API
    await db.sql`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest) VALUES (${org}, 'u', 'note', ${"job:" + p.jobId}, 'ok', 'token ghp_abcdefghijklmnopqrstuvwxyz0123 Bearer abcdefgh12345678', 'd')`;

    const full = await (await call("GET", `/jobs/${p.jobId}/timeline?limit=2000`, "o-viewer")).json();
    const e = full.entries as Array<{ source: string; id: string; ts: string; kind: string; data: Record<string, unknown> }>;
    expect(full.statePath).toEqual(["INTAKE", "SPECIFYING", "READY", "PROVISIONING", "BUILDING", "GATING", "REVIEWING", "PREMERGE", "AWAITING_HUMAN", "PREMERGE", "MERGING", "MERGED", "POSTMERGE_MONITOR", "DONE"]);
    const dbTransitions = (await db.sql`SELECT to_state FROM job_transitions WHERE job_id=${p.jobId} ORDER BY version`).map((r) => r.to_state);
    expect(full.statePath).toEqual(dbTransitions);
    // every source table is represented, with exactly the DB row counts
    const count = async (t: string, col = "job_id") => (await db.sql.unsafe(`SELECT count(*)::int AS c FROM ${t} WHERE ${col}='${p.jobId}'`))[0]!.c as number;
    const by = (s: string) => e.filter((x) => x.source === s).length;
    expect(new Set(e.map((x) => x.source))).toEqual(new Set(["transition", "event", "task", "agent_run", "artifact", "candidate", "gate", "review", "policy", "approval", "pull_request", "merge", "audit"]));
    expect(by("transition")).toBe(await count("job_transitions"));
    expect(by("event")).toBe(await count("events"));
    expect(by("task")).toBe(await count("tasks"));
    expect(by("artifact")).toBe(await count("artifacts"));
    expect(by("candidate")).toBe(await count("candidates"));
    expect(by("gate")).toBe(await count("gate_results"));
    expect(by("review")).toBe(await count("review_results"));
    expect(by("policy")).toBe(await count("policy_decisions"));
    expect(by("approval")).toBe(await count("approvals"));
    expect(by("merge")).toBe(await count("merge_intents"));
    expect(by("pull_request")).toBe(await count("pull_requests"));
    expect(by("agent_run")).toBe((await db.sql`SELECT count(*)::int AS c FROM agent_runs ar JOIN tasks t ON t.id=ar.task_id WHERE t.job_id=${p.jobId}`)[0]!.c);
    expect(by("audit")).toBeGreaterThanOrEqual(3);
    // chronological, no duplicates
    expect(e.map((x) => x.ts)).toEqual([...e.map((x) => x.ts)].sort());
    expect(new Set(e.map((x) => `${x.source}:${x.id}`)).size).toBe(e.length);
    // runtime labels are subscription/local only
    const runs = e.filter((x) => x.source === "agent_run").map((x) => x.data);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) { expect(["subscription_cli", "local_model"]).toContain(r.authMode as string); expect(["subscription_included", "local_compute"]).toContain(r.inferenceBillingMode as string); }
    // no monetary fields; no secrets; no local filesystem paths
    expect(keysOf(full).filter((k) => BILLING.test(k))).toEqual([]);
    const text = JSON.stringify(full);
    for (const bad of ["ghp_abcdefghijklmnopqrstuvwxyz0123", "abcdefgh12345678", "file://"]) expect(text).not.toContain(bad);
    // paging reproduces the same list
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { entries: Array<{ source: string; id: string }>; nextCursor: string | null } = await (await call("GET", `/jobs/${p.jobId}/timeline?limit=40${cursor ? `&cursor=${cursor}` : ""}`, "o-viewer")).json();
      paged.push(...page.entries.map((x) => `${x.source}:${x.id}`));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(e.map((x) => `${x.source}:${x.id}`));
    expect((await call("GET", `/jobs/${p.jobId}/timeline?limit=0`, "o-viewer")).status).toBe(400);
    expect((await call("GET", `/jobs/${p.jobId}/timeline?cursor=garbage`, "o-viewer")).status).toBe(400);
    expect((await call("GET", `/jobs/${p.jobId}/timeline`, "x-admin")).status).toBe(404); // other tenant
    // companion views
    const art = await (await call("GET", `/jobs/${p.jobId}/artifacts?limit=5`, "o-viewer")).json();
    expect(art.items.length).toBe(5);
    expect(art.nextCursor).toBe("5");
    expect(JSON.stringify(art)).not.toContain("file://");
    expect((await (await call("GET", `/jobs/${p.jobId}/artifacts?kind=spec.json`, "o-viewer")).json()).items.length).toBe(1);
    const pol = await (await call("GET", `/jobs/${p.jobId}/policy`, "o-viewer")).json();
    expect(pol).toMatchObject({ mergeEligibility: { autoMergeEligible: false, requiresHuman: true }, reviewers: { required: ["code"] } });
    expect(pol.mergeEligibility.reasons.join(" ")).toMatch(/pilot/);
  });
});

describe("usage and capacity (counts only)", () => {
  test("reports runtime utilisation, pressure signals and capacity without ANY monetary field; RBAC enforced", async () => {
    await setup();
    for (const role of ROLES) {
      const r = await call("GET", "/usage", "o-" + role);
      expect(r.status, role).toBe(PERMISSIONS[role].has("usage:read") ? 200 : 403);
    }
    const u = await (await call("GET", "/usage", "o-operator")).json();
    expect(keysOf(u).filter((k) => BILLING.test(k))).toEqual([]);
    expect(u.note).toMatch(/No monetary/);
    const total = (await db.sql`SELECT count(*)::int AS c FROM agent_runs`)[0]!.c as number;
    expect(u.runtimes.reduce((a: number, r: { runs: number }) => a + r.runs, 0)).toBe(total);
    expect(u.runtimes.every((r: { authMode: string }) => ["subscription_cli", "local_model"].includes(r.authMode))).toBe(true);
    expect(u.capacity.host).toMatchObject({ cpuCount: expect.any(Number), memTotalMb: expect.any(Number) });
    expect(u.pressure).toMatchObject({ rateLimitEvents: expect.any(Number), expiredLeases: expect.any(Number), gateFailures: expect.any(Number) });
    expect(Object.keys(u.jobs.byState).length).toBeGreaterThan(0);
    expect((await call("GET", "/usage?since=not-a-date", "o-operator")).status).toBe(400);
    expect(await (await call("GET", "/usage", "x-admin")).json()).toMatchObject({ jobs: { byState: {} }, runtimes: [] }); // other tenant sees none of it
  });
});

describe("audit view", () => {
  test("admin/security officer only, organisation-scoped, paged, redacted", async () => {
    await setup();
    for (const role of ROLES) expect((await call("GET", "/audit", "o-" + role)).status, role).toBe(PERMISSIONS[role].has("audit:read") ? 200 : 403);
    const first = await (await call("GET", "/audit?limit=3", "o-admin")).json();
    expect(first.items.length).toBe(3);
    expect(first.nextCursor).toBeTruthy();
    const second = await (await call("GET", `/audit?limit=3&cursor=${first.nextCursor}`, "o-admin")).json();
    expect(new Set([...first.items, ...second.items].map((x: { id: string }) => x.id)).size).toBe(6);
    expect(JSON.stringify(first) + JSON.stringify(second)).not.toContain("ghp_");
    expect((await (await call("GET", "/audit", "x-admin")).json()).items).toEqual([]);
    expect((await call("GET", "/audit?cursor=zzz", "o-admin")).status).toBe(400);
  });
});

describe("operator actions", () => {
  test("pause stops NEW work for the job and is audited; resume restores it; stale version/viewers/terminal are refused", async () => {
    await setup();
    const p = await prepare();
    const [j] = await db.sql`SELECT version FROM jobs WHERE id=${p.jobId}`;
    const v = j!.version as number;
    expect((await call("POST", `/jobs/${p.jobId}/pause`, "o-viewer", { reason: "x", expectedVersion: v })).status).toBe(403);
    expect((await call("POST", `/jobs/${p.jobId}/pause`, "o-operator", { reason: "x", expectedVersion: v + 7 })).status).toBe(409);
    expect((await call("POST", `/jobs/${p.jobId}/pause`, "o-operator", { reason: "", expectedVersion: v })).status).toBe(422);
    expect((await call("POST", `/jobs/${p.jobId}/pause`, "o-operator", { reason: "maintenance window", expectedVersion: v })).status).toBe(202);
    expect((await call("POST", `/jobs/${p.jobId}/pause`, "o-operator", { reason: "again", expectedVersion: v })).status).toBe(202); // idempotent
    expect((await db.sql`SELECT paused_at, pause_reason FROM jobs WHERE id=${p.jobId}`)[0]).toMatchObject({ pause_reason: "maintenance window" });
    expect((await db.sql`SELECT count(*)::int AS c FROM events WHERE job_id=${p.jobId} AND type='job.paused'`)[0]!.c).toBe(1);
    const w = await enrollWorker(cfg());
    await enqueueTask(db.sql, { jobId: p.jobId, stage: "pause-probe", role: "probe" });
    expect(await claimTask(db.sql, { workerId: w, roles: ["probe"] })).toBeNull(); // paused => not claimable
    expect((await call("POST", `/jobs/${p.jobId}/resume`, "o-operator", { reason: "done", expectedVersion: v })).status).toBe(202);
    expect(await claimTask(db.sql, { workerId: w, roles: ["probe"] })).not.toBeNull();
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE resource=${"job:" + p.jobId} AND action IN ('job.pause','job.resume')`)[0]!.c).toBe(2);
  });

  test("quarantine revokes capabilities first and parks the job; only a security officer/admin can release it, only to FAILED/CANCELLED", async () => {
    await setup();
    const p = await prepare();
    const v0 = (await db.sql`SELECT version FROM jobs WHERE id=${p.jobId}`)[0]!.version as number;
    // AWAITING_HUMAN is not an execution state: the state machine has no AWAITING_HUMAN -> QUARANTINED edge
    expect((await call("POST", `/jobs/${p.jobId}/quarantine`, "o-operator", { reason: "too early", expectedVersion: v0 })).status).toBe(409);
    await approve(p, "approver1"); // -> PREMERGE, an execution state from which quarantine is legal
    const w = await enrollWorker(cfg());
    await enqueueTask(db.sql, { jobId: p.jobId, stage: "q-probe", role: "qprobe" });
    const lease = (await claimTask(db.sql, { workerId: w, roles: ["qprobe"] }))!;
    const [j] = await db.sql`SELECT version FROM jobs WHERE id=${p.jobId}`;
    const v = j!.version as number;
    expect((await call("POST", `/jobs/${p.jobId}/quarantine`, "o-viewer", { reason: "x", expectedVersion: v })).status).toBe(403);
    const q = await call("POST", `/jobs/${p.jobId}/quarantine`, "o-operator", { reason: "suspicious diff", expectedVersion: v });
    expect(q.status).toBe(202);
    expect(await q.json()).toMatchObject({ state: "QUARANTINED" });
    await expect(heartbeatTask(db.sql, { taskId: lease.taskId, workerId: w, leaseToken: lease.leaseToken })).rejects.toBeInstanceOf(StaleLeaseError); // worker fenced out
    expect((await db.sql`SELECT count(*)::int AS c FROM events WHERE job_id=${p.jobId} AND type='security.quarantined'`)[0]!.c).toBe(1);
    const [j2] = await db.sql`SELECT version FROM jobs WHERE id=${p.jobId}`;
    const v2 = j2!.version as number;
    expect((await call("POST", `/jobs/${p.jobId}/release`, "o-operator", { reason: "ok", expectedVersion: v2, to: "CANCELLED" })).status).toBe(403);
    expect((await call("POST", `/jobs/${p.jobId}/release`, "o-security_officer", { reason: "ok", expectedVersion: v2, to: "BUILDING" })).status).toBe(422);
    expect((await call("POST", `/jobs/${p.jobId}/release`, "o-security_officer", { reason: "false alarm", expectedVersion: v2, to: "CANCELLED" })).status).toBe(202);
    expect((await db.sql`SELECT state FROM jobs WHERE id=${p.jobId}`)[0]!.state).toBe("CANCELLED");
    expect((await call("POST", `/jobs/${p.jobId}/release`, "o-security_officer", { reason: "again", expectedVersion: v2 + 1, to: "FAILED" })).status).toBe(409); // not quarantined any more
  });

  test("worker actions: quarantine fences the worker and requeues its lease; draining only stops new claims; re-activation of a quarantined worker needs security officer/admin", async () => {
    await setup();
    const p = await prepare();
    const w = await enrollWorker(cfg());
    await enqueueTask(db.sql, { jobId: p.jobId, stage: "w-probe", role: "wprobe" });
    const lease = (await claimTask(db.sql, { workerId: w, roles: ["wprobe"] }))!;
    expect((await call("POST", `/workers/${w}/drain`, "o-viewer", { reason: "x" })).status).toBe(403);
    expect(await (await call("POST", `/workers/${w}/drain`, "o-operator", { reason: "rolling restart" })).json()).toMatchObject({ status: "draining", leasesRevoked: 0 });
    expect((await db.sql`SELECT status FROM tasks WHERE id=${lease.taskId}`)[0]!.status).toBe("leased"); // running work finishes
    expect(await (await call("POST", `/workers/${w}/quarantine`, "o-operator", { reason: "possible compromise" })).json()).toMatchObject({ status: "quarantined", leasesRevoked: 1 });
    await expireLeases(db.sql);
    await expect(heartbeatTask(db.sql, { taskId: lease.taskId, workerId: w, leaseToken: lease.leaseToken })).rejects.toBeInstanceOf(StaleLeaseError);
    expect((await call("POST", `/workers/${w}/activate`, "o-operator", { reason: "back" })).status).toBe(403);
    expect((await call("POST", `/workers/${w}/activate`, "o-security_officer", { reason: "cleared" })).status).toBe(202);
    expect((await call("POST", `/workers/not-a-uuid/drain`, "o-operator", { reason: "x" })).status).toBe(404);
    expect((await call("POST", `/workers/${w}/drain`, "x-admin", { reason: "x" })).status).toBe(404); // other tenant
    const list = await (await call("GET", "/workers", "o-operator")).json();
    expect(list.items.find((x: { id: string }) => x.id === w)).toMatchObject({ status: "active" });
    expect(keysOf(list).filter((k) => BILLING.test(k))).toEqual([]);
    expect((await call("GET", "/workers", "o-viewer")).status).toBe(403);
  });
});

describe("secrets never reach logs", () => {
  test("unexpected failures are logged redacted through the structured logger", async () => {
    await setup();
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), { svc: "api" });
    const boom = createApi({ sql: db.sql, authenticator: { authenticate: async () => { throw new Error("connect failed postgres://u:pw@h/db token=ghp_abcdefghijklmnopqrstuvwxyz0123 sk-abcdefghijklmnop12345"); } }, log: (l) => log.error("request failed", l) });
    const r = await boom(new Request("http://api.test/api/v1/jobs"));
    expect(r.status).toBe(500);
    const all = lines.join("\n");
    expect(all).toContain("request failed");
    for (const bad of ["ghp_", "sk-abcdefghijklmnop12345"]) expect(all).not.toContain(bad);
    void fake; void U;
  });
});
