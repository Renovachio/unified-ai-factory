import type { CloudConfig } from "./config";

export type QuotaDecision = { ok: true; reservationId: string } | { ok: false; reason: "concurrency" | "daily-seconds" | "wall-time" | "memory" | "cpu" | "disk" };

export interface ResourceRequest { wallSeconds: number; memoryMb: number; cpuCores: number; diskMb: number }

/** Infrastructure (not model) limits for cloud sandboxes: concurrency, wall time, per-sandbox resources, daily sandbox-seconds. */
export class QuotaLedger {
  private readonly active = new Map<string, { startedMs: number; ttlMs: number; wallSeconds: number }>();
  private daily: { day: string; seconds: number } = { day: "", seconds: 0 };
  private n = 0;
  constructor(private readonly limits: CloudConfig["limits"], private readonly now: () => number = Date.now) {}

  private sweep() { const t = this.now(); for (const [id, r] of this.active) if (t - r.startedMs > r.ttlMs) this.active.delete(id); } // leaked reservations expire
  private day() { return new Date(this.now()).toISOString().slice(0, 10); }

  reserve(r: ResourceRequest): QuotaDecision {
    this.sweep();
    const L = this.limits;
    if (r.wallSeconds > L.maxWallSecondsPerSandbox) return { ok: false, reason: "wall-time" };
    if (r.memoryMb > L.maxMemoryMb) return { ok: false, reason: "memory" };
    if (r.cpuCores > L.maxCpuCores) return { ok: false, reason: "cpu" };
    if (r.diskMb > L.maxDiskMb) return { ok: false, reason: "disk" };
    if (this.active.size >= L.maxConcurrentSandboxes) return { ok: false, reason: "concurrency" };
    if (this.daily.day !== this.day()) this.daily = { day: this.day(), seconds: 0 };
    if (this.daily.seconds + r.wallSeconds > L.maxSandboxSecondsPerDay) return { ok: false, reason: "daily-seconds" };
    const id = `res_${++this.n}`;
    this.active.set(id, { startedMs: this.now(), ttlMs: L.sandboxTtlSeconds * 1000, wallSeconds: r.wallSeconds });
    this.daily.seconds += r.wallSeconds;
    return { ok: true, reservationId: id };
  }
  /** Release and account the time actually used (refunding the unused part of the reservation). */
  release(id: string, usedSeconds: number): void {
    const r = this.active.get(id);
    if (!r) return;
    this.active.delete(id);
    this.daily.seconds = Math.max(0, this.daily.seconds - Math.max(0, r.wallSeconds - usedSeconds));
  }
  get activeCount() { this.sweep(); return this.active.size; }
  get usedSecondsToday() { return this.daily.day === this.day() ? this.daily.seconds : 0; }
}
