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
    for (const [t, p] of [["auto_merge_global", "UPDATE"], ["merge_intents", "SELECT"], ["approvals", "SELECT"]] as const) expect(await can("factory_control", t, p), `${t}:${p}`).toBe(true);
    // Migration 0028: approval records are written only by factory_approval. Control reads them and keeps only consumed_at on skill decisions.
    for (const [t, p] of [["approvals", "INSERT"], ["approvals", "UPDATE"], ["approvals", "DELETE"], ["approval_decisions", "INSERT"], ["approval_decisions", "UPDATE"], ["approval_decisions", "DELETE"]] as const) expect(await can("factory_control", t, p), `${t}:${p}`).toBe(false);
    expect((await db.sql<{ p: boolean }[]>`SELECT has_column_privilege('factory_control', 'approval_decisions', 'consumed_at', 'UPDATE') AS p`)[0]!.p).toBe(true);
    // Migration 0026 (operator decision, Option A): user records are written by the database owner only. The control plane may read them.
    for (const p of ["INSERT", "UPDATE"] as const) expect(await can("factory_control", "users", p), `users:${p}`).toBe(false);
    // Migration 0027 (Option a): sessions are created only by the login role through create_auth_session. Control may read them.
    for (const p of ["INSERT", "UPDATE", "DELETE"] as const) expect(await can("factory_control", "auth_sessions", p), `auth_sessions:${p}`).toBe(false);
    expect(await can("factory_control", "auth_sessions", "SELECT")).toBe(true);
    expect(await denied("factory_control", `UPDATE merge_intents SET status = 'merged'`)).toBe("denied");
  });
  test("append-only guarantees still hold for every role, including the control plane", async () => {
    for (const role of ["factory_runner", "factory_merge", "factory_control"]) {
      const r = await denied(role, `DELETE FROM events`);
      expect(["denied", "other: error: events is append-only"].some((x) => r.startsWith(x.slice(0, 6))) || /append-only|denied/.test(r), `${role}: ${r}`).toBe(true);
    }
  });
});

describe("login session boundary (migration 0027)", () => {
  test("factory_login creates a session only for an enabled user through create_auth_session", async () => {
    const [u] = await db.sql<{ id: string }[]>`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, 'login-ok', 'approver') RETURNING id`;
    const h = "login-ok-" + Date.now();
    const r = await as("factory_login", (tx) => tx`SELECT create_auth_session(${h}::text, ${u!.id}::uuid, 'csrf', now(), now() + interval '1 hour', NULL::text)`.then(() => "ok", (e) => String(e)));
    expect(r).toBe("ok");
    const [row] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth_sessions WHERE id_hash = ${h}`;
    expect(row!.n).toBe(1);
  });

  test("create_auth_session refuses a disabled user", async () => {
    const [u] = await db.sql<{ id: string }[]>`INSERT INTO users (organization_id, auth_subject, role, disabled_at) VALUES (${org}, 'login-off', 'approver', now()) RETURNING id`;
    let err = "";
    try { await as("factory_login", (tx) => tx`SELECT create_auth_session(${"off-" + Date.now()}::text, ${u!.id}::uuid, 'csrf', now(), now() + interval '1 hour', NULL::text)`); } catch (e) { err = String(e); }
    expect(err).toMatch(/not an enabled account/);
  });

  test("the control role cannot insert a session for any user", async () => {
    const [u] = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE auth_subject = 'u'`;
    expect(await denied("factory_control", `INSERT INTO auth_sessions (id_hash, user_id, csrf, expires_at) VALUES ('ctl-${Date.now()}', '${u!.id}', 'c', now() + interval '1 hour')`)).toBe("denied");
  });
});

describe("approval role boundary (migration 0028)", () => {
  const can = async (role: string, table: string, priv: string) => (await db.sql`SELECT has_table_privilege(${role}, ${table}, ${priv}) AS ok`)[0]!.ok as boolean;
  test("factory_approval writes approval records and can read evidence, but NOT sessions, login transactions or integrations", async () => {
    for (const [t, p] of [["approvals", "INSERT"], ["approval_decisions", "INSERT"], ["jobs", "UPDATE"], ["idempotency_keys", "DELETE"], ["outbox", "INSERT"]] as const) expect(await can("factory_approval", t, p), `${t}:${p}`).toBe(true);
    for (const t of ["auth_sessions", "auth_login_transactions", "integrations"]) expect(await can("factory_approval", t, "SELECT"), t).toBe(false);
    expect(await can("factory_approval", "approvals", "DELETE")).toBe(false);
    expect(await can("factory_approval", "users", "SELECT")).toBe(true);
  });
});

describe("approval and session guards hold against the approval and login roles (review of 0026-0030)", () => {
  const refusal = async (fn: () => Promise<unknown>) => { try { await fn(); return "allowed"; } catch (e) { return String(e); } };
  test("create_auth_session cannot be defeated by a temp table shadowing users (pg_temp is searched last)", async () => {
    const [u] = await db.sql<{ id: string }[]>`INSERT INTO users (organization_id, auth_subject, role, disabled_at) VALUES (${org}, 'shadow-off', 'approver', now()) RETURNING id`;
    const err = await refusal(() => as("factory_login", async (tx) => {
      await tx.unsafe("CREATE TEMP TABLE users (id uuid, organization_id uuid, role text, disabled_at timestamptz)");
      await tx.unsafe(`INSERT INTO pg_temp.users VALUES ('${u!.id}', '${org}', 'approver', NULL)`);
      await tx`SELECT create_auth_session(${"shadow-" + Date.now()}::text, ${u!.id}::uuid, 'csrf', now(), now() + interval '1 hour', NULL::text)`;
    }));
    expect(err).toMatch(/not an enabled account/);
    const [row] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = ${u!.id}`;
    expect(row!.n).toBe(0);
  });

  test("factory_approval cannot record an approval for a viewer (approvals_actor_guard, migration 0030)", async () => {
    const [v] = await db.sql<{ id: string }[]>`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, 'viewer-x', 'viewer') RETURNING id`;
    const err = await refusal(() => as("factory_approval", (tx) => tx`INSERT INTO approvals (job_id, head_sha, base_sha, policy_digest, actor_id, decision, reason)
      VALUES (${jobId}, ${"a".repeat(40)}, ${"b".repeat(40)}, 'sha256:x', ${v!.id}, 'approve', 'probe')`));
    expect(err).toMatch(/enabled approver or admin of the job organization/);
  });

  test("factory_approval can record an approval for an enabled approver of the job's organization", async () => {
    const [a] = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE auth_subject = 'u'`;
    const err = await refusal(() => as("factory_approval", (tx) => tx`INSERT INTO approvals (job_id, head_sha, base_sha, policy_digest, actor_id, decision, reason)
      VALUES (${jobId}, ${"a".repeat(40)}, ${"b".repeat(40)}, 'sha256:x', ${a!.id}, 'approve', 'probe')`));
    expect(err).toBe("allowed");
  });
});
