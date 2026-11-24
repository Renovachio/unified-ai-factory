import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBackend, PolicyViolation, type SandboxBackend } from "@factory/sandboxes";
import { ClaudeCodeSubscriptionCliAdapter, InferenceSourcePolicy, loadPolicyConfig, MockAdapter, routeRun, type AgentEvent, type AgentRunRequest, type InferencePolicyConfig } from "../src/index";
import { adapterContractSuite, request } from "../src/testing/contract-suite";
import { makeFakeCli, type CliBehavior } from "./fake-cli";

const CONFIG_DIR = join(import.meta.dir, "../../../config");
const shipped = loadPolicyConfig(CONFIG_DIR);
const wsRoot = mkdtempSync(join(tmpdir(), "cli-ws-"));
const loadContext = async () => JSON.stringify({ note: "SECRET-CONTEXT-MARKER request text" });

/** Test-only operator decision: terms approved for `claude-code`, executable + version allowlisted. Production config ships with NEITHER. */
function approved(exe: string, over: { versionPattern?: string; expiresOn?: string; adapterId?: string } = {}): InferencePolicyConfig {
  const id = over.adapterId ?? "claude-code";
  return {
    ...shipped,
    terms: { ...shipped.terms, approvals: [{ adapterId: id, provider: "test-provider", termsUrl: "https://example.com/terms", termsReviewedOn: "2026-11-19", approvedBy: "test operator", scope: "TEST ONLY: non-interactive print mode on an operator machine", ...(over.expiresOn ? { expiresOn: over.expiresOn } : {}) }] },
    allowlist: { ...shipped.allowlist, executables: [{ adapterId: id, path: exe, versionPattern: over.versionPattern ?? "^1\\." }] },
  };
}
const countingBackend = (): SandboxBackend & { wraps: number } => {
  const real = detectBackend();
  const b = { name: real.name, isolation: real.isolation, wraps: 0, wrap(...a: Parameters<SandboxBackend["wrap"]>) { b.wraps++; return real.wrap(...a); } };
  return b as SandboxBackend & { wraps: number };
};

function adapter(exe: string, o: { cfg?: InferencePolicyConfig; env?: Record<string, string>; backend?: SandboxBackend; authMode?: "subscription" | "api_key" | "unknown" | "none"; extra?: { authStateDirs?: string[]; acknowledgeCredentialExposureRisk?: boolean } } = {}) {
  const mode = o.authMode ?? "subscription";
  return new ClaudeCodeSubscriptionCliAdapter({
    executable: exe, policy: new InferenceSourcePolicy(o.cfg ?? approved(exe)), env: o.env ?? { PATH: "/usr/bin" }, backend: o.backend ?? detectBackend(), workspaceRoot: wsRoot, loadContext,
    ...(mode === "none" ? {} : { authModeProbe: async () => mode }),
    ...(o.extra?.authStateDirs ? { authStateDirs: o.extra.authStateDirs } : {}),
    ...(o.extra?.acknowledgeCredentialExposureRisk !== undefined ? { acknowledgeCredentialExposureRisk: o.extra.acknowledgeCredentialExposureRisk } : {}),
  });
}
const finish = async (a: ClaudeCodeSubscriptionCliAdapter, req = request()) => {
  const events: AgentEvent[] = [];
  const id = await a.start(req, (e) => { events.push(e); });
  let s = await a.status(id);
  for (let i = 0; i < 600 && s.exitStatus === "running"; i++) { await new Promise((r) => setTimeout(r, 10)); s = await a.status(id); }
  return { s, events };
};

// The SAME contract suite every adapter must pass.
adapterContractSuite({
  name: "ClaudeCodeSubscriptionCliAdapter (fake CLI)",
  expectedAuthMode: "subscription_cli",
  create: (b) => (b === "offline" ? adapter("/nonexistent/claude-fake") : adapter(makeFakeCli(b as CliBehavior))),
  createWithForbiddenEnv: () => adapter(makeFakeCli("ok"), { env: { ANTHROPIC_API_KEY: "sk-ant-x" } }),
});

