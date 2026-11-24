/** Per-key token bucket (in-memory; one bucket per actor). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly capacity: number, private readonly refillPerSec: number, private readonly now: () => number = Date.now) {}
  /** Returns 0 when allowed, otherwise the seconds to wait. */
  take(key: string): number {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    if (b.tokens >= 1) { b.tokens -= 1; this.buckets.set(key, b); return 0; }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerSec));
  }
}
