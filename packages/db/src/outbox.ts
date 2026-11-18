import type { Sql } from "./client";

export interface OutboxItem {
  outboxId: string;
  eventId: string;
  jobId: string;
  sequence: number;
  type: string;
  attempts: number;
}

export interface DeliveryResult {
  delivered: number;
  failed: number;
}

const backoffSeconds = (attempts: number) => Math.min(300, 2 ** Math.min(attempts, 8));

/**
 * At-least-once delivery. Claimed rows are locked (FOR UPDATE SKIP LOCKED) for the duration of the
 * handler; if the consumer dies mid-batch the transaction aborts and every row stays pending for redelivery.
 * Items are delivered in sequence order per job. A handler failure schedules a retry with exponential
 * backoff and blocks later events of that job until it succeeds, preserving per-job ordering.
 */
export async function deliverOutbox(
  sql: Sql,
  opts: { destination: string; handler: (item: OutboxItem) => Promise<void>; limit?: number; now?: Date },
): Promise<DeliveryResult> {
  const result: DeliveryResult = { delivered: 0, failed: 0 };
  const now = opts.now ?? new Date();
  await sql.begin(async (tx) => {
    // The per-(job,destination) advisory lock serialises consumers on one job so ordering holds across
    // concurrent consumers; row locks (SKIP LOCKED) keep different jobs parallel.
    const rows = await tx<{ id: string; event_id: string; job_id: string; sequence: string; type: string; attempts: number; retry_after: Date | null }[]>`
      SELECT o.id, o.event_id, e.job_id, e.sequence, e.type, o.attempts, o.retry_after
      FROM outbox o JOIN events e ON e.id = o.event_id
      WHERE o.destination = ${opts.destination} AND o.status = 'pending'
        AND pg_try_advisory_xact_lock(hashtext(e.job_id::text || o.destination))
      ORDER BY e.job_id, e.sequence
      LIMIT ${opts.limit ?? 100}
      FOR UPDATE OF o SKIP LOCKED`;
    const blockedJobs = new Set<string>();
    const started = new Set<string>();
    for (const r of rows) {
      if (blockedJobs.has(r.job_id)) continue;
      // The head of each job's pending queue gates the rest: if it is still backing off, nothing behind it may go.
      if (!started.has(r.job_id)) {
        started.add(r.job_id);
        if (r.retry_after && r.retry_after > now) { blockedJobs.add(r.job_id); continue; }
      }
      try {
        await opts.handler({ outboxId: r.id, eventId: r.event_id, jobId: r.job_id, sequence: Number(r.sequence), type: r.type, attempts: r.attempts });
        await tx`UPDATE outbox SET status = 'delivered', attempts = attempts + 1 WHERE id = ${r.id}`;
        result.delivered++;
      } catch {
        const next = new Date(now.getTime() + backoffSeconds(r.attempts + 1) * 1000);
        await tx`UPDATE outbox SET attempts = attempts + 1, retry_after = ${next} WHERE id = ${r.id}`;
        blockedJobs.add(r.job_id);
        result.failed++;
      }
    }
  });
  return result;
}

/** Consumer-side idempotency: ignores events at or below the last processed sequence per job. */
export class DedupingConsumer {
  private readonly last = new Map<string, number>();
  constructor(private readonly handle: (item: OutboxItem) => Promise<void>) {}
  readonly seen: OutboxItem[] = [];
  async receive(item: OutboxItem): Promise<boolean> {
    if (item.sequence <= (this.last.get(item.jobId) ?? 0)) return false;
    await this.handle(item);
    this.last.set(item.jobId, item.sequence);
    this.seen.push(item);
    return true;
  }
}
