import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { JOB_STATES, TRANSITIONS } from "@factory/domain";
import { appliedVersions, DEFAULT_MIGRATIONS_DIR, loadMigrations, migrateDown, migrateUp, schema, uuidv7, type Sql } from "../src/index";
import { createTestDb } from "../src/testing";

const H = (c: string) => c.repeat(40);

async function seed(sql: Sql, n = 1) {
  const [org] = await sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`;
  const [user] = await sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org!.id}, ${"s" + n}, 'editor') RETURNING id`;
  const [repo] = await sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org!.id}, 'github', ${"r" + n}, 'ow', 'nm') RETURNING id`;
  return { orgId: org!.id as string, userId: user!.id as string, repoId: repo!.id as string };
}
async function newJob(sql: Sql, repoId: string, ext = "e1") {
  const [req] = await sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description)
    VALUES (${repoId}, 'api', ${ext}, 'sha256:x', 'feature', 't', 'd') RETURNING id`;
  const [job] = await sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repoId}) RETURNING id`;
  return job!.id as string;
}
const rejects = async (p: PromiseLike<unknown>, re?: RegExp) => {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeDefined();
  if (re) expect(String((err as Error).message)).toMatch(re);
};

describe("migrations: fresh install, upgrade, rollback", () => {
  test("fresh install applies all migrations once and is idempotent", async () => {
    const db = await createTestDb({ migrate: false });
    try {
      expect(await migrateUp(db.sql)).toEqual(["0001", "0002", "0003"]);
      expect(await migrateUp(db.sql)).toEqual([]);
      expect(await appliedVersions(db.sql)).toEqual(["0001", "0002", "0003"]);
    } finally { await db.drop(); }
  });
  test("upgrade 0001 -> 0002 preserves data; rollback 0002 keeps it; rollback 0001 removes everything; re-apply works", async () => {
    const db = await createTestDb({ migrate: false });
    try {
      await migrateUp(db.sql, { target: "0001" });
      const s = await seed(db.sql);
      await newJob(db.sql, s.repoId);
      expect(await migrateUp(db.sql)).toEqual(["0002", "0003"]);
      expect((await db.sql`SELECT count(*)::int AS c FROM jobs`)[0]!.c).toBe(1);
      expect(await migrateDown(db.sql, { steps: 2 })).toEqual(["0003", "0002"]);
      expect((await db.sql`SELECT to_regclass('idempotency_keys') AS t`)[0]!.t).toBeNull();
      expect((await db.sql`SELECT count(*)::int AS c FROM jobs`)[0]!.c).toBe(1);
      expect(await migrateDown(db.sql)).toEqual(["0001"]);
      const left = await db.sql`SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'schema_migrations'`;
      expect(left[0]!.c).toBe(0);
      expect(await migrateUp(db.sql)).toEqual(["0001", "0002", "0003"]);
    } finally { await db.drop(); }
  });
  test("failed migration rolls back atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "0001_a.up.sql"), "CREATE TABLE a (x int);");
    writeFileSync(join(dir, "0001_a.down.sql"), "DROP TABLE a;");
    writeFileSync(join(dir, "0002_b.up.sql"), "CREATE TABLE b (x int); SELECT 1/0;");
    writeFileSync(join(dir, "0002_b.down.sql"), "DROP TABLE b;");
    const db = await createTestDb({ migrate: false });
    try {
      await rejects(migrateUp(db.sql, { dir }), /division by zero/);
      expect(await appliedVersions(db.sql)).toEqual([]);
      expect((await db.sql`SELECT to_regclass('a') AS t`)[0]!.t).toBeNull();
    } finally { await db.drop(); }
  });
  test("modifying an applied migration is detected; missing down file is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    const db = await createTestDb({ migrate: false });
    try {
      await migrateUp(db.sql, { dir });
      writeFileSync(join(dir, "0001_core.up.sql"), readFileSync(join(dir, "0001_core.up.sql"), "utf8") + "\n-- tampered\n");
      await rejects(migrateUp(db.sql, { dir }), /modified after being applied/);
    } finally { await db.drop(); }
    const dir2 = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir2, "0001_x.up.sql"), "SELECT 1;");
    expect(() => loadMigrations(dir2)).toThrow(/no \.down\.sql/);
  });
  test("concurrent migrators do not double-apply", async () => {
    const db = await createTestDb({ migrate: false });
    try {
      const results = await Promise.all([migrateUp(db.sql), migrateUp(db.sql), migrateUp(db.sql)]);
      expect(results.flat().sort()).toEqual(["0001", "0002", "0003"]);
    } finally { await db.drop(); }
  });
});

describe("schema, constraints and guards", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let ctx: Awaited<ReturnType<typeof seed>>;
  let jobId: string;
  beforeAll(async () => {
    db = await createTestDb();
    ctx = await seed(db.sql);
    jobId = await newJob(db.sql, ctx.repoId);
  });
  afterAll(async () => { await db.drop(); });

  test("drizzle schema matches the migrated database (tables, columns, nullability)", async () => {
    const cols = await db.sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`;
    const actual = new Map(cols.map((c) => [`${c.table_name}.${c.column_name}`, c.is_nullable === "YES"]));
    const declared = new Set<string>();
    for (const t of Object.values(schema)) {
      const cfg = getTableConfig(t);
      for (const c of cfg.columns) {
        const key = `${cfg.name}.${c.name}`;
        declared.add(key);
        expect(actual.has(key)).toBe(true);
        expect(!c.notNull && !c.primary).toBe(actual.get(key) as boolean);
      }
    }
    for (const key of actual.keys()) if (!key.startsWith("schema_migrations.")) expect(declared.has(key)).toBe(true);
  });

  test("no model-billing columns exist anywhere", async () => {
    const r = await db.sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'
      AND column_name ~* '(usd|dollar|invoice|billed|price|cost|api_key|token_secret)'`;
    expect(r.length).toBe(0);
  });

  test("DB state check and allowed_transitions mirror the domain model", async () => {
    const rows = await db.sql<{ from_state: string; to_state: string }[]>`SELECT from_state, to_state FROM allowed_transitions`;
    const db_pairs = rows.map((r) => `${r.from_state}>${r.to_state}`).sort();
    const domain_pairs = Object.entries(TRANSITIONS).flatMap(([f, ts]) => ts.map((t) => `${f}>${t}`)).sort();
    expect(db_pairs).toEqual(domain_pairs);
    const def = (await db.sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='jobs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%QUEUED%'`)[0]!.d as string;
    for (const s of JOB_STATES) expect(def).toContain(`'${s}'`);
  });

  test("DB rejects illegal transitions, skipped versions; accepts legal ones", async () => {
    await rejects(db.sql`UPDATE jobs SET state='MERGING', version=2 WHERE id=${jobId}`, /illegal job transition QUEUED -> MERGING/);
    await rejects(db.sql`UPDATE jobs SET state='INTAKE' WHERE id=${jobId}`, /version must increase/);
    await rejects(db.sql`UPDATE jobs SET state='NOPE', version=2 WHERE id=${jobId}`);
    await db.sql`UPDATE jobs SET state='INTAKE', version=2 WHERE id=${jobId}`;
    await db.sql`UPDATE jobs SET state='CANCELLED', version=3 WHERE id=${jobId}`;
    await rejects(db.sql`UPDATE jobs SET state='QUEUED', version=4 WHERE id=${jobId}`, /illegal job transition CANCELLED -> QUEUED/);
  });

  test("job identity columns are immutable; sha format enforced", async () => {
    const other = await newJob(db.sql, ctx.repoId, "e-imm");
    await rejects(db.sql`UPDATE jobs SET repository_id = gen_random_uuid() WHERE id=${other}`);
    await rejects(db.sql`UPDATE jobs SET head_sha='zzz' WHERE id=${other}`);
    await db.sql`UPDATE jobs SET head_sha=${H("a")} WHERE id=${other}`;
  });

  test("unique constraints: request source id, job per request, webhook delivery, merge intent, task, event sequence", async () => {
    await rejects(newJob(db.sql, ctx.repoId, "e1"), /requests_repository_id_source_source_external_id_key|duplicate key/);
    const [req] = await db.sql`SELECT request_id FROM jobs WHERE id=${jobId}`;
    await rejects(db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.request_id}, ${ctx.repoId})`, /duplicate key/);
    await db.sql`INSERT INTO webhook_deliveries (provider, delivery_id, signature_valid) VALUES ('github','d1',true)`;
    await rejects(db.sql`INSERT INTO webhook_deliveries (provider, delivery_id, signature_valid) VALUES ('github','d1',true)`, /duplicate key/);
    await db.sql`INSERT INTO merge_intents (job_id, repository_id, pr_number, head_sha) VALUES (${jobId}, ${ctx.repoId}, 1, ${H("a")})`;
    await rejects(db.sql`INSERT INTO merge_intents (job_id, repository_id, pr_number, head_sha) VALUES (${jobId}, ${ctx.repoId}, 1, ${H("a")})`, /duplicate key/);
    await db.sql`INSERT INTO tasks (job_id, stage, role, attempt) VALUES (${jobId}, 'build', 'builder', 1)`;
    await rejects(db.sql`INSERT INTO tasks (job_id, stage, role, attempt) VALUES (${jobId}, 'build', 'builder', 1)`, /duplicate key/);
    await db.sql`INSERT INTO events (job_id, sequence, type, source, digest) VALUES (${jobId}, 1, 'x', 's', 'd')`;
    await rejects(db.sql`INSERT INTO events (job_id, sequence, type, source, digest) VALUES (${jobId}, 1, 'x', 's', 'd')`, /duplicate key/);
  });

  test("concurrent duplicate inserts: exactly one wins", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => db.sql`INSERT INTO webhook_deliveries (provider, delivery_id, signature_valid) VALUES ('github','race',true)`),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  });

  test("transaction rollback leaves no partial state", async () => {
    const before = (await db.sql`SELECT count(*)::int AS c FROM audit_entries`)[0]!.c;
    await rejects(db.sql.begin(async (tx) => {
      await tx`INSERT INTO audit_entries (actor, action, resource, result, digest) VALUES ('a','x','r','ok','d')`;
      await tx`INSERT INTO tasks (job_id, stage, role, status) VALUES (${jobId}, 's', 'r', 'leased')`; // violates lease check
    }));
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries`)[0]!.c).toBe(before);
  });

  test("append-only tables reject UPDATE and DELETE", async () => {
    await db.sql`INSERT INTO audit_entries (actor, action, resource, result, digest) VALUES ('a','x','r','ok','d')`;
    await rejects(db.sql`UPDATE audit_entries SET result='tampered'`, /append-only/);
    await rejects(db.sql`DELETE FROM audit_entries`, /append-only/);
    await rejects(db.sql`UPDATE events SET type='y'`, /append-only/);
    await rejects(db.sql`DELETE FROM events`, /append-only/);
    await db.sql`INSERT INTO approvals (job_id, head_sha, base_sha, policy_digest, actor_id, decision) VALUES (${jobId}, ${H("a")}, ${H("b")}, 'p', ${ctx.userId}, 'approve')`;
    await rejects(db.sql`UPDATE approvals SET decision='reject'`, /append-only/);
    await db.sql`INSERT INTO job_transitions (job_id, from_state, to_state, version, actor_id) VALUES (${jobId}, 'QUEUED', 'INTAKE', 2, 'system')`;
    await rejects(db.sql`DELETE FROM job_transitions`, /append-only/);
    await rejects(db.sql`INSERT INTO job_transitions (job_id, from_state, to_state, version, actor_id) VALUES (${jobId}, 'DONE', 'QUEUED', 9, 'system')`, /foreign key/);
    await rejects(db.sql`DELETE FROM allowed_transitions`, /append-only/);
  });

  test("domain CHECKs: policy, billing modes, roles, digests, lease", async () => {
    await rejects(db.sql`INSERT INTO policy_decisions (job_id, head_sha, policy_digest, risk, eligible) VALUES (${jobId}, ${H("a")}, 'p', 'HIGH', true)`, /check/);
    await db.sql`INSERT INTO policy_decisions (job_id, head_sha, policy_digest, risk, eligible) VALUES (${jobId}, ${H("a")}, 'p', 'HIGH', false)`;
    await rejects(db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${ctx.orgId}, 'x', 'root')`, /check/);
    const [t] = await db.sql`INSERT INTO tasks (job_id, stage, role, attempt) VALUES (${jobId}, 'k', 'r', 7) RETURNING id`;
    const run = (auth: string, bill: string) => db.sql`INSERT INTO agent_runs (task_id, runtime_id, model_id, prompt_digest, context_digest, status, auth_mode, inference_billing_mode, usage_source)
      VALUES (${t!.id}, 'rt', 'm', 'p', 'c', 'ok', ${auth}, ${bill}, 'unavailable')`;
    await rejects(run("api_key", "subscription_included"), /check/);
    await rejects(run("local_model", "metered"), /check/);
    await run("local_model", "local_compute");
    await rejects(db.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length) VALUES (${jobId}, 'k', 'md5:abc', 'u', 1)`, /check/);
  });

  test("cross-job isolation: child rows require an existing job", async () => {
    await rejects(db.sql`INSERT INTO events (job_id, sequence, type, source, digest) VALUES (gen_random_uuid(), 1, 'x', 's', 'd')`, /foreign key/);
  });
});

describe("ids", () => {
  test("uuidv7 is valid, versioned and time-sortable", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
