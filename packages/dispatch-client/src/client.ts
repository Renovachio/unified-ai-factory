import { ApiError, OutcomeUnknown, StaleRevision, type FeedEvent, type FeedPage, type JobView, type PendingMutation, type Snapshot, type Summary } from "./contracts";
import { SseParser } from "./sse";

export interface ClientOptions {
  baseUrl: string;
  /** Supplies authentication per request: `{authorization: "Bearer …"}` for the CLI/menu bar, cookies/CSRF for a browser or the dashboard server. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Generates idempotency keys (injectable for tests). */
  newKey?: () => string;
}

export class DispatchClient {
  private readonly f: typeof fetch; private readonly timeout: number; private readonly newKey: () => string;
  constructor(private readonly o: ClientOptions) { this.f = o.fetch ?? fetch; this.timeout = o.timeoutMs ?? 10_000; this.newKey = o.newKey ?? (() => crypto.randomUUID()); }

  private async hdrs(extra: Record<string, string> = {}): Promise<Record<string, string>> { return { accept: "application/json", ...(await this.o.headers?.()), ...extra }; }
  private async parse<T>(r: Response): Promise<T> {
    const text = await r.text(); let j: Record<string, unknown> = {}; try { j = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* non-JSON error body */ }
    if (r.ok) return j as T;
    const title = String(j.title ?? r.statusText ?? "Error"); const detail = typeof j.detail === "string" ? j.detail : undefined; const code = typeof j.type === "string" ? j.type.split("/").pop() : undefined;
    if (r.status === 409 && /stale|version|revision/i.test(`${code ?? ""} ${detail ?? ""}`)) throw new StaleRevision(detail);
    throw new ApiError(r.status, title, detail, code);
  }
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const r = await this.f(`${this.o.baseUrl}${path}`, { headers: await this.hdrs(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout) });
    return this.parse<T>(r);
  }

  summary = () => this.get<Summary>("/api/v2/dispatch/summary");
  snapshot = () => this.get<Snapshot>("/api/v2/dispatch/snapshot");
  events = (cursor: number, limit = 200) => this.get<FeedPage>(`/api/v2/dispatch/events?cursor=${cursor}&limit=${limit}`);
  async job(id: string): Promise<{ id: string; state: string; version: number }> { const j = await this.get<{ id: string; state: string; version: number }>(`/api/v1/jobs/${encodeURIComponent(id)}`); return j; }

  /** A mutation carries its idempotency key from creation, so every retry of the same intent is the same request. */
  mutation(method: PendingMutation["method"], path: string, body?: unknown, opts: { expectedRevision?: number } = {}): PendingMutation {
    return { key: this.newKey(), method, path, ...(body !== undefined ? { body } : {}), ...(opts.expectedRevision !== undefined ? { expectedRevision: opts.expectedRevision } : {}), attempts: 0 };
  }
  /** Sends (or re-sends) a mutation. Network failure/timeout/5xx => `OutcomeUnknown`; call `retry(m)` with the same object. 4xx are definitive. */
  async send<T = unknown>(m: PendingMutation): Promise<T> {
    m.attempts++;
    let r: Response;
    try {
      const body = m.body !== undefined ? { ...(m.body as object), ...(m.expectedRevision !== undefined ? { expectedRevision: m.expectedRevision } : {}) } : m.expectedRevision !== undefined ? { expectedRevision: m.expectedRevision } : undefined;
      r = await this.f(`${this.o.baseUrl}${m.path}`, { method: m.method, headers: await this.hdrs({ "idempotency-key": m.key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeout) });
    } catch (e) { throw new OutcomeUnknown(m, e); }
    if (r.status >= 500) { await r.text().catch(() => ""); throw new OutcomeUnknown(m, new Error(`HTTP ${r.status}`)); }
    return this.parse<T>(r);
  }
  retry = <T = unknown>(m: PendingMutation) => this.send<T>(m);

  /** Streams feed events (SSE) from a cursor; ends when the server or network closes it (the caller reconnects). */
  async *stream(cursor: number, signal: AbortSignal): AsyncGenerator<FeedEvent> {
    const r = await this.f(`${this.o.baseUrl}/api/v2/dispatch/events/stream?cursor=${cursor}`, { headers: await this.hdrs({ accept: "text/event-stream", "last-event-id": String(cursor) }), signal });
    if (!r.ok || !r.body) { await r.text().catch(() => ""); throw new ApiError(r.status, r.statusText || "stream refused"); }
    const p = new SseParser(); const dec = new TextDecoder(); const reader = r.body.getReader();
    try { for (;;) { const { value, done } = await reader.read(); if (done) return; for (const m of p.push(dec.decode(value, { stream: true }))) { try { yield JSON.parse(m.data) as FeedEvent; } catch { /* malformed frame: skip, reconcile will repair */ } } } } finally { reader.releaseLock(); }
  }
}
export type { JobView };