describe("terms gate (subscription automation is blocked unless explicitly approved)", () => {
  test("shipped config: no terms approval => probe and run are refused and the CLI is NEVER executed", async () => {
    const exe = makeFakeCli("ok");
    const b = countingBackend();
    const a = new ClaudeCodeSubscriptionCliAdapter({ executable: exe, policy: new InferenceSourcePolicy(shipped), env: { PATH: "/usr/bin" }, backend: b, workspaceRoot: wsRoot, loadContext, authModeProbe: async () => "subscription" });
    const p = await a.probe();
    expect(p).toMatchObject({ available: false, reason: "terms-not-approved" });
    await expect(a.start(request(), () => undefined)).rejects.toMatchObject({ code: "terms-not-approved" });
    expect(b.wraps).toBe(0); // not even --version ran
  });
  test("an approval for a DIFFERENT adapter, an expired approval, a non-allowlisted path, or an unsupported version all block", async () => {
    const exe = makeFakeCli("ok");
    const other = await adapter(exe, { cfg: approved(exe, { adapterId: "codex" }) }).probe();
    expect(other).toMatchObject({ available: false, reason: "terms-not-approved" });
    expect(await adapter(exe, { cfg: approved(exe, { expiresOn: "2026-01-01" }) }).probe()).toMatchObject({ available: false, reason: "terms-not-approved" });
    const wrongPath = await adapter(exe, { cfg: approved("/somewhere/else/claude") }).probe();
    expect(wrongPath).toMatchObject({ available: false, reason: "policy-violation" });
    expect(await adapter(exe, { cfg: approved(exe, { versionPattern: "^9\\." }) }).probe()).toMatchObject({ available: false, reason: "version-unsupported" });
    expect(await adapter(exe).probe()).toMatchObject({ available: true, version: "1.2.3" });
  });
  test("uncertain or API-key authentication mode blocks (never assumes a subscription)", async () => {
    const exe = makeFakeCli("ok");
    for (const authMode of ["none", "unknown", "api_key"] as const) {
      const a = adapter(exe, { authMode });
      const p = await a.probe();
      expect(p, authMode).toMatchObject({ available: false, reason: "not-authenticated" });
      await expect(a.start(request(), () => undefined), authMode).rejects.toBeInstanceOf(PolicyViolation);
    }
  });
  test("exposing the CLI's login state to the sandbox needs an explicit risk acknowledgement", async () => {
    const exe = makeFakeCli("ok");
    const dir = mkdtempSync(join(tmpdir(), "authstate-"));
    expect(await adapter(exe, { extra: { authStateDirs: [dir] } }).probe()).toMatchObject({ available: false, reason: "policy-violation" });
    expect((await adapter(exe, { extra: { authStateDirs: [dir], acknowledgeCredentialExposureRisk: true } }).probe()).available).toBe(true);
  });
  test("a workspace outside the configured root is refused before the CLI runs", async () => {
    const b = countingBackend();
    const exe = makeFakeCli("ok");
    const a = adapter(exe, { backend: b });
    await a.probe();
    const before = b.wraps;
    const { s } = await finish(a, request({ workspaceUri: "file:///etc" }));
    expect(s).toMatchObject({ exitStatus: "failed", failureCode: "adapter-error" });
    expect(b.wraps).toBe(before);
  });
});

describe("no paid inference path", () => {
  test("every API-key / billing / base-URL environment variable blocks the adapter and nothing runs", async () => {
    const exe = makeFakeCli("ok");
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CLAUDE_CODE_USE_BEDROCK_TOKEN", "AWS_SECRET_ACCESS_KEY", "GOOGLE_API_KEY"]) {
      const b = countingBackend();
      const a = adapter(exe, { env: { PATH: "/usr/bin", [k]: "x" }, backend: b });
      expect((await a.probe()).available, k).toBe(false);
      await expect(a.start(request(), () => undefined), k).rejects.toBeInstanceOf(PolicyViolation);
      expect(b.wraps, k).toBe(0);
    }
  });
  test("host credentials never reach the CLI process: the sandbox environment is scrubbed", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-LEAK-123456789012345";
    process.env.GITHUB_TOKEN = "ghp_LEAKLEAKLEAKLEAKLEAKLEAK1234";
    try {
      const exe = makeFakeCli("envdump");
      const a = adapter(exe, { env: { PATH: "/usr/bin" } }); // the adapter sees a clean env; the PROCESS env is dirty
      const { s } = await finish(a);
      expect(s.exitStatus).toBe("succeeded");
      const summary = JSON.stringify((s as { output: unknown }).output);
      for (const bad of ["LEAK", "ANTHROPIC", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]) expect(summary).not.toContain(bad);
      expect(summary).toContain("HOME=");
    } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.GITHUB_TOKEN; }
  });
  test("the prompt travels on stdin, never in argv", async () => {
    const { s } = await finish(adapter(makeFakeCli("argvdump")));
    const summary = (s as { output: { summary: string } }).output.summary;
    expect(summary).toMatch(/ARGV\[-p --output-format json --model test-model --max-turns 20\]/);
    expect(summary).not.toContain("SECRET-CONTEXT-MARKER");
    expect(Number(/STDIN_LEN\[(\d+)\]/.exec(summary)?.[1])).toBeGreaterThan(200);
  });
  test("usage is labelled as subscription-included and CLI-reported; no price fields exist", async () => {
    const { s } = await finish(adapter(makeFakeCli("ok")));
    expect(s).toMatchObject({ exitStatus: "succeeded", inferenceBillingMode: "subscription_included", usageSource: "cli_reported", usage: { inputTokens: 11, outputTokens: 7 } });
    expect(JSON.stringify(s)).not.toMatch(/usd|cost|price|invoice/i);
  });
});

