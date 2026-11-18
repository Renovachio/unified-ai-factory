import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "./client";

export const DEFAULT_MIGRATIONS_DIR = join(import.meta.dir, "../../../migrations");

export interface Migration {
  version: string; // "0001"
  name: string;
  up: string;
  down: string;
  checksum: string;
}

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const ups = readdirSync(dir).filter((f) => f.endsWith(".up.sql")).sort();
  return ups.map((f) => {
    const m = /^(\d{4})_([a-z0-9_]+)\.up\.sql$/.exec(f);
    if (!m) throw new Error(`bad migration file name: ${f}`);
    const base = f.replace(/\.up\.sql$/, "");
    const up = readFileSync(join(dir, f), "utf8");
    let down: string;
    try {
      down = readFileSync(join(dir, `${base}.down.sql`), "utf8");
    } catch {
      throw new Error(`migration ${base} has no .down.sql (a rollback or documented compensating plan is required)`);
    }
    return { version: m[1] as string, name: m[2] as string, up, down, checksum: createHash("sha256").update(up).digest("hex") };
  });
}

const LOCK_KEY = 7_426_001;

async function ensureTable(q: Pick<Sql, "unsafe">) {
  await q.unsafe(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
}

export async function appliedVersions(sql: Sql): Promise<string[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await ensureTable(tx);
    return (await tx<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`).map((r) => r.version);
  });
}

/** Apply pending migrations up to `target` (inclusive; default all). Each runs in its own transaction. */
export async function migrateUp(sql: Sql, opts: { dir?: string; target?: string } = {}): Promise<string[]> {
  const migrations = loadMigrations(opts.dir);
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await ensureTable(tx);
    const done = new Map((await tx<{ version: string; checksum: string }[]>`SELECT version, checksum FROM schema_migrations`).map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const prior = done.get(m.version);
      if (prior !== undefined) {
        if (prior !== m.checksum) throw new Error(`migration ${m.version}_${m.name} was modified after being applied`);
        continue;
      }
      if (opts.target && m.version > opts.target) break;
      await tx.unsafe(m.up);
      await tx`INSERT INTO schema_migrations (version, name, checksum) VALUES (${m.version}, ${m.name}, ${m.checksum})`;
      applied.push(m.version);
    }
  });
  return applied;
}

/** Roll back the most recent `steps` migrations (default 1), newest first, atomically. */
export async function migrateDown(sql: Sql, opts: { dir?: string; steps?: number } = {}): Promise<string[]> {
  const migrations = new Map(loadMigrations(opts.dir).map((m) => [m.version, m]));
  const reverted: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await ensureTable(tx);
    const rows = await tx<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT ${opts.steps ?? 1}`;
    for (const { version } of rows) {
      const m = migrations.get(version);
      if (!m) throw new Error(`applied migration ${version} has no file; cannot roll back`);
      await tx.unsafe(m.down);
      await tx`DELETE FROM schema_migrations WHERE version = ${version}`;
      reverted.push(version);
    }
  });
  return reverted;
}
