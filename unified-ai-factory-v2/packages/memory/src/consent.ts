import type { Q, Sql } from "@factory/db";
import { APPROVER_ROLES, MemoryError } from "./domain";
import { type Actor, requireActor, requireProject } from "./lifecycle";

/**
 * Project telemetry consent for memory feedback signals (MEM-06). Only an approver or admin may change it: the application checks the
 * role, and migrations 0034/0035 make the database check that the recorded granter is an enabled approver or admin of the organization.
 * The database cannot tell which person is connected; that identity is passed in by the application (see the evidence file).
 * Known limit: the guard reads the granter without a lock. Taking a row lock on users needs UPDATE privilege, which the control role
 * must not have, so a demotion committing during the insert is not seen. Consent rows are append-only; the remedy is a consent-off row.
 * The setting is append-only: the latest row is current, and no row means NOT opted in.
 *
 * Concurrency uses a transaction advisory lock, which ordinary project writes (foreign-key inserts, updates) do not take:
 *  - a send takes the SHARE lock and holds it for its transaction, so consent cannot change under it;
 *  - a change tries the EXCLUSIVE lock without waiting, so it fails at once (retry later) while a send is in progress.
 */
const lockKey = (projectId: string) => `memory-consent:${projectId}`;

export async function setTelemetryConsent(sql: Sql, actor: Actor, projectId: string, optedIn: boolean, reason: string): Promise<void> {
  if (!reason.trim() || reason.length > 500) throw new MemoryError("INVALID_CLAIM", "a consent change needs a reason of at most 500 characters");
  try {
    await sql.begin(async (tx) => {
      await requireActor(tx, actor, APPROVER_ROLES);
      await requireProject(tx, actor.organizationId, projectId);
      const [l] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey(projectId)})) AS ok`;
      if (!l?.ok) throw new MemoryError("DB_REJECTED", "a feedback send is in progress for this project; retry the consent change");
      await tx`INSERT INTO memory_telemetry_consent (organization_id, project_id, opted_in, granted_by, reason)
        VALUES (${actor.organizationId}, ${projectId}, ${optedIn}, ${actor.userId}, ${reason})`;
    });
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    if ((e as { code?: string }).code === "42501") throw new MemoryError("FORBIDDEN", "the database refused this consent change: the granter is not an enabled approver or admin");
    throw e;
  }
}

/** Current consent. With `lock`, a SHARE advisory lock on the project is held until the caller's transaction ends. */
export async function telemetryOptedIn(q: Q, organizationId: string, projectId: string, lock = false): Promise<boolean> {
  if (lock) await q`SELECT pg_advisory_xact_lock_shared(hashtext(${lockKey(projectId)}))`;
  const [r] = await q<{ opted_in: boolean }[]>`SELECT opted_in FROM memory_telemetry_consent
    WHERE organization_id = ${organizationId} AND project_id = ${projectId} ORDER BY seq DESC LIMIT 1`;
  return r?.opted_in === true;
}