describe("quota exhaustion: pause or an operator-approved local fallback, never API billing", () => {
  const rl = () => adapter(makeFakeCli("rate_limited"));
  test("a rate limit fails the run with a rate_limited event and no billing-mode change", async () => {
    const { s, events } = await finish(rl());
    expect(s).toMatchObject({ exitStatus: "failed", failureCode: "rate-limited", inferenceBillingMode: "subscription_included" });
    expect(events.some((e) => e.type === "agent.rate_limited")).toBe(true);
  });
  test("router: by default there is NO fallback — the job pauses with quota-exhausted", async () => {
    const out = await routeRun({ candidates: [rl(), new MockAdapter()] }, request(), () => undefined);
    expect(out).toMatchObject({ status: "paused", reason: "quota-exhausted", attempted: [expect.stringContaining("claude-code")] });
    expect(out.attempted.length).toBe(1);
  });
  test("router: a permitted role may fall back to the next APPROVED (local) runtime, but never for roles the operator forbade downgrading", async () => {
    const ok = await routeRun({ candidates: [rl(), new MockAdapter()], fallbackRoles: new Set(["builder"]) }, request({ role: "builder" }), () => undefined);
    expect(ok).toMatchObject({ status: "completed", adapterId: "mock" });
    expect(ok.attempted).toEqual(["claude-code", "mock"]);
    const forbidden = await routeRun({ candidates: [rl(), new MockAdapter()], fallbackRoles: new Set(["builder"]), neverDowngradeRoles: new Set(["builder"]) }, request({ role: "builder" }), () => undefined);
    expect(forbidden).toMatchObject({ status: "paused", reason: "quota-exhausted" });
    const otherRole = await routeRun({ candidates: [rl(), new MockAdapter()], fallbackRoles: new Set(["builder"]) }, request({ role: "intake" }), () => undefined);
    expect(otherRole.status).toBe("paused");
  });
  test("router: an unavailable (terms-blocked) CLI never runs; with no eligible runtime the job pauses", async () => {
    const blocked = new ClaudeCodeSubscriptionCliAdapter({ executable: makeFakeCli("ok"), policy: new InferenceSourcePolicy(shipped), env: {}, backend: detectBackend(), workspaceRoot: wsRoot, loadContext, authModeProbe: async () => "subscription" });
    expect(await routeRun({ candidates: [blocked] }, request(), () => undefined)).toMatchObject({ status: "paused", reason: "no-eligible-runtime" });
    expect(await routeRun({ candidates: [blocked, new MockAdapter({ behavior: "offline" })], fallbackRoles: new Set(["builder"]) }, request({ role: "builder" }), () => undefined)).toMatchObject({ status: "paused", reason: "no-eligible-runtime" });
    expect(await routeRun({ candidates: [], fallbackRoles: new Set(["builder"]) }, request(), () => undefined)).toMatchObject({ status: "paused" });
  });
  test("the router can only ever pick from the approved candidate list (there is no API runtime to fall back to)", async () => {
    const seen: string[] = [];
    const spy = new MockAdapter(); const origStart = spy.start.bind(spy);
    spy.start = async (r: AgentRunRequest, e) => { seen.push(spy.id); return origStart(r, e); };
    await routeRun({ candidates: [rl(), spy], fallbackRoles: new Set(["builder"]) }, request({ role: "builder" }), () => undefined);
    expect(seen).toEqual(["mock"]);
  });
});
