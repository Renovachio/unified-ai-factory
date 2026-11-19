import { randomBytes } from "node:crypto";
import { redact } from "./redact";
import { stripBillingKeys } from "./logger";

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
}

export type SpanExporter = (span: SpanRecord) => void;

/**
 * Minimal tracer (OpenTelemetry-shaped IDs/fields). Attributes are redacted and billing-style keys are removed at span END, so nothing
 * sensitive or price-related can reach an exporter regardless of what callers attach.
 */
export class Tracer {
  constructor(private readonly exporter: SpanExporter, private readonly now: () => number = Date.now) {}
  start(name: string, attributes: Record<string, unknown> = {}, parent?: { traceId: string; spanId: string }) {
    const traceId = parent?.traceId ?? randomBytes(16).toString("hex");
    const spanId = randomBytes(8).toString("hex");
    const startMs = this.now();
    const attrs: Record<string, unknown> = { ...attributes };
    let ended = false;
    return {
      traceId, spanId,
      set: (k: string, v: unknown) => { attrs[k] = v; },
      end: (status: "ok" | "error" = "ok") => {
        if (ended) return;
        ended = true;
        this.exporter({ traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}), name, startMs, endMs: this.now(), status, attributes: stripBillingKeys(redact(attrs)) });
      },
    };
  }
  async span<T>(name: string, attrs: Record<string, unknown>, fn: (s: { set: (k: string, v: unknown) => void; traceId: string; spanId: string }) => Promise<T>, parent?: { traceId: string; spanId: string }): Promise<T> {
    const s = this.start(name, attrs, parent);
    try { const r = await fn(s); s.end("ok"); return r; } catch (e) { s.set("error", e instanceof Error ? e.message : String(e)); s.end("error"); throw e; }
  }
}
