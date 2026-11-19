import { redact } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Keys that would turn telemetry into model-price accounting. They are dropped, not logged (SECURITY.md / blueprint: no token-cost metrics). */
const FORBIDDEN_METRIC_KEY = /(usd|dollar|price|pricing|cost|invoice|billed|billing_amount|spend|\bcredits?\b|per_token)/i;

export function stripBillingKeys<T>(v: T, depth = 0): T {
  if (depth > 10) return v;
  if (Array.isArray(v)) return v.map((x) => stripBillingKeys(x, depth + 1)) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (!FORBIDDEN_METRIC_KEY.test(k)) out[k] = stripBillingKeys(val, depth + 1);
    return out as T;
  }
  return v;
}

export interface LogSink { (line: string): void }

/** Structured JSON logger: every record is redacted and stripped of billing-style fields before it is written. */
export function createLogger(sink: LogSink, base: Record<string, unknown> = {}) {
  const emit = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    const rec = stripBillingKeys(redact({ ts: new Date().toISOString(), level, msg, ...base, ...fields }));
    sink(JSON.stringify(rec));
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
    child: (more: Record<string, unknown>) => createLogger(sink, { ...base, ...more }),
  };
}
