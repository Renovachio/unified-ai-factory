import type { Sql } from "@factory/db";
import { MemoryError, STEWARD_ROLES } from "./domain";
import { type Actor, eraseMemory, type MemoryView, requireActor, requireProject } from "./lifecycle";
import type { PackTextStore } from "./context";

/**
 * Retention policy (operator decision, MEM-05): proposed memories are erased after 90 days and rejected after 30 days.
 * Pack text (the rendered context that copies memory claims) is erased after 30 days. APPROVED memory never expires
 * automatically; it is erased only through an explicit steward erasure.
 * Erasure runs as a named steward, so every erasure is attributed in the transition record and tombstone.
 */
export const RETENTION_DAYS = { proposed: 90, rejected: 30, packText: 30 } as const;

const DAY_MS = 86_400_000;

export interface RetentionReport {
  erasedProposed: number;
  erasedRejected: number;
  packTextsDeleted: number;
}

/**
 * Erases one memory: its content and index row (via eraseMemory), then the text of every stored context pack that selected it.
 * Pack rows keep only ids and digests, so they remain as an audit trail; their text becomes unresolvable (PACK_NOT_FOUND).
 * Idempotent: a retry after a failed blob deletion finds the same packs again.
 */
export async function eraseMemoryText(sql: Sql, store: PackTextStore, actor: Actor, projectId: string, memoryId: string, reason: string): Promise<{ memory: MemoryView; packTextsDeleted: number }> {
  const memory = await eraseMemory(sql, actor, projectId, memoryId, reason);
  const packs = await sql<{ rendered_digest: string }[]>`
    SELECT rendered_digest FROM context_packs
    WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId}
      AND manifest->'selected' @> jsonb_build_array(jsonb_build_object('memoryId', ${memoryId}::text))`;
  let deleted = 0;
  for (const p of packs) if (store.delete(p.rendered_digest)) deleted++;
  return { memory, packTextsDeleted: deleted };
}

/** Applies the retention policy to one project. Requires a steward. Safe to run repeatedly. */
export async function runRetention(sql: Sql, store: PackTextStore, actor: Actor, projectId: string, now: Date = new Date()): Promise<RetentionReport> {
  const cut = (days: number) => new Date(now.getTime() - days * DAY_MS);
  try {
    return await sql.begin(async (tx) => {
      await requireActor(tx, actor, STEWARD_ROLES);
      await requireProject(tx, actor.organizationId, projectId);
      const proposed = await tx<{ id: string }[]>`SELECT id FROM memory_records
        WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId} AND status = 'proposed' AND created_at < ${cut(RETENTION_DAYS.proposed)}`;
      const rejected = await tx<{ id: string }[]>`SELECT id FROM memory_records
        WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId} AND status = 'rejected' AND updated_at < ${cut(RETENTION_DAYS.rejected)}`;
      const report: RetentionReport = { erasedProposed: 0, erasedRejected: 0, packTextsDeleted: 0 };
      for (const r of proposed) {
        await eraseMemoryText(tx as unknown as Sql, store, actor, projectId, r.id, "retention: proposed memory older than 90 days");
        report.erasedProposed++;
      }
      for (const r of rejected) {
        await eraseMemoryText(tx as unknown as Sql, store, actor, projectId, r.id, "retention: rejected memory older than 30 days");
        report.erasedRejected++;
      }
      const old = await tx<{ rendered_digest: string }[]>`SELECT rendered_digest FROM context_packs
        WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId} AND created_at < ${cut(RETENTION_DAYS.packText)}`;
      for (const p of old) if (store.delete(p.rendered_digest)) report.packTextsDeleted++;
      return report;
    }) as RetentionReport;
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError("DB_REJECTED", String((e as Error).message).slice(0, 200));
  }
}
