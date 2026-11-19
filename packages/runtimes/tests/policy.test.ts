import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PolicyViolation } from "@factory/sandboxes";
import { InferenceSourcePolicy, loadPolicyConfig, type InferencePolicyConfig } from "../src/policy";

const cfgDir = join(import.meta.dir, "../../../config");
const base = loadPolicyConfig(cfgDir);
const policy = new InferenceSourcePolicy(base);
const code = (fn: () => void) => { try { fn(); } catch (e) { return e instanceof PolicyViolation ? e.code : "other"; } return undefined; };

describe("InferenceSourcePolicy", () => {
  test("shipped config: only subscription_cli/local_model; no terms approved; no executables allowlisted", () => {
    expect(base.allowedInferenceModes).toEqual(["subscription_cli", "local_model"]);
    expect(base.terms.approvals).toEqual([]);
    expect(base.allowlist.executables).toEqual([]);
  });
  test("local model on loopback passes", () => {
    expect(code(() => policy.check({ adapterId: "local", authMode: "local_model", env: { PATH: "/bin" }, endpoints: ["http://127.0.0.1:11434"] }))).toBeUndefined();
    expect(code(() => policy.check({ adapterId: "local", authMode: "local_model", env: {}, endpoints: ["http://[::1]:8080/v1"] }))).toBeUndefined();
  });
  test("every credential / billing / base-url environment variable is refused", () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "AZURE_OPENAI_ENDPOINT", "AWS_BEARER_TOKEN_BEDROCK", "CLAUDE_CODE_USE_BEDROCK_TOKEN"]) {
      expect(code(() => policy.check({ adapterId: "local", authMode: "local_model", env: { [k]: "x" } }))).toBe("forbidden-env");
    }
  });
  test("api-key / metered auth modes do not exist", () => {
    for (const m of ["api_key", "api", "metered", "bedrock", "vertex", ""]) expect(code(() => policy.check({ adapterId: "x", authMode: m, env: {} }))).toBe("auth-mode-not-allowed");
  });
  test("subscription adapters are blocked until a provider-terms approval is recorded (and again once it expires)", () => {
    const input = { adapterId: "claude-code", authMode: "subscription_cli", env: {} };
    expect(code(() => policy.check(input))).toBe("terms-not-approved");
    const approved: InferencePolicyConfig = { ...base, terms: { ...base.terms, approvals: [{ adapterId: "claude-code", provider: "p", termsUrl: "https://example.com/terms", termsReviewedOn: "2026-11-18", approvedBy: "operator", scope: "interactive CLI orchestration on operator machine" }] } };
    expect(code(() => new InferenceSourcePolicy(approved).check(input))).toBeUndefined();
    expect(code(() => new InferenceSourcePolicy(approved).check({ ...input, adapterId: "codex" }))).toBe("terms-not-approved");
    const expired = { ...approved, terms: { ...approved.terms, approvals: approved.terms.approvals.map((a) => ({ ...a, expiresOn: "2026-01-01" })) } };
    expect(code(() => new InferenceSourcePolicy(expired).check(input))).toBe("terms-not-approved");
  });
  test("metered inference hosts and non-allowlisted hosts are refused as endpoints", () => {
    for (const ep of ["https://api.anthropic.com/v1", "https://api.openai.com", "https://eu.api.openai.com", "https://openrouter.ai/api"]) {
      expect(code(() => policy.check({ adapterId: "local", authMode: "local_model", env: {}, endpoints: [ep] }))).toBe("endpoint-denied");
    }
    expect(code(() => policy.check({ adapterId: "local", authMode: "local_model", env: {}, endpoints: ["https://models.internal.example"] }))).toBe("endpoint-not-allowlisted");
    expect(code(() => policy.check({ adapterId: "local", authMode: "local_model", env: {}, endpoints: ["not a url"] }))).toBe("endpoint-invalid");
  });
  test("executable identity: exact allowlisted path and version pattern", () => {
    const cfg: InferencePolicyConfig = { ...base, allowlist: { ...base.allowlist, executables: [{ adapterId: "local", path: "/opt/bin/llama", versionPattern: "^1\\.[0-9]+\\." }] } };
    const p = new InferenceSourcePolicy(cfg);
    const mk = (path: string, version: string) => ({ adapterId: "local", authMode: "local_model", env: {}, executable: { path, version } });
    expect(code(() => p.check(mk("/opt/bin/llama", "1.4.0")))).toBeUndefined();
    expect(code(() => p.check(mk("/opt/bin/llama", "2.0.0")))).toBe("version-unsupported");
    expect(code(() => p.check(mk("/tmp/evil/llama", "1.4.0")))).toBe("executable-not-allowlisted");
    expect(code(() => policy.check(mk("/opt/bin/llama", "1.4.0")))).toBe("executable-not-allowlisted");
  });
  test("a config that enables billing or high-risk auto-merge is refused at load time", async () => {
    const { mkdtempSync, writeFileSync, copyFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "cfg-"));
    for (const f of ["provider-terms.json", "runtime-allowlist.json"]) copyFileSync(join(cfgDir, f), join(d, f));
    writeFileSync(join(d, "inference-policy.json"), JSON.stringify({ version: "1.0", allowedInferenceModes: ["subscription_cli", "api_key"], modelApiBillingEnabled: true, autoMergeHighRisk: false, pilotHumanApproval: true }));
    expect(() => loadPolicyConfig(d)).toThrow(/policy\.schema/);
  });
});
