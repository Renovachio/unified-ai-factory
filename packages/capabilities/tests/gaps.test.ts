import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../db/src/testing";
import { analyzeGaps, loadSignals, normalizeIntent, recordSignal, SignalRejected, type SignalInput } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>; let org = "", other = "";
beforeAll(async () => { db = await createTestDb(); org = (await db.sql`INSERT INTO organizations (name) VALUES ('a') RETURNING id`)[0]!.id; other = (await db.sql`INSERT INTO organizations (name) VALUES ('b') RETURNING id`)[0]!.id; });
afterAll(async () => { await db.drop(); });
const sig = (o: Partial<SignalInput> & { evidence: string }): SignalInput => ({ organizationId: org, kind: "uncovered_request", intent: "Summarise this customer interview into themes", optedIn: true, anonymized: true, ...o });

describe("SAI-04 gap analyzer (T-14)", () => {
  test("intent normalisation collapses rephrasings and strips emails, urls, ids and numbers", () => {
    expect(normalizeIntent("Please summarise the customer interviews for me@corp.com 2026")).toBe(normalizeIntent("Summarising customer interview from https://x.test/abc 99"));
    expect(normalizeIntent("me@corp.com https://a.b/c 12345678 deadbeefdeadbeef")).toBe("");
  });
  test("nothing is stored without opt-in and anonymisation; the DB also refuses such rows directly", async () => {
    await expect(recordSignal(db.sql, sig({ evidence: "e", optedIn: false }))).rejects.toThrow(SignalRejected);
    await expect(recordSignal(db.sql, sig({ evidence: "e", anonymized: false }))).rejects.toMatchObject({ code: "NOT_ANONYMIZED" });
    expect((await loadSignals(db.sql, org)).length).toBe(0);
    await expect(db.sql`INSERT INTO improvement_signals (organization_id, kind, intent_key, evidence_digest, anonymized, opted_in) VALUES (${org}, 'defect', 'x', ${"sha256:" + "a".repeat(64)}, false, true)`).rejects.toThrow();
    await expect(db.sql`INSERT INTO improvement_signals (organization_id, kind, intent_key, evidence_digest, anonymized, opted_in) VALUES (${org}, 'defect', 'x', ${"sha256:" + "a".repeat(64)}, true, false)`).rejects.toThrow();
  });
  test("raw intent and evidence text are never stored; duplicate events do not flood the backlog", async () => {
    const a = await recordSignal(db.sql, sig({ evidence: "secret customer text: jane@corp.com" }));
    const b = await recordSignal(db.sql, sig({ evidence: "secret customer text: jane@corp.com", intent: "summarising interview customer themes" }));
    expect(a.recorded).toBe(true); expect(b.recorded).toBe(false); // same kind + normalised intent + evidence digest
    const rows = await db.sql`SELECT * FROM improvement_signals WHERE organization_id = ${org}`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/jane|secret customer|Summarise this/);
    await expect(db.sql`UPDATE improvement_signals SET kind = 'defect'`).rejects.toThrow();
  });
  test("a repeated uncovered request produces a discovery recommendation with representative evidence; thin evidence is no_action", async () => {
    for (let i = 0; i < 4; i++) await recordSignal(db.sql, sig({ evidence: `ev-${i}`, intent: "write a competitive analysis table", hints: { severity: "medium" } }));
    await recordSignal(db.sql, sig({ evidence: "once", intent: "convert csv to chart" }));
    const rep = analyzeGaps(await loadSignals(db.sql, org));
    const comp = rep.find((r) => r.intentKey === normalizeIntent("write a competitive analysis table"))!;
    expect(comp).toMatchObject({ cause: "missing_skill", recommendation: "discover_skill", distinctEvidence: 4, cost: "low" });
    expect(comp.representativeEvidence.length).toBeGreaterThan(0);
    expect(comp.confidence).toBeGreaterThan(0.5); expect(comp.confidence).toBeLessThan(1);
    expect(rep.find((r) => r.intentKey === normalizeIntent("convert csv to chart"))).toMatchObject({ recommendation: "no_action" });
  });
  test("a policy refusal is never mislabelled as capability absence", async () => {
    for (let i = 0; i < 5; i++) await recordSignal(db.sql, sig({ kind: "policy_refusal", evidence: `pr-${i}`, intent: "export all customer emails to external tool" }));
    const r = analyzeGaps(await loadSignals(db.sql, org)).find((x) => x.intentKey === normalizeIntent("export all customer emails to external tool"))!;
    expect(r).toMatchObject({ cause: "policy_blocked_operation", recommendation: "no_action", risk: "high" });
    expect(r.rationale).toMatch(/not a missing capability/);
  });
  test("cause taxonomy: stateful multi-step => agent; missing connector => workflow; unqualified model and inadequate data => no_action; quality on a version => revise", () => {
    const mk = (k: SignalInput["kind"], hints: NonNullable<SignalInput["hints"]>, ver: string | null = null, n = 3): ReturnType<typeof analyzeGaps> => analyzeGaps(Array.from({ length: n }, (_, i) => ({ id: `${k}${i}`, kind: k, intentKey: `i-${k}-${JSON.stringify(hints)}`, targetVersionId: ver, evidenceDigest: `d${i}`, payload: hints, occurredAt: "2026-11-01T00:00:00Z" })));
    expect(mk("uncovered_request", { multiStep: true })[0]).toMatchObject({ cause: "missing_agent", recommendation: "create_agent", cost: "high" });
    expect(mk("missing_tool", { missingConnector: "jira" })[0]).toMatchObject({ cause: "missing_connector", recommendation: "revise_workflow" });
    expect(mk("uncovered_request", { unqualifiedModel: true })[0]).toMatchObject({ cause: "unqualified_model", recommendation: "no_action" });
    expect(mk("low_quality", { inadequateData: true })[0]).toMatchObject({ cause: "inadequate_data", recommendation: "no_action" });
    expect(mk("user_correction", {}, "ver-1")[0]).toMatchObject({ cause: "quality_gap", recommendation: "revise_skill", targetVersionId: "ver-1" });
  });
  test("signals are tenant-scoped", async () => {
    await recordSignal(db.sql, sig({ organizationId: other, evidence: "o1", intent: "other tenant thing" }));
    expect((await loadSignals(db.sql, other)).map((s) => s.intentKey)).toEqual([normalizeIntent("other tenant thing")]);
    expect((await loadSignals(db.sql, org)).some((s) => s.intentKey === normalizeIntent("other tenant thing"))).toBe(false);
  });
});
