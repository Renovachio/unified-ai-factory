import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBackend, PolicyViolation, type SandboxBackend } from "@factory/sandboxes";
import { ClaudeCodeSubscriptionCliAdapter, CodexSubscriptionCliAdapter, InferenceSourcePolicy, loadPolicyConfig, parseCodexOutput, routeRun, type AgentEvent, type InferencePolicyConfig } from "../src/index";
import { adapterContractSuite, request } from "../src/testing/contract-suite";
import { makeFakeCli, type CliBehavior } from "./fake-cli";

const shipped = loadPolicyConfig(join(import.meta.dir, "../../../config"));
const wsRoot = mkdtempSync(join(tmpdir(), "codex-ws-"));
const loadContext = async () => JSON.stringify({ note: "CTX" });

/** Test-only operator decision approving the named adapters. Production ships with NO approvals. */
function approve(entries: Array<{ id: string; exe: string }>): InferencePolicyConfig {
  return {
    ...shipped,
    terms: { ...shipped.terms, approvals: entries.map((e) => ({ adapterId: e.id, provider: "test", termsUrl: "https://example.com/terms", termsReviewedOn: "2026-11-19", approvedBy: "test operator", scope: "TEST ONLY" })) },
    allowlist: { ...shipped.allowlist, executables: entries.map((e) => ({ adapterId: e.id, path: e.exe, versionPattern: "^1\\." })) },
  };
}
const countingBackend = () => { const real = detectBackend(); const b = { name: real.name, isolation: real.isolation, wraps: 0, wrap(...a: Parameters<SandboxBackend["wrap"]>) { b.wraps++; return real.wrap(...a); } }; return b as SandboxBackend & { wraps: number }; };
const codex = (exe: string, o: { cfg?: InferencePolicyConfig; env?: Record<string, string>; backend?: SandboxBackend; auth?: "subscription" | "unknown" | "api_key" } = {}) =>
  new CodexSubscriptionCliAdapter({ executable: exe, policy: new InferenceSourcePolicy(o.cfg ?? approve([{ id: "codex", exe }])), env: o.env ?? { PATH: "/usr/bin" }, backend: o.backend ?? detectBackend(), workspaceRoot: wsRoot, loadContext, authModeProbe: async () => o.auth ?? "subscription" });
const run = async (a: CodexSubscriptionCliAdapter) => {
  const events: AgentEvent[] = [];
  const id = await a.start(request(), (e) => { events.push(e); });
  let s = await a.status(id);
  for (let i = 0; i < 600 && s.exitStatus === "running"; i++) { await new Promise((r) => setTimeout(r, 10)); s = await a.status(id); }
  return { s, events };
};

// The SAME contract suite: Codex adapter against a fake JSONL-speaking CLI.
adapterContractSuite({
  name: "CodexSubscriptionCliAdapter (fake CLI)",
  expectedAuthMode: "subscription_cli",
  create: (b) => (b === "offline" ? codex("/nonexistent/codex-fake") : codex(makeFakeCli(b as CliBehavior, "codex", "jsonl"))),
  createWithForbiddenEnv: () => codex(makeFakeCli("ok", "codex", "jsonl"), { env: { OPENAI_API_KEY: "sk-x" } }),
});

describe("Codex terms gate", () => {
  test("shipped config: blocked, and the binary is never executed", async () => {
    const exe = makeFakeCli("ok", "codex", "jsonl");
    const b = countingBackend();
    const a = codex(exe, { cfg: shipped, backend: b });
    expect(await a.probe()).toMatchObject({ available: false, reason: "terms-not-approved" });
    await expect(a.start(request(), () => undefined)).rejects.toMatchObject({ code: "terms-not-approved" });
    expect(b.wraps).toBe(0);
  });
  test("approval for Claude Code does NOT enable Codex (approvals are per adapter), and vice versa", async () => {
    const cexe = makeFakeCli("ok", "codex", "jsonl");
    const lexe = makeFakeCli("ok", "claude", "envelope");
    expect(await codex(cexe, { cfg: approve([{ id: "claude-code", exe: lexe }]) }).probe()).toMatchObject({ available: false, reason: "terms-not-approved" });
    const claudeOnly = new ClaudeCodeSubscriptionCliAdapter({ executable: lexe, policy: new InferenceSourcePolicy(approve([{ id: "codex", exe: cexe }])), env: {}, backend: detectBackend(), workspaceRoot: wsRoot, loadContext, authModeProbe: async () => "subscription" });
    expect(await claudeOnly.probe()).toMatchObject({ available: false, reason: "terms-not-approved" });
    expect((await codex(cexe).probe()).available).toBe(true);
  });
  test("not installed, unverified auth mode, or an API-key mode block even with an approval", async () => {
    expect(await codex("/nonexistent/codex").probe()).toMatchObject({ available: false, reason: "not-installed" });
    const exe = makeFakeCli("ok", "codex", "jsonl");
    for (const auth of ["unknown", "api_key"] as const) expect(await codex(exe, { auth }).probe(), auth).toMatchObject({ available: false, reason: "not-authenticated" });
  });
});

