import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkQualification, discoverRuntimes, InferenceSourcePolicy, loadPolicyConfig, loadQualificationRegistry, selectRuntime, wilsonLower, type QualificationRecord, type RuntimeRecord, type SelectionCandidate } from "../src/index";

const CFG = join(import.meta.dir, "../../../config");
const base = loadPolicyConfig(CFG);
const reg0 = loadQualificationRegistry(CFG);
const NOW = new Date("2026-11-19T00:00:00Z");
const rec = (o: Partial<QualificationRecord> = {}): QualificationRecord => ({ adapterId: "local-model", modelId: "m", role: "builder", promptVersion: "p1", toolsetDigest: "t1", harnessVersion: "h1", datasetVersion: "d1", datasetDigest: "sha256:x", samples: 60, passes: 58, criticalMisses: 0, criticalPolicyViolations: 0, usedRealToolLoop: true, resultsPath: "evidence/x", approvedBy: "op", approvedOn: "2026-11-01", expiresOn: "2027-01-15", ...o });
const reg = (...qs: QualificationRecord[]) => ({ ...reg0, qualifications: qs });
const local: SelectionCandidate = { adapterId: "local-model", authMode: "local_model", modelId: "m", promptVersion: "p1", toolsetDigest: "t1", endpoints: ["http://127.0.0.1:11434"] };
const found = (id: string): RuntimeRecord => ({ adapterId: id, kind: "subscription_cli", found: true, executablePath: "/usr/local/bin/x", version: "1.2.3", os: "darwin-arm64", capabilityFlags: [], detail: "" });
const sel = (o: Partial<Parameters<typeof selectRuntime>[0]> = {}) => selectRuntime({ role: "builder", candidates: [local], policy: new InferenceSourcePolicy(base), qualification: reg(rec()), env: {}, sandboxEnforced: true, now: NOW, ...o });

describe("qualification", () => {
  test("shipped registry is empty: nothing is qualified for any critical role", () => {
    for (const role of ["builder", "review_code", "review_security", "spec"]) expect(checkQualification(reg0, { adapterId: "local-model", modelId: "m", role, promptVersion: "p1", toolsetDigest: "t1" }, NOW).ok).toBe(false);
  });
  test("a complete, current record qualifies; every shortfall is reported", () => {
    expect(checkQualification(reg(rec()), local as never, NOW)).toMatchObject({ ok: false }); // `role` missing on candidate -> not critical
    const c = { adapterId: "local-model", modelId: "m", role: "builder", promptVersion: "p1", toolsetDigest: "t1" };
    expect(checkQualification(reg(rec()), c, NOW).ok).toBe(true);
    const bad = (o: Partial<QualificationRecord>) => { const r = checkQualification(reg(rec(o)), c, NOW); return r.ok ? "" : r.reasons.join("|"); };
    expect(bad({ expiresOn: "2026-11-18" })).toMatch(/expired/);
    expect(bad({ revokedOn: "2026-11-10" })).toMatch(/revoked/);
    expect(bad({ samples: 10, passes: 10 })).toMatch(/only 10 samples/);
    expect(bad({ passes: 50 })).toMatch(/acceptance 0\.833 < 0\.9/);
    expect(bad({ criticalMisses: 1 })).toMatch(/critical misses/);
    expect(bad({ criticalPolicyViolations: 1 })).toMatch(/policy violations/);
    expect(bad({ usedRealToolLoop: false })).toMatch(/real tool loop/);
    expect(bad({ expiresOn: "2027-12-31" })).toMatch(/validity exceeds 90 days/);
  });
  test("a different prompt version, tool configuration or model is a different candidate (no record, no qualification)", () => {
    const c = { adapterId: "local-model", modelId: "m", role: "builder", promptVersion: "p1", toolsetDigest: "t1" };
    for (const o of [{ promptVersion: "p2" }, { toolsetDigest: "t2" }, { modelId: "m2" }, { adapterId: "claude-code" }]) expect(checkQualification(reg(rec()), { ...c, ...o }, NOW).ok).toBe(false);
  });
  test("Wilson bound reflects sample size; the security reviewer needs 95%", () => {
    expect(wilsonLower(30, 30)).toBeLessThan(wilsonLower(300, 300));
    const c = { adapterId: "local-model", modelId: "m", role: "review_security", promptVersion: "p1", toolsetDigest: "t1" };
    expect(checkQualification(reg(rec({ role: "review_security", samples: 100, passes: 94 })), c, NOW).ok).toBe(false);
    expect(checkQualification(reg(rec({ role: "review_security", samples: 100, passes: 97 })), c, NOW).ok).toBe(true);
  });
});

