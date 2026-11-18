import { toEnvelope, readEvents } from "./events";
import type { Sql } from "./client";

export interface StreamOptions {
  jobId: string;
  /** Value of the Last-Event-ID header (a sequence number) or ?afterSequence. */
  lastEventId?: string | number | null;
  signal?: AbortSignal;
  pollMs?: number;
  heartbeatMs?: number;
  batch?: number;
}

export const parseCursor = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

export const formatSse = (e: { sequence: number; type: string }, data: unknown): string =>
  `id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Ordered SSE for one job: replays from the cursor, then tails. The database is authoritative; the stream
 * only ever emits rows with sequence strictly greater than the last one it emitted, so a reconnect with
 * Last-Event-ID never skips or duplicates events.
 */
export async function* eventStream(sql: Sql, opts: StreamOptions): AsyncGenerator<string> {
  let cursor = parseCursor(opts.lastEventId);
  const poll = opts.pollMs ?? 250;
  const heartbeat = opts.heartbeatMs ?? 15_000;
  let lastSent = Date.now();
  while (!opts.signal?.aborted) {
    const events = await readEvents(sql, opts.jobId, cursor, opts.batch ?? 100);
    for (const e of events) {
      yield formatSse(e, toEnvelope(e));
      cursor = e.sequence;
      lastSent = Date.now();
    }
    if (events.length > 0) continue;
    if (Date.now() - lastSent >= heartbeat) {
      yield `: keep-alive\n\n`;
      lastSent = Date.now();
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, poll);
      opts.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

export function sseResponse(sql: Sql, opts: StreamOptions): Response {
  const it = eventStream(sql, opts);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
