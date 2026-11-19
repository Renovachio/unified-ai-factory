import { ApiError, type FeedEvent, type JobView, type Snapshot, type Summary } from "./contracts";

export interface SyncTransport {
  snapshot(): Promise<Snapshot>;
  stream(cursor: number, signal: AbortSignal): AsyncIterable<FeedEvent>;
  /** Authoritative single-job read, used after events hint that a job changed. */
  job(id: string): Promise<{ id: string; state: string; version: number }>;
}
export type SyncStatus = "idle" | "connecting" | "live" | "reconnecting" | "stopped" | "auth-failed";
export interface SyncState { status: SyncStatus; cursor: number; jobs: Map<string, JobView>; summary: Summary | null; reconnects: number; reconciliations: number; lastError: string | null }
export interface SyncOptions { baseMs?: number; maxMs?: number; random?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; onChange?: (s: SyncState) => void; maxSeen?: number }

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => { const t = setTimeout(res, ms); signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });

/**
 * Keeps one authoritative view in sync for the terminal, dashboard or menu bar. Events are HINTS: job state only ever changes from server snapshots or authoritative
 * job reads (never derived client-side). Duplicates (by event id) and old per-job sequences are ignored; a per-job sequence gap triggers a snapshot reconciliation;
 * connection loss reconnects with capped exponential backoff + jitter from the last cursor; an authentication failure stops (no retry storm).
 */
export class SyncEngine {
  readonly state: SyncState = { status: "idle", cursor: 0, jobs: new Map(), summary: null, reconnects: 0, reconciliations: 0, lastError: null };
  private readonly seen = new Set<string>(); private readonly lastSeq = new Map<string, number>(); private ac: AbortController | null = null; private done: Promise<void> = Promise.resolve();
  private needReconcile = false;
  constructor(private readonly t: SyncTransport, private readonly o: SyncOptions = {}) {}
  private emit() { this.o.onChange?.(this.state); }
  private set(status: SyncStatus, err?: string) { this.state.status = status; if (err !== undefined) this.state.lastError = err; this.emit(); }

  start(): void { if (this.ac) return; this.ac = new AbortController(); this.done = this.run(this.ac.signal); }
  async stop(): Promise<void> { this.ac?.abort(); await this.done; this.ac = null; this.set("stopped"); }

  /** Replace the view with an authoritative snapshot (never lets an older job revision overwrite a newer one). */
  async reconcile(): Promise<void> {
    const snap = await this.t.snapshot(); this.state.reconciliations++;
    const next = new Map<string, JobView>();
    for (const j of snap.jobs) { const cur = this.state.jobs.get(j.id); next.set(j.id, cur && cur.revision > j.revision ? cur : j); }
    this.state.jobs = next; this.state.summary = snap.summary; this.state.cursor = Math.max(this.state.cursor, snap.cursor);
    this.lastSeq.clear(); this.needReconcile = false; // per-job tracking restarts from the snapshot
    this.emit();
  }

  /** Applies one event; returns true if it changed anything we track. Exposed for tests and for transports that push events. */
  async apply(e: FeedEvent): Promise<boolean> {
    if (this.seen.has(e.eventId)) return false;
    this.seen.add(e.eventId); const cap = this.o.maxSeen ?? 10_000; if (this.seen.size > cap) this.seen.delete(this.seen.values().next().value as string);
    this.state.cursor = Math.max(this.state.cursor, e.globalSeq);
    const last = this.lastSeq.get(e.jobId);
    if (last !== undefined && e.sequence <= last) return false;          // old / already reflected
    if (last !== undefined && e.sequence > last + 1) this.needReconcile = true; // a hole: something was missed or reordered
    this.lastSeq.set(e.jobId, e.sequence);
    if (this.needReconcile) { await this.reconcile(); return true; }
    try { const j = await this.t.job(e.jobId); const cur = this.state.jobs.get(e.jobId); if (cur && j.version >= cur.revision) this.state.jobs.set(e.jobId, { ...cur, state: j.state, revision: j.version }); else if (!cur) this.needReconcile = true; } catch { this.needReconcile = true; }
    if (this.needReconcile) await this.reconcile(); else this.emit();
    return true;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const base = this.o.baseMs ?? 500, max = this.o.maxMs ?? 15_000, rnd = this.o.random ?? Math.random, sleep = this.o.sleep ?? defaultSleep; let failures = 0;
    while (!signal.aborted) {
      try {
        this.set(this.state.reconnects === 0 ? "connecting" : "reconnecting");
        await this.reconcile(); // snapshot first: the cursor it carries precedes its rows, so nothing between is lost
        const conn = new AbortController(); signal.addEventListener("abort", () => conn.abort(), { once: true });
        this.set("live"); failures = 0;
        for await (const e of this.t.stream(this.state.cursor, conn.signal)) { if (signal.aborted) break; await this.apply(e); }
        if (signal.aborted) break;
        this.state.reconnects++; // the stream ended cleanly (server restart / proxy timeout): reconnect
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) { this.set("auth-failed", err.message); return; }
        this.state.reconnects++; failures++; this.set("reconnecting", (err as Error).message);
      }
      const delay = Math.min(max, base * 2 ** Math.min(failures, 10)) * (0.5 + rnd() / 2);
      await sleep(delay, signal);
    }
  }
}
