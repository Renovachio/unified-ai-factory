import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { appliedVersions, loadMigrations, migrateUp } from "@factory/db";
import { migrationsDir } from "./runtime";
import { processIdentity, type DispatchConfig, type DispatchPaths, type Probe, type ServiceSpec, type Started } from "@factory/dispatch-core";

const PG_PORT = 54329; const PG_USER = "dispatch"; const PG_DB = "dispatch";

export function findPg(name: string, env: Record<string, string | undefined> = process.env): string | null {
  for (const dir of [env.DISPATCH_PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/opt/postgresql@16/bin", "/usr/local/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin"])
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  const w = spawnSync("which", [name], { encoding: "utf8" }); return w.status === 0 ? w.stdout.trim() : null;
}
/** pg_ctl -o is re-split by a shell: every path must be single-quoted (macOS data dir is "Application Support"). Paths containing a quote are refused. */
export function pgOptions(paths: DispatchPaths): string {
  for (const p of [paths.pgSocket, paths.pgData]) if (p.includes("'") || p.includes("\n")) throw new Error(`unsupported character in path ${JSON.stringify(p)}`);
  return `-c listen_addresses='' -c unix_socket_directories='${paths.pgSocket}' -c port=${PG_PORT}`;
}
export const managedUrl = (paths: DispatchPaths, db = PG_DB) => `postgres://${PG_USER}@localhost/${db}?host=${encodeURIComponent(paths.pgSocket)}&port=${PG_PORT}`;
export const databaseUrl = (cfg: DispatchConfig, paths: DispatchPaths): string => (cfg.postgres.mode === "external" ? (cfg.postgres.url as string) : managedUrl(paths));

/** Schema state of a reachable database: never mutates. */
export async function schemaState(url: string): Promise<{ applied: string[]; pending: string[]; unknown: string[] }> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined, connect_timeout: 3 });
  try { const applied = await appliedVersions(sql).catch(() => [] as string[]); const known = loadMigrations(migrationsDir()).map((m) => m.version); return { applied, pending: known.filter((v) => !applied.includes(v)), unknown: applied.filter((v) => !known.includes(v)) }; } finally { await sql.end({ timeout: 1 }); }
}

/** Explicit, additive migration (the only place migrations run from the launcher); returns the versions applied. */
export async function runMigrations(url: string): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined, connect_timeout: 5 });
  try { const dir = migrationsDir(); return await migrateUp(sql, dir ? { dir } : {}); } finally { await sql.end({ timeout: 1 }); }
}

export function postgresSpec(cfg: DispatchConfig, paths: DispatchPaths, env: Record<string, string | undefined> = process.env): ServiceSpec {
  const external = cfg.postgres.mode === "external";
  const url = databaseUrl(cfg, paths);
  const probe = async (): Promise<Probe> => {
    const sql = postgres(url, { max: 1, onnotice: () => undefined, connect_timeout: 3 });
    try {
      await sql`SELECT 1`;
      const st = await schemaState(url);
      if (st.unknown.length) return { live: true, ready: false, detail: `database has migrations this build does not know (${st.unknown.join(", ")}); upgrade Dispatch` };
      if (st.pending.length === st.applied.length + st.pending.length && st.applied.length === 0) return { live: true, ready: false, detail: `database is empty: run \`dispatch migrate\` (${st.pending.length} migrations)` };
      if (st.pending.length) return { live: true, ready: false, detail: `${st.pending.length} pending migration(s) (${st.pending.join(", ")}): review and run \`dispatch migrate\`` };
      return { live: true, ready: true, detail: `${external ? "external" : "managed"} PostgreSQL, schema ${st.applied[st.applied.length - 1]}` };
    } catch (e) { return { live: false, ready: false, detail: `cannot connect: ${(e as Error).message.slice(0, 120)}` }; } finally { await sql.end({ timeout: 1 }).catch(() => undefined); }
  };
  const spec: ServiceSpec = { name: "postgres", required: true, kind: "startable", probe, readyTimeoutMs: 45_000 };
  if (external) return spec; // never started, stopped or migrated implicitly
  spec.start = async (): Promise<Started> => {
    const initdb = findPg("initdb", env), pgctl = findPg("pg_ctl", env);
    if (!initdb || !pgctl) throw new Error("PostgreSQL 17 binaries not found. Install with `brew install postgresql@17` or set postgres.mode=external in the config");
    mkdirSync(paths.pgSocket, { recursive: true, mode: 0o700 }); chmodSync(paths.pgSocket, 0o700); mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
    if (!existsSync(join(paths.pgData, "PG_VERSION"))) {
      mkdirSync(join(paths.home, "pg"), { recursive: true, mode: 0o700 });
      const r = spawnSync(initdb, ["-D", paths.pgData, "-U", PG_USER, "-A", "trust", "-E", "UTF8"], { encoding: "utf8", env: { PATH: env.PATH ?? "/usr/bin:/bin", LC_ALL: "en_US.UTF-8" } });
      if (r.status !== 0) throw new Error(`initdb failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
    }
    // Unix-socket only (no TCP listener), socket directory 0700: reachable only by this OS user.
    const s = spawnSync(pgctl, ["-D", paths.pgData, "-o", pgOptions(paths), "-w", "-t", "40", "-l", join(paths.logs, "postgres.log"), "start"], { encoding: "utf8", env: { PATH: env.PATH ?? "/usr/bin:/bin", LC_ALL: env.LC_ALL ?? "en_US.UTF-8" } });
    if (s.status !== 0) throw new Error(`pg_ctl start failed: ${(s.stderr || s.stdout).slice(0, 300)}`);
    // Create the database only if it does not exist, and apply the initial schema ONLY to a database we just created (never to an existing one).
    const admin = postgres(managedUrl(paths, "postgres"), { max: 1, onnotice: () => undefined });
    let created = false;
    try { const ex = await admin`SELECT 1 FROM pg_database WHERE datname = ${PG_DB}`; if (ex.length === 0) { await admin.unsafe(`CREATE DATABASE ${PG_DB}`); created = true; } } finally { await admin.end({ timeout: 1 }); }
    if (created) await runMigrations(url);
    const pid = Number(readFileSync(join(paths.pgData, "postmaster.pid"), "utf8").split("\n")[0]);
    const id = processIdentity(pid);
    return { pid, ...(id ? { startedAt: id.startedAt } : {}), marker: paths.pgData };
  };
  spec.stop = async () => {
    const pgctl = findPg("pg_ctl", env); if (!pgctl) return;
    spawnSync(pgctl, ["-D", paths.pgData, "-m", "fast", "-w", "-t", "30", "stop"], { encoding: "utf8", env: { PATH: env.PATH ?? "/usr/bin:/bin" } });
  };
  return spec;
}