describe("runtime selection: ordered checks with reason codes and no silent fallback", () => {
  test("qualified local runtime is selected and the decision is logged", () => {
    const d = sel();
    expect(d.selected?.adapterId).toBe("local-model");
    expect(d.log.at(-1)).toMatch(/selected for builder/);
  });
  test("no candidates -> RUNTIME_UNAVAILABLE; missing CLI -> RUNTIME_UNAVAILABLE", () => {
    expect(sel({ candidates: [] }).blockReason).toBe("RUNTIME_UNAVAILABLE");
    const cli: SelectionCandidate = { ...local, adapterId: "claude-code", authMode: "subscription_cli", endpoints: [], discovered: { ...found("claude-code"), found: false } };
    expect(sel({ candidates: [cli] }).blockReason).toBe("RUNTIME_UNAVAILABLE");
  });
  test("subscription CLI without a provider-terms approval -> PROVIDER_NOT_APPROVED (even when qualified)", () => {
    const cli: SelectionCandidate = { adapterId: "claude-code", authMode: "subscription_cli", modelId: "m", promptVersion: "p1", toolsetDigest: "t1", discovered: found("claude-code") };
    const d = sel({ candidates: [cli], qualification: reg(rec({ adapterId: "claude-code" })) });
    expect(d.selected).toBeNull();
    expect(d.blockReason).toBe("PROVIDER_NOT_APPROVED");
  });
  test("unqualified model for a critical role -> MODEL_NOT_QUALIFIED; non-critical roles need no record", () => {
    expect(sel({ qualification: reg0 }).blockReason).toBe("MODEL_NOT_QUALIFIED");
    expect(sel({ role: "analyst", qualification: reg0 }).selected).not.toBeNull();
  });
  test("metered credentials, base-URL overrides and metered endpoints -> INFERENCE_POLICY_DENIED", () => {
    expect(sel({ env: { OPENAI_API_KEY: "x" } }).blockReason).toBe("INFERENCE_POLICY_DENIED");
    expect(sel({ candidates: [{ ...local, endpoints: ["https://api.anthropic.com"] }] }).blockReason).toBe("INFERENCE_POLICY_DENIED");
  });
  test("sandbox not enforced -> SANDBOX_NOT_ENFORCED (fail closed)", () => {
    expect(sel({ sandboxEnforced: false }).blockReason).toBe("SANDBOX_NOT_ENFORCED");
  });
  test("an unqualified first candidate never silently falls back to a weaker one; only a qualified later candidate can win", () => {
    const weak = { ...local, modelId: "weak" };
    const d = sel({ candidates: [weak, local] });
    expect(d.selected?.modelId).toBe("m");
    expect(d.log[0]).toMatch(/weak: MODEL_NOT_QUALIFIED/);
    expect(sel({ candidates: [weak] }).selected).toBeNull();
  });
});

describe("discovery (RT-01)", () => {
  test("finds installed binaries with absolute path, version and OS; a missing one is reported, never guessed", () => {
    const r = discoverRuntimes({ known: [{ adapterId: "sh", kind: "local_engine", binary: "sh", versionArgs: ["-c", "echo tool 9.8.7"], capabilityFlags: ["x"] }, { adapterId: "nope", kind: "subscription_cli", binary: "definitely-not-installed-xyz", versionArgs: ["--version"], capabilityFlags: [] }] });
    expect(r[0]).toMatchObject({ found: true, version: "9.8.7", capabilityFlags: ["x"] });
    expect(r[0]!.executablePath).toMatch(/^\//);
    expect(r[1]).toMatchObject({ found: false });
  });
  test("version probes run with a scrubbed environment (no credentials reach the child)", () => {
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    try {
      const r = discoverRuntimes({ known: [{ adapterId: "env", kind: "local_engine", binary: "sh", versionArgs: ["-c", "echo v1.0.0 ${OPENAI_API_KEY:-clean}"], capabilityFlags: [] }] });
      expect(r[0]!.detail).toContain("clean");
      expect(r[0]!.detail).not.toContain("sk-");
    } finally { delete process.env.OPENAI_API_KEY; }
  });
});
