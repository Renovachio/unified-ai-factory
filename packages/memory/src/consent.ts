import type { Q, Sql } from "@factory/db";
import { APPROVER_ROLES, MemoryError } from "./domain";
import { type Actor, requireActor, requireProject } from "./lifecycle";

/**
 * Project telemetry consent for memory feedback signals (MEM-06). Only an approver or admin may change it; the database enforces
 * that too (migration 0034 guard). The setting is append-only: the latest row is current, and no row means NOT opted in.
 *
 * Concurrency: a send reads consent under a SHARE lock on the project row. A change takes the same row with NOWAIT, so a change
 * made while a send is in progress fails at once (retry later) instead of waiting on a send that may be waiting on it.
 */
export async function setTelemetryConsent(sql: Sql, actor: Actor, projectId: string, optedIn: boolean, reason: string): Promise<void> {
  if (!reason.trim() || reason.length > 500) throw new MemoryError("INVALID_CLAIM", "a consent change needs a reason of at most 500 characters");
  try {
    await sql.begin(async (tx) => {
      await requireActor(tx, actor, APPROVER_ROLES);
      await requireProject(tx, actor.organizationId, projectId);
      await tx`SELECT id FROM repositories WHERE id = ${projectId} AND organization_id = ${actor.organizationId} FOR UPDATE NOWAIT`;
      await tx`INSERT INTO memory_telemetry_consent (organization_id, project_id, opted_in, granted_by, reason)
        VALUES (${actor.organizationId}, ${projectId}, ${optedIn}, ${actor.userId}, ${reason})`;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "55P03") throw new MemoryError("DB_REJECTED", "a feedback send is in progress for this project; retry the consent change");
    throw e;
  }
}

/** Current consent. With `lock`, the project row is share-locked for the rest of the caller's transaction (see above). */
export async function telemetryOptedIn(q: Q, organizationId: string, projectId: string, lock = false): Promise<boolean> {
  if (lock) await q`SELECT id FROM repositories WHERE id = ${projectId} AND organization_id = ${organizationId} FOR SHARE`;
  const [r] = await q<{ opted_in: boolean }[]>`SELECT opted_in FROM memory_telemetry_consent
    WHERE organization_id = ${organizationId} AND project_id = ${projectId} ORDER BY seq DESC LIMIT 1`;
  return r?.opted_in === true;
}
