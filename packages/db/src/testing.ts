import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { connect, type Sql } from "./client";
import { migrateUp } from "./migrate";

/** Admin URL of the Postgres used for tests (set by tests/setup-db.ts preload, or DATABASE_URL in CI). */
export function adminUrl(): string {
  const u = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!u) throw new Error("no test database: TEST_DATABASE_URL not set (is the bun test preload configured?)");
  return u;
}

export function findPgBin(name: string): string {
  const candidates = [process.env.PG_BIN_DIR, ...["17", "16", "18", "15"].map((v) => `/opt/homebrew/opt/postgresql@${v}/bin`), "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin", "/usr/bin"];
  for (const dir of candidates) if (dir && existsSync(join(dir, name))) return join(dir, name);
  const which = spawnSync("which", [name], { encoding: "utf8" });
  if (which.status === 0) return which.stdout.trim();
  throw new Error(`cannot find ${name}; set PG_BIN_DIR`);
}

/** Starts a throwaway local cluster (trust auth, loopback only). Returns URL and a stop function. */
export function startTempCluster(): { url: string; stop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "factory-pg-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const run = (bin: string, args: string[]) => {
    const r = spawnSync(findPgBin(bin), args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr || r.stdout}`);
  };
  run("initdb", ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  run("pg_ctl", ["-D", join(dir, "data"), "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${dir} -c fsync=off`, "-w", "-l", join(dir, "log"), "start"]);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: () => {
      spawnSync(findPgBin("pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"]);
      spawnSync("rm", ["-rf", dir]);
    },
  };
}

let counter = 0;

/** Creates an isolated database (optionally migrated) and returns a connection plus cleanup. */
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<{ sql: Sql; url: string; drop: () => Promise<void> }> {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => undefined });
  const name = `t_${process.pid}_${Date.now()}_${counter++}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const sql = connect(u.toString(), { max: 10 });
  if (opts.migrate !== false) await migrateUp(sql);
  return {
    sql,
    url: u.toString(),
    drop: async () => {
      await sql.end({ timeout: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end({ timeout: 1 });
    },
  };
}
