import type { Sql } from "@factory/db";
import { digestOf } from "@factory/telemetry";
import { MemoryError, STEWARD_ROLES } from "./domain";
import type { PackTextStore } from "./context";
import { type Actor } from "./lifecycle";
import { purgePackTextFor, runRetention } from "./retention";

export interface SweepProject { projectId: string; erasedProposed: number; erasedRejected: number; packTextsDeleted: number; repairedPackTexts: number }
export interface SweepReport { organizationId: string; steward: string; at: string; projects: SweepProject[] }

/**
 * Runs the retention policy for every project of the steward's organization. The steward is named explicitly (an enabled
 * steward user), so every erasure and the audit row name a real person. Safe to repeat: erasure is idempotent, and the repair
 * step removes pack text left behind by an erasure whose blob deletion failed.
 */
export async function runRetentionSweep(sql: Sql, store: PackTextStore, stewardUserId: string, now: Date = new Date()): Promise<SweepReport> {
  const [s] = await sql<{ organization_id: string; role: string; disabled_at: Date | null }[]>`SELECT organization_id, role, disabled_at FROM users WHERE id = ${stewardUserId}`;
  if (!s || s.disabled_at || !(STEWARD_ROLES as readonly string[]).includes(s.role)) throw new MemoryError("FORBIDDEN", "the retention steward must be an enabled steward of the organization");
  const actor: Actor = { organizationId: s.organization_id, userId: stewardUserId };
  const projectRows = await sql<{ project_id: string }[]>`SELECT DISTINCT project_id FROM memory_records WHERE organization_id = ${actor.organizationId} ORDER BY project_id`;
  const projects: SweepProject[] = [];
  for (const { project_id } of projectRows) {
    const r = await runRetention(sql, store, actor, project_id, now);
    const repaired = await repairPackText(sql, store, actor.organizationId, project_id);
    projects.push({ projectId: project_id, erasedProposed: r.erasedProposed, erasedRejected: r.erasedRejected, packTextsDeleted: r.packTextsDeleted, repairedPackTexts: repaired });
  }
  const report: SweepReport = { organizationId: actor.organizationId, steward: stewardUserId, at: now.toISOString(), projects };
  await sql`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest)
    VALUES (${actor.organizationId}, ${stewardUserId}, 'memory.retention', ${`org:${actor.organizationId}`}, 'ok', ${JSON.stringify({ projects: projects.length, erasedProposed: sum(projects, "erasedProposed"), erasedRejected: sum(projects, "erasedRejected"), packTextsDeleted: sum(projects, "packTextsDeleted") + sum(projects, "repairedPackTexts") })}, ${digestOf(report)})`;
  return report;
}

const sum = (rows: SweepProject[], k: keyof SweepProject) => rows.reduce((a, r) => a + (r[k] as number), 0);

/** Pack text that still exists for a memory that is already erased (a previous blob deletion failed). */
async function repairPackText(sql: Sql, store: PackTextStore, organizationId: string, projectId: string): Promise<number> {
  const erased = await sql<{ id: string }[]>`SELECT id FROM memory_records WHERE organization_id = ${organizationId} AND project_id = ${projectId} AND status = 'deleted'`;
  let n = 0;
  for (const m of erased) n += await purgePackTextFor(sql, store, organizationId, projectId, m.id);
  return n;
}
