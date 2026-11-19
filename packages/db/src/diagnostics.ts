import { redact } from "@factory/telemetry";
import type { Sql } from "./client";
import { appliedVersions, loadMigrations } from "./migrate";

export interface DiagnosticsBundle {
  generatedAt: string;
  migrations: { applied: string[]; pending: string[]; unknownApplied: string[] };
  jobsByState: Record<string, number>;
  outbox: { pending: number; deadLettered: number; oldestPendingSeconds: number | null };
  tasks: { expiredLeases: number; leased: number };
  workers: Record<string, number>;
  oldestOpenJobSeconds: number | null;
  /** Alerts are conditions an operator should look at; empty means nothing was detected, not that the system is healthy. */
  alerts: string[];
}

/** Read-only, redacted snapshot for support. Contains counts, states and ids only: no request text, payloads, secrets or file contents. */
export async function diagnosticsBundle(sql: Sql, now = new Date()): Promise<DiagnosticsBundle> {
  const applied = await appliedVersions(sql);
  const known = loadMigrations().map((m) => m.version);
  const jobs = await sql<{ state: string; n: string }[]>`SELECT state, count(*) AS n FROM jobs GROUP BY state`;
  const [ob] = await sql<{ pending: string; dead: string; oldest: Date | null }[]>`
    SELECT count(*) FILTER (WHERE status = 'pending') AS pending, count(*) FILTER (WHERE status = 'failed') AS dead, min(created_at) FILTER (WHERE status = 'pending') AS oldest FROM outbox`;
  const [tk] = await sql<{ expired: string; leased: string }[]>`
    SELECT count(*) FILTER (WHERE status IN ('leased','running') AND lease_expiry < ${now}) AS expired, count(*) FILTER (WHERE status IN ('leased','running')) AS leased FROM tasks`;
  const ws = await sql<{ status: string; n: string }[]>`SELECT status, count(*) AS n FROM workers GROUP BY status`;
  const [oj] = await sql<{ oldest: Date | null }[]>`SELECT min(created_at) AS oldest FROM jobs WHERE state NOT IN ('DONE','REJECTED','CANCELLED','FAILED','QUARANTINED')`;
  const secs = (d: Date | null | undefined) => (d ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000)) : null);
  const b: DiagnosticsBundle = {
    generatedAt: now.toISOString(),
    migrations: { applied, pending: known.filter((v) => !applied.includes(v)), unknownApplied: applied.filter((v) => !known.includes(v)) },
    jobsByState: Object.fromEntries(jobs.map((j) => [j.state, Number(j.n)])),
    outbox: { pending: Number(ob?.pending ?? 0), deadLettered: Number(ob?.dead ?? 0), oldestPendingSeconds: secs(ob?.oldest) },
    tasks: { expiredLeases: Number(tk?.expired ?? 0), leased: Number(tk?.leased ?? 0) },
    workers: Object.fromEntries(ws.map((w) => [w.status, Number(w.n)])),
    oldestOpenJobSeconds: secs(oj?.oldest),
    alerts: [],
  };
  if (b.outbox.deadLettered > 0) b.alerts.push(`${b.outbox.deadLettered} outbox row(s) are dead-lettered and need an operator`);
  if ((b.outbox.oldestPendingSeconds ?? 0) > 600) b.alerts.push("oldest pending outbox row is older than 10 minutes");
  if (b.tasks.expiredLeases > 0) b.alerts.push(`${b.tasks.expiredLeases} task lease(s) expired and not yet reclaimed`);
  if (b.migrations.pending.length) b.alerts.push(`pending migrations: ${b.migrations.pending.join(", ")}`);
  if (b.migrations.unknownApplied.length) b.alerts.push(`database has migrations this build does not know: ${b.migrations.unknownApplied.join(", ")}`);
  return redact(b as unknown as Record<string, unknown>) as unknown as DiagnosticsBundle;
}
