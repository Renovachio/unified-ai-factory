import { describe, expect, test } from "bun:test";
import { createLogger, stripBillingKeys, Tracer, type SpanRecord } from "./index";

describe("structured logging", () => {
  test("records are redacted and billing-style fields are dropped", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), { svc: "api" });
    log.info("call", { authorization: "Bearer abcdefgh12345678", note: "key sk-abcdefghijklmnop12345", cost_usd: 1.2, tokenPrice: 3, nested: { invoice_id: "x", fine: 1, apiKey: "zzz" } });
    const out = lines[0] as string;
    for (const bad of ["abcdefgh12345678", "sk-abcdefghijklmnop12345", "cost_usd", "tokenPrice", "invoice_id", "zzz"]) expect(out).not.toContain(bad);
    expect(JSON.parse(out)).toMatchObject({ svc: "api", level: "info", msg: "call", nested: { fine: 1 } });
    const child: string[] = [];
    createLogger((l) => child.push(l)).child({ job: "j1" }).warn("x");
    expect(JSON.parse(child[0] as string)).toMatchObject({ job: "j1", level: "warn" });
  });
  test("stripBillingKeys only removes monetary keys", () => {
    expect(stripBillingKeys<Record<string, number>>({ tokens_in: 5, cost: 1, price_per_token: 2, runs: 3, spend: 1, credits: 4 })).toEqual({ tokens_in: 5, runs: 3 });
  });
});

describe("tracing", () => {
  test("spans carry ids/parentage and are redacted at export", async () => {
    const spans: SpanRecord[] = [];
    let t = 1000;
    const tr = new Tracer((s) => spans.push(s), () => (t += 10));
    const root = tr.start("job", { jobId: "j1", token: "ghp_abcdefghijklmnopqrstuvwxyz0123", estimated_cost_usd: 9 });
    await tr.span("stage", { role: "builder", password: "p" }, async () => undefined, root);
    await expect(tr.span("boom", {}, async () => { throw new Error("with sk-abcdefghijklmnop12345"); }, root)).rejects.toThrow();
    root.end(); root.end(); // idempotent
    expect(spans.map((s) => s.name)).toEqual(["stage", "boom", "job"]);
    expect(spans[0]).toMatchObject({ parentSpanId: root.spanId, traceId: root.traceId, status: "ok" });
    expect(spans[1]!.status).toBe("error");
    const all = JSON.stringify(spans);
    for (const bad of ["ghp_", "sk-abcdefghijklmnop12345", "estimated_cost_usd", "\"p\""]) expect(all).not.toContain(bad);
    expect(spans[2]!.endMs).toBeGreaterThan(spans[2]!.startMs);
  });
});
