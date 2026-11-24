import { digestOf, redact } from "@factory/telemetry";
import type { FactoryEvent } from "@factory/contracts";
import type { Sql } from "./client";

/** A transaction handle or the pool; both support tagged templates. */
export type Q = Sql | Parameters<Parameters<Sql["begin"]>[1]>[0];

export interface AppendEventInput {
  jobId: string;
  type: string;
  source: string;
  actorId?: string | null;
  payload?: Record<string, unknown>;
  attempt?: number;
  fencingToken?: number;
  /** Outbox destinations to fan out to (one row each, deduped on (destination, dedupeKey)). */
  destinations?: string[];
  dedupeKey?: string;
}

export interface StoredEvent {
  id: string;
  jobId: string;
  sequence: number;
  type: string;
  source: string;
  actorId: string | null;
  attempt: number;
  fencingToken: number;
  payload: Record<string, unknown>;
  digest: string;
  createdAt: Date;
}

/**
 * Append an event inside the caller's transaction. The per-job sequence is allocated by incrementing
 * jobs.event_seq under the job row lock, so sequences are contiguous and commit-ordered; if the
 * surrounding transaction rolls back, the sequence is released with it (no holes).
 */
export async function appendEvent(tx: Q, input: AppendEventInput): Promise<StoredEvent> {
  const q = tx as Sql;
  const payload = redact(input.payload ?? {});
  const [seqRow] = await q<{ event_seq: string }[]>`UPDATE jobs SET event_seq = event_seq + 1 WHERE id = ${input.jobId} RETURNING event_seq`;
  if (!seqRow) throw new Error(`appendEvent: unknown job ${input.jobId}`);
  const sequence = Number(seqRow.event_seq);
  const attempt = input.attempt ?? 1;
  const fencingToken = input.fencingToken ?? 0;
  const digest = digestOf({ jobId: input.jobId, sequence, type: input.type, source: input.source, actor: input.actorId ?? null, attempt, fencingToken, payload });
  const [row] = await q<{ id: string; created_at: Date }[]>`
    INSERT INTO events (job_id, sequence, type, source, actor_id, attempt, fencing_token, payload_redacted, digest)
    VALUES (${input.jobId}, ${sequence}, ${input.type}, ${input.source}, ${input.actorId ?? null}, ${attempt}, ${fencingToken}, ${q.json(payload as never)}, ${digest})
    RETURNING id, created_at`;
  if (!row) throw new Error("appendEvent: insert returned no row");
  for (const destination of input.destinations ?? ["sse"]) {
    await q`INSERT INTO outbox (event_id, destination, dedupe_key) VALUES (${row.id}, ${destination}, ${input.dedupeKey ?? `${input.jobId}:${sequence}`})
      ON CONFLICT (destination, dedupe_key) DO NOTHING`;
  }
  return { id: row.id, jobId: input.jobId, sequence, type: input.type, source: input.source, actorId: input.actorId ?? null, attempt, fencingToken, payload, digest, createdAt: row.created_at };
}

interface EventRow {
  id: string; job_id: string; sequence: string; type: string; source: string; actor_id: string | null;
  attempt: number; fencing_token: string; payload_redacted: Record<string, unknown>; digest: string; created_at: Date;
}
const toStored = (r: EventRow): StoredEvent => ({
  id: r.id, jobId: r.job_id, sequence: Number(r.sequence), type: r.type, source: r.source, actorId: r.actor_id,
  attempt: r.attempt, fencingToken: Number(r.fencing_token), payload: r.payload_redacted, digest: r.digest, createdAt: r.created_at,
});

export async function readEvents(sql: Q, jobId: string, afterSequence = 0, limit = 100): Promise<StoredEvent[]> {
  const q = sql as Sql;
  const rows = await q<EventRow[]>`SELECT id, job_id, sequence, type, source, actor_id, attempt, fencing_token, payload_redacted, digest, created_at
    FROM events WHERE job_id = ${jobId} AND sequence > ${afterSequence} ORDER BY sequence ASC LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
  return rows.map(toStored);
}

/** Public envelope validated against CONTRACTS/event.schema.json. */
export function toEnvelope(e: StoredEvent): FactoryEvent {
  return {
    schema_version: "1.0", event_id: e.id, job_id: e.jobId, attempt: e.attempt, fencing_token: e.fencingToken,
    sequence: e.sequence, timestamp: e.createdAt.toISOString(), type: e.type, payload: e.payload,
  };
}