describe("Codex: no model API key, no paid fallback", () => {
  test("OpenAI/Codex credential and base-URL variables are refused and nothing runs", async () => {
    const exe = makeFakeCli("ok", "codex", "jsonl");
    for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID_TOKEN", "AZURE_OPENAI_ENDPOINT", "AWS_BEARER_TOKEN_BEDROCK"]) {
      const b = countingBackend();
      const a = codex(exe, { env: { PATH: "/usr/bin", [k]: "x" }, backend: b });
      expect((await a.probe()).available, k).toBe(false);
      await expect(a.start(request(), () => undefined), k).rejects.toBeInstanceOf(PolicyViolation);
      expect(b.wraps, k).toBe(0);
    }
  });
  test("JSONL output is parsed defensively; usage is CLI-reported and labelled subscription-included", async () => {
    expect(parseCodexOutput('noise\n{"type":"item.completed","text":"A"}\n{"type":"item.completed","text":"B"}\n{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}\n')).toEqual({ text: "B", usage: { inputTokens: 3, outputTokens: 4 } });
    expect(parseCodexOutput("plain text").text).toBe("plain text");
    const { s } = await run(codex(makeFakeCli("ok", "codex", "jsonl")));
    expect(s).toMatchObject({ exitStatus: "succeeded", inferenceBillingMode: "subscription_included", usageSource: "cli_reported", usage: { inputTokens: 11, outputTokens: 7 } });
  });
  test("rate limit: run fails with rate-limited + event; the router pauses by default, and falls back ONLY to a separately approved runtime for permitted roles", async () => {
    const limited = codex(makeFakeCli("rate_limited", "codex", "jsonl"));
    const { s, events } = await run(limited);
    expect(s).toMatchObject({ exitStatus: "failed", failureCode: "rate-limited" });
    expect(events.some((e) => e.type === "agent.rate_limited")).toBe(true);
    expect(await routeRun({ candidates: [limited] }, request(), () => undefined)).toMatchObject({ status: "paused", reason: "quota-exhausted" });
    // second, separately approved CLI as the fallback
    const lexe = makeFakeCli("ok", "claude", "envelope");
    const cexe = makeFakeCli("rate_limited", "codex", "jsonl");
    const cfg = approve([{ id: "codex", exe: cexe }, { id: "claude-code", exe: lexe }]);
    const c = codex(cexe, { cfg });
    const l = new ClaudeCodeSubscriptionCliAdapter({ executable: lexe, policy: new InferenceSourcePolicy(cfg), env: {}, backend: detectBackend(), workspaceRoot: wsRoot, loadContext, authModeProbe: async () => "subscription" });
    const ok = await routeRun({ candidates: [c, l], fallbackRoles: new Set(["builder"]) }, request({ role: "builder" }), () => undefined);
    expect(ok).toMatchObject({ status: "completed", adapterId: "claude-code" });
    // ...and an UNAPPROVED second CLI is never used
    const unapproved = new ClaudeCodeSubscriptionCliAdapter({ executable: lexe, policy: new InferenceSourcePolicy(approve([{ id: "codex", exe: cexe }])), env: {}, backend: detectBackend(), workspaceRoot: wsRoot, loadContext, authModeProbe: async () => "subscription" });
    expect(await routeRun({ candidates: [c, unapproved], fallbackRoles: new Set(["builder"]) }, request({ role: "builder" }), () => undefined)).toMatchObject({ status: "paused" });
  });
  test("cancellation and wall-time are honoured (process group killed)", async () => {
    const a = codex(makeFakeCli("slow", "codex", "jsonl"));
    const events: AgentEvent[] = [];
    const id = await a.start(request({ maxWallTimeSec: 30 }), (e) => { events.push(e); });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await a.cancel(id);
    expect((await a.status(id)).exitStatus).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(events.at(-1)?.type).toBe("agent.cancelled");
  });
});
