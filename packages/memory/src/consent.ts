import type { Q, Sql } from "@factory/db";
import { APPROVER_ROLES, MemoryError } from "./domain";
import { type Actor, requireActor, requireProject } from "./lifecycle";

/**
 * Project telemetry consent for memory feedback signals (MEM-06). Only an approver or admin may change it. The setting is append-only:
 * the latest row is current, and no row means NOT opted in. Feedback reads this setting itself; callers cannot assert consent.
 */
export async function setTelemetryConsent(sql: Sql, actor: Actor, projectId: string, optedIn: boolean, reason: string): Promise<void> {
  if (!reason.trim() || reason.length > 500) throw new MemoryError("INVALID_CLAIM", "a consent change needs a reason of at most 500 characters");
  await sql.begin(async (tx) => {
    await requireActor(tx, actor, APPROVER_ROLES);
    await requireProject(tx, actor.organizationId, projectId);
    await tx`INSERT INTO memory_telemetry_consent (organization_id, project_id, opted_in, granted_by, reason)
      VALUES (${actor.organizationId}, ${projectId}, ${optedIn}, ${actor.userId}, ${reason})`;
  });
}

export async function telemetryOptedIn(q: Q, organizationId: string, projectId: string): Promise<boolean> {
  const [r] = await q<{ opted_in: boolean }[]>`SELECT opted_in FROM memory_telemetry_consent
    WHERE organization_id = ${organizationId} AND project_id = ${projectId} ORDER BY seq DESC LIMIT 1`;
  return r?.opted_in === true;
}
