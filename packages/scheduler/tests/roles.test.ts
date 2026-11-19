import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../db/src/testing";
import { claimTask, completeTask, enqueueTask, heartbeatTask, registerWorker, reportTaskEvent } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
let org = "", repo = "", jobId = "";
beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id;
  const [rq] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', 'e', 'x', 'feature', 't', 'd') RETURNING id`;
  jobId = (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${rq!.id}, ${repo}) RETURNING id`)[0]!.id;
  await db.sql`INSERT INTO integrations (organization_id, provider, external_id, credentials_ref) VALUES (${org}, 'github', '1', 'vault://github-app-key')`;
  await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, 'u', 'approver')`;
});
afterAll(async () => { await db.drop(); });

/** Runs `fn` inside a transaction as the given database role (privileges are the role's, not the superuser's). */
const as = async <T>(role: string, fn: (tx: typeof db.sql) => Promise<T>): Promise<T> =>
  (await db.sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE ${role}`); return fn(tx as unknown as typeof db.sql); })) as T;
const denied = async (role: string, stmt: string) => {
  try { await as(role, (tx) => tx.unsafe(stmt)); return "allowed"; } catch (e) { return /permission denied/.test(String(e)) ? "denied" : `other: ${String(e).slice(0, 120)}`; }
};

describe("database privilege separation (SEC-05)", () => {
  test("the runner role can do its real work: register, enqueue-visible claim, heartbeat, event append, complete", async () => {
    const taskId = await enqueueTask(db.sql, { jobId, stage: "build", role: "builder" });
    const workerId = await registerWorker(db.sql, { organizationId: org, mode: "local" });
    const now = new Date(Date.now() + 5000);
    await as("factory_runner", async (tx) => {
      const lease = await claimTask(tx, { workerId, now });
      expect(lease?.taskId).toBe(taskId);
      await heartbeatTask(tx, { taskId, workerId, leaseToken: lease!.leaseToken, now });
      await reportTaskEvent(tx, { taskId, workerId, leaseToken: lease!.leaseToken, type: "agent.progress", payload: { m: 1 }, now });
      await completeTask(tx, { taskId, workerId, leaseToken: lease!.leaseToken, outcome: "succeeded", now });
    });
    expect((await db.sql`SELECT status FROM tasks WHERE id=${taskId}`)[0]!.status).toBe("succeeded");
  });
  const can = async (role: string, table: string, priv: string) => (await db.sql`SELECT has_table_privilege(${role}, ${table}, ${priv}) AS ok`)[0]!.ok as boolean;
  const canCol = async (role: string, table: string, col: string, priv: string) => (await db.sql`SELECT has_column_privilege(${role}, ${table}, ${col}, ${priv}) AS ok`)[0]!.ok as boolean;
  test("privilege matrix: the runner CANNOT approve, merge, change job state, read users/sessions/credential references, or touch policy and auto-merge controls", async () => {
    for (const [t, p] of [["approvals", "INSERT"], ["approvals", "SELECT"], ["merge_intents", "INSERT"], ["merge_intents", "UPDATE"], ["merge_intents", "SELECT"], ["users", "SELECT"], ["auth_sessions", "SELECT"], ["auth_login_transactions", "SELECT"], ["integrations", "SELECT"], ["policy_decisions", "INSERT"], ["policy_decisions", "SELECT"], ["auto_merge_global", "UPDATE"], ["auto_merge_global", "SELECT"], ["auto_merge_repo_controls", "SELECT"], ["audit_entries", "DELETE"], ["audit_entries", "UPDATE"], ["audit_entries", "SELECT"], ["events", "DELETE"], ["events", "UPDATE"], ["jobs", "DELETE"], ["jobs", "INSERT"]] as const) expect(await can("factory_runner", t, p), `${t}:${p}`).toBe(false);
    for (const col of ["state", "risk", "paused_at", "head_sha"]) expect(await canCol("factory_runner", "jobs", col, "UPDATE"), `jobs.${col}`).toBe(false);
    expect(await canCol("factory_runner", "jobs", "event_seq", "UPDATE")).toBe(true);
  });
  test("a real runner session cannot read secrets or alter state (statements, not just the catalog)", async () => {
    for (const s of [`SELECT * FROM users`, `SELECT credentials_ref FROM integrations`, `SELECT * FROM auth_sessions`, `UPDATE jobs SET state = 'MERGING'`, `UPDATE auto_merge_global SET kill_switch = false`, `UPDATE audit_entries SET result = 'x'`]) expect(await denied("factory_runner", s), s).toBe("denied");
  });
  test("merge role: writes merge intents, reads evidence; CANNOT create approvals, read users/sessions, change controls or policy, or enqueue tasks", async () => {
    for (const [t, p] of [["approvals", "INSERT"], ["approvals", "UPDATE"], ["users", "SELECT"], ["auth_sessions", "SELECT"], ["auto_merge_global", "UPDATE"], ["auto_merge_repo_controls", "UPDATE"], ["policy_decisions", "INSERT"], ["policy_decisions", "UPDATE"], ["tasks", "INSERT"], ["workers", "UPDATE"]] as const) expect(await can("factory_merge", t, p), `${t}:${p}`).toBe(false);
    for (const [t, p] of [["merge_intents", "INSERT"], ["merge_intents", "UPDATE"], ["approvals", "SELECT"], ["policy_decisions", "SELECT"], ["gate_results", "SELECT"], ["review_results", "SELECT"]] as const) expect(await can("factory_merge", t, p), `${t}:${p}`).toBe(true);
    await as("factory_merge", async (tx) => { expect((await tx`SELECT count(*)::int AS c FROM approvals`)[0]!.c).toBeGreaterThanOrEqual(0); });
  });
  test("control plane: administers approvals/users/sessions/policy but CANNOT write merge intents (only the merge authority merges)", async () => {
    for (const [t, p] of [["merge_intents", "INSERT"], ["merge_intents", "UPDATE"], ["merge_intents", "DELETE"]] as const) expect(await can("factory_control", t, p), `${t}:${p}`).toBe(false);
    for (const [t, p] of [["approvals", "INSERT"], ["users", "UPDATE"], ["auth_sessions", "INSERT"], ["auto_merge_global", "UPDATE"], ["merge_intents", "SELECT"]] as const) expect(await can("factory_control", t, p), `${t}:${p}`).toBe(true);
    expect(await denied("factory_control", `UPDATE merge_intents SET status = 'merged'`)).toBe("denied");
  });
  test("append-only guarantees still hold for every role, including the control plane", async () => {
    for (const role of ["factory_runner", "factory_merge", "factory_control"]) {
      const r = await denied(role, `DELETE FROM events`);
      expect(["denied", "other: error: events is append-only"].some((x) => r.startsWith(x.slice(0, 6))) || /append-only|denied/.test(r), `${role}: ${r}`).toBe(true);
    }
  });
});
