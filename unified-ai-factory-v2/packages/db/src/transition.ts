import { assertAllowedTransition, type JobState } from "@factory/domain";
import { digestOf } from "@factory/telemetry";
import type { Sql } from "./client";
import { appendEvent, type Q } from "./events";

export class ConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`version conflict: expected ${expected}, found ${actual}`);
    this.name = "ConflictError";
  }
}

export interface JobRow {
  id: string;
  state: JobState;
  version: number;
  risk: string;
  headSha: string | null;
  baseSha: string | null;
}

export interface TransitionInput {
  jobId: string;
  expectedVersion: number;
  next: JobState;
  actor: string;
  evidence?: Record<string, unknown>;
  /** Extra invariant guard evaluated inside the transaction (receives the locked row). */
  guard?: (job: JobRow, tx: Q) => void | Promise<void>;
  reason?: string;
}

/**
 * The single sanctioned way to advance a job. Locks the row, checks optimistic version, legality and guards,
 * then writes job state, transition history, event, outbox and audit entry atomically.
 */
export async function transitionJob(sql: Sql, input: TransitionInput): Promise<{ version: number; eventSequence: number }> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; state: JobState; version: number; risk: string; head_sha: string | null; base_sha: string | null; org: string | null }[]>`
      SELECT j.id, j.state, j.version, j.risk, j.head_sha, j.base_sha, r.organization_id AS org
      FROM jobs j JOIN repositories r ON r.id = j.repository_id WHERE j.id = ${input.jobId} FOR UPDATE OF j`;
    if (!row) throw new Error(`unknown job ${input.jobId}`);
    if (row.version !== input.expectedVersion) throw new ConflictError(input.expectedVersion, row.version);
    assertAllowedTransition(row.state, input.next);
    await input.guard?.({ id: row.id, state: row.state, version: row.version, risk: row.risk, headSha: row.head_sha, baseSha: row.base_sha }, tx);
    const version = row.version + 1;
    const evidenceDigest = digestOf(input.evidence ?? {});
    await tx`UPDATE jobs SET state = ${input.next}, version = ${version} WHERE id = ${input.jobId}`;
    await tx`INSERT INTO job_transitions (job_id, from_state, to_state, version, actor_id, evidence_digest)
      VALUES (${input.jobId}, ${row.state}, ${input.next}, ${version}, ${input.actor}, ${evidenceDigest})`;
    const ev = await appendEvent(tx, {
      jobId: input.jobId, type: "job.transitioned", source: "orchestrator", actorId: input.actor,
      payload: { from: row.state, to: input.next, version, evidence_digest: evidenceDigest, ...(input.reason ? { reason: input.reason } : {}) },
      dedupeKey: `${input.jobId}:${version}:${input.next}`,
    });
    await tx`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest)
      VALUES (${row.org}, ${input.actor}, 'job.transition', ${`job:${input.jobId}`}, 'ok', ${input.reason ?? null}, ${digestOf({ job: input.jobId, from: row.state, to: input.next, version })})`;
    return { version, eventSequence: ev.sequence };
  });
}
