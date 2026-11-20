import { describe, expect, test } from "bun:test";
import { appendEvent, loadMigrations, migrateDown, migrateUp } from "../../db/src/index";
import { createTestDb } from "../../db/src/testing";
import { canTransition, MEMORY_STATUSES, MEMORY_TRANSITIONS } from "../src/index";

/** Every memory migration (0017 onward), so these tests track new migrations without edits. */
const MEMORY_MIGRATIONS = loadMigrations().map((m) => m.version).filter((v) => v >= "0017");

describe("migration 0017 (MEM-01): upgrade, parity and rollback", () => {
  test("upgrading a database that already holds jobs, artifacts and events preserves every existing row", async () => {
    const db = await createTestDb({ migrate: false });
    try {
      await migrateUp(db.sql, { target: "0016" });
      const [org] = await db.sql`INSERT INTO organizations (name) VALUES ('old') RETURNING id`;
      const [repo] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org!.id}, 'github', 'x', 'o', 'n') RETURNING id`;
      const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo!.id}, 'api', 'e', 'sha256:x', 'feature', 't', 'd') RETURNING id`;
      const [job] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repo!.id}) RETURNING id`;
      await db.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length) VALUES (${job!.id}, 'spec', ${"sha256:" + "a".repeat(64)}, 'file:///x', 1)`;
      await db.sql.begin(async (tx) => appendEvent(tx, { jobId: job!.id as string, type: "t", source: "test" }));
      const count = async () => (await db.sql<{ n: number }[]>`SELECT (SELECT count(*) FROM jobs)::int AS n`)[0]!.n;
      const before = { jobs: await count(), events: (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM events`)[0]!.n, artifacts: (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM artifacts`)[0]!.n };

      expect(await migrateUp(db.sql)).toEqual(MEMORY_MIGRATIONS);

      const after = { jobs: await count(), events: (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM events`)[0]!.n, artifacts: (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM artifacts`)[0]!.n };
      expect(after).toEqual(before);
      const [mem] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_records`;
      expect(mem!.n).toBe(0);
    } finally { await db.drop(); }
  });

  test("the SQL lifecycle function agrees with the TypeScript matrix on every (from, to) pair", async () => {
    const db = await createTestDb();
    try {
      for (const from of MEMORY_STATUSES) for (const to of MEMORY_STATUSES) {
        const [r] = await db.sql<{ ok: boolean }[]>`SELECT memory_transition_allowed(${from}, ${to}) AS ok`;
        expect([from, to, r!.ok]).toEqual([from, to, canTransition(from, to)]);
      }
      expect(MEMORY_TRANSITIONS.deleted).toEqual([]);
    } finally { await db.drop(); }
  });

  test("rollback is a clean reversal on an empty database and refuses to destroy memory data", async () => {
    const db = await createTestDb();
    try {
      expect(await migrateDown(db.sql, { steps: MEMORY_MIGRATIONS.length })).toEqual([...MEMORY_MIGRATIONS].reverse());
      const [t] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'memory_%'`;
      expect(t!.n).toBe(0);
      expect(await migrateUp(db.sql)).toEqual(MEMORY_MIGRATIONS);
      const [org] = await db.sql`INSERT INTO organizations (name) VALUES ('keep') RETURNING id`;
      const [user] = await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org!.id}, 'u', 'editor') RETURNING id`;
      const [repo] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org!.id}, 'github', 'k', 'o', 'n') RETURNING id`;
      // Since 0025 every row needs its transition record in the same transaction.
      await db.sql.begin(async (tx) => {
        const [m] = await tx<{ id: string }[]>`INSERT INTO memory_records (organization_id, project_id, kind, claim, normalized_claim_hash, source_digest, created_by)
          VALUES (${org!.id}, ${repo!.id}, 'note', 'kept', 'h', ${"sha256:" + "b".repeat(64)}, ${user!.id}) RETURNING id`;
        await tx`INSERT INTO memory_transitions (memory_id, from_status, to_status, record_version, actor_id, actor, evidence_digest)
          VALUES (${m!.id}, NULL, 'proposed', 1, ${user!.id}, 'editor', ${"sha256:" + "c".repeat(64)})`;
      });
      let msg = "";
      try { await migrateDown(db.sql, { steps: MEMORY_MIGRATIONS.length }); } catch (e) { msg = String((e as Error).message); }
      expect(msg).toMatch(/cannot roll back 0017/);
      const [still] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_records`;
      expect(still!.n).toBe(1);
    } finally { await db.drop(); }
  });

  test("least privilege: the control role can use memory; the runner and the supervisor cannot read it", async () => {
    const db = await createTestDb();
    try {
      const probe = async (role: string, sqlText: string) => {
        try {
          await db.sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL ROLE ${role}`);
            await tx.unsafe(sqlText);
          });
          return "allowed";
        } catch (e) {
          return String((e as Error).message);
        }
      };
      expect(await probe("factory_control", "SELECT count(*) FROM memory_records")).toBe("allowed");
      expect(await probe("factory_runner", "SELECT count(*) FROM memory_records")).toMatch(/permission denied/);
      expect(await probe("factory_supervisor", "SELECT count(*) FROM memory_records")).toMatch(/permission denied/);
      expect(await probe("factory_control", "DELETE FROM memory_records")).toMatch(/permission denied/);
      expect(await probe("factory_control", "UPDATE memory_transitions SET reason = 'x'")).toMatch(/permission denied/);
    } finally { await db.drop(); }
  });

  test("the migration pair exists and has a rollback", () => {
    const m = loadMigrations().find((x) => x.version === "0017");
    expect(m?.name).toBe("memory_core");
    expect(m!.down.length).toBeGreaterThan(0);
  });
});

describe("ownership: control roles never own memory tables", () => {
  test("no memory table or context_packs is owned by a factory role (an owner could disable the guards)", async () => {
    const db = await createTestDb();
    try {
      const rows = await db.sql<{ tablename: string; tableowner: string }[]>`SELECT tablename, tableowner FROM pg_tables
        WHERE schemaname = 'public' AND (tablename LIKE 'memory%' OR tablename = 'context_packs')`;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.tableowner.startsWith("factory_")).toBe(false);
    } finally { await db.drop(); }
  });
});

describe("migration 0027 (login session boundary): round trip", () => {
  test("up creates the login role and session function; down removes both and restores control's session grant", async () => {
    const db = await createTestDb({ migrate: false });
    try {
      await migrateUp(db.sql);
      const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
      expect(await count(db.sql`SELECT count(*)::int n FROM pg_roles WHERE rolname = 'factory_login'`)).toBe(1);
      // Revert everything above 0027 plus 0027 itself, so later migrations do not break this test.
      await migrateDown(db.sql, { steps: loadMigrations().filter((m) => m.version > "0027").length + 1 });
      expect(await count(db.sql`SELECT count(*)::int n FROM pg_roles WHERE rolname = 'factory_login'`)).toBe(0);
      expect(await count(db.sql`SELECT count(*)::int n FROM pg_proc WHERE proname = 'create_auth_session'`)).toBe(0);
      expect((await db.sql<{ p: boolean }[]>`SELECT has_table_privilege('factory_control', 'auth_sessions', 'INSERT') AS p`)[0]!.p).toBe(true);
      await migrateUp(db.sql);
      expect(await count(db.sql`SELECT count(*)::int n FROM pg_roles WHERE rolname = 'factory_login'`)).toBe(1);
    } finally { await db.drop(); }
  }, 60000);
});
