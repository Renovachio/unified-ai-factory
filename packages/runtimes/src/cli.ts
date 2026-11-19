import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { buildSandboxEnv, createWorkspace, PolicyViolation, runSandboxed, teardownWorkspace, type SandboxBackend } from "@factory/sandboxes";
import { BaseRunAdapter, type RunContext } from "./base";
import { OutputRejected, extractJsonObject, parseRoleOutput, type SchemaRegistry } from "./output";
import type { InferenceSourcePolicy } from "./policy";
import { buildMessages, loadRolePrompt } from "./prompts";
import { isReviewRole, type AgentRunRequest, type ProbeFailure, type ProbeResult } from "./types";

export type CliAuthMode = "subscription" | "api_key" | "unknown";

export interface SubscriptionCliOptions {
  /** Adapter id; MUST match the id recorded in config/provider-terms.json and config/runtime-allowlist.json. */
  id: string;
  /** Absolute path of the official CLI. */
  executable: string;
  versionArgs?: string[];
  /** argv for one non-interactive run. The prompt is delivered on STDIN; never put prompt text, tokens or credentials in argv. */
  buildArgs: (req: AgentRunRequest) => string[];
  policy: InferenceSourcePolicy;
  /** The worker process environment: inspected for credentials, NEVER forwarded to the CLI. */
  env: Readonly<Record<string, string | undefined>>;
  backend: SandboxBackend;
  workspaceRoot: string;
  loadContext: (uri: string) => Promise<string>;
  /**
   * Operator-verified check that the CLI is logged in with a SUBSCRIPTION and not an API key / metered mode.
   * Missing or "unknown" => the adapter is blocked (uncertain mode = block). It must never read or copy credentials.
   */
  authModeProbe?: () => Promise<CliAuthMode>;
  readOnlyPaths?: string[];
  /** The CLI's own login state directories. Exposing them to a sandbox that runs repository code is a credential-exposure risk. */
  authStateDirs?: string[];
  acknowledgeCredentialExposureRisk?: boolean;
  schemas?: SchemaRegistry;
  promptsDir?: string;
  rateLimitPattern?: RegExp;
  versionCacheMs?: number;
  /** Extract the model text (and CLI-reported usage) from the CLI's stdout. Default: a single JSON envelope with a string `result`. */
  parseOutput?: (stdout: string) => { text: string; usage?: { inputTokens?: number; outputTokens?: number } };
}

function defaultParseOutput(stdout: string): { text: string; usage?: { inputTokens?: number; outputTokens?: number } } {
  try {
    const env = JSON.parse(stdout.trim()) as { result?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
    const usage = env.usage ? { ...(env.usage.input_tokens !== undefined ? { inputTokens: env.usage.input_tokens } : {}), ...(env.usage.output_tokens !== undefined ? { outputTokens: env.usage.output_tokens } : {}) } : undefined;
    return { text: typeof env.result === "string" ? env.result : stdout, ...(usage ? { usage } : {}) };
  } catch { return { text: stdout }; }
}

const DEFAULT_RATE_LIMIT = /(rate[ -]?limit|usage limit|quota|limit reached|too many requests|try again (later|in|at))/i;

/**
 * Generic adapter for an OFFICIAL, subscription-authenticated CLI. Fail-closed by construction:
 *  - nothing runs (not even `--version`) until the InferenceSourcePolicy passes: no credentials in the worker env, a recorded and unexpired
 *    provider-terms approval for THIS adapter, an allowlisted executable + version;
 *  - the CLI runs in the confinement sandbox with a scrubbed environment (no host env, no API keys, no base-URL overrides);
 *  - quota/rate limits stop the run: there is no fallback to any metered service, and no code path that could create one.
 */
export class SubscriptionCliAdapter extends BaseRunAdapter {
  private versionCache: { version: string; at: number } | null = null;
  constructor(protected readonly o: SubscriptionCliOptions) {
    super(o.id, { inferenceBillingMode: "subscription_included", usageSource: "unavailable" });
  }

  private policyCheck(version?: string): void {
    this.o.policy.check({ adapterId: this.id, authMode: "subscription_cli", env: this.o.env, ...(version ? { executable: { path: this.o.executable, version } } : {}) });
    if ((this.o.authStateDirs?.length ?? 0) > 0 && !this.o.acknowledgeCredentialExposureRisk)
      throw new PolicyViolation("credential-exposure", "authStateDirs would expose CLI login state to the sandbox; set acknowledgeCredentialExposureRisk only after an operator security review");
  }

  private async sandboxRun(args: string[], opts: { timeoutMs: number; cwdRoot: string; cwd: string; stdin?: string; signal?: AbortSignal; maxOutputBytes?: number; onOutput?: (n: number) => void }) {
    const ws = realpathSync(opts.cwdRoot);
    return runSandboxed({
      backend: this.o.backend, workspaceRoot: ws, cwd: opts.cwd, command: this.o.executable, args,
      env: buildSandboxEnv({ home: join(ws, "home"), tmp: join(ws, "tmp") }),
      timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes ?? 1_000_000,
      readOnlyPaths: [dirname(realpathSync(this.o.executable)), ...(this.o.readOnlyPaths ?? []), ...(this.o.authStateDirs ?? [])],
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
    });
  }

  private async detectVersion(): Promise<string> {
    const now = Date.now();
    if (this.versionCache && now - this.versionCache.at < (this.o.versionCacheMs ?? 60_000)) return this.versionCache.version;
    const ws = createWorkspace(this.o.workspaceRoot, `probe-${this.id}`);
    try {
      const r = await this.sandboxRun(this.o.versionArgs ?? ["--version"], { timeoutMs: 15_000, cwdRoot: ws.root, cwd: ws.repoDir });
      if (r.exitCode !== 0) throw new Error(`version command exited ${r.exitCode}`);
      const m = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(r.stdout);
      if (!m) throw new Error("no version in output");
      this.versionCache = { version: m[0], at: now };
      return m[0];
    } finally {
      teardownWorkspace(this.o.workspaceRoot, ws);
    }
  }

  async probe(): Promise<ProbeResult> {
    const fail = (reason: ProbeFailure, detail: string): ProbeResult => ({ available: false, adapterId: this.id, reason, detail });
    try {
      this.policyCheck(); // terms / env / credential exposure BEFORE anything is executed
    } catch (e) {
      const code = e instanceof PolicyViolation ? e.code : "policy";
      return fail(code === "terms-not-approved" ? "terms-not-approved" : "policy-violation", e instanceof Error ? e.message : "policy");
    }
    if (!existsSync(this.o.executable)) return fail("not-installed", `${this.o.executable} not found`);
    let version: string;
    try { version = await this.detectVersion(); } catch (e) { return fail("not-installed", `version probe failed: ${e instanceof Error ? e.message : "error"}`); }
    try { this.policyCheck(version); } catch (e) { return fail(e instanceof PolicyViolation && e.code === "version-unsupported" ? "version-unsupported" : "policy-violation", e instanceof Error ? e.message : "policy"); }
    const mode = (await this.o.authModeProbe?.().catch(() => "unknown" as const)) ?? "unknown";
    if (mode !== "subscription") return fail("not-authenticated", mode === "api_key" ? "CLI is configured for API-key (metered) billing; refusing" : "authentication mode could not be verified as a subscription; refusing (uncertain mode = block)");
    return {
      available: true, adapterId: this.id, version,
      capabilities: { structuredOutput: true, shell: true, toolAllowlist: false, resume: false, tokenTelemetry: true, authMode: "subscription_cli", sandboxModes: ["local"] },
    };
  }

  protected async preflight(): Promise<void> {
    const p = await this.probe();
    if (!p.available) throw new PolicyViolation(p.reason === "terms-not-approved" ? "terms-not-approved" : `adapter-${p.reason}`, p.detail);
  }

  protected async execute(ctx: RunContext): Promise<void> {
    const req = ctx.request;
    const { seq } = ctx;
    const prompt = loadRolePrompt(req.role, this.o.promptsDir);
    const context = await this.o.loadContext(req.immutableContextManifestUri);
    const hint = this.o.schemas?.get(req.outputSchemaUri)?.hint ?? (isReviewRole(req.role) ? `{"reviewerRole":"...","candidateSha":"...","verdict":"pass|changes_requested|blocked","findings":[]}` : `{"artifactUri":"...","summary":"..."}`);
    const msgs = buildMessages(req.role, prompt, context, { candidateSha: req.candidateSha, outputHint: hint });
    const stdin = msgs.map((m) => m.content).join("\n\n");
    await seq.emit("agent.started", { role: req.role, model: req.modelId, prompt_digest: prompt.digest, auth_mode: "subscription_cli" });

    // Workspace: a task workspace supplied by the runner (under our root) or a fresh empty one.
    let ws: ReturnType<typeof createWorkspace> | null = null;
    let root: string; let cwd: string;
    if (req.workspaceUri) {
      const repoDir = resolve(req.workspaceUri.replace(/^file:\/\//, ""));
      const base = realpathSync(this.o.workspaceRoot);
      if (!repoDir.startsWith(base + sep)) throw new PolicyViolation("workspace-outside-root", "workspaceUri must be inside the configured workspace root");
      root = dirname(repoDir); cwd = repoDir;
    } else { ws = createWorkspace(this.o.workspaceRoot, `cli-${ctx.runId.replace(/[^A-Za-z0-9_-]/g, "").slice(-30)}`); root = ws.root; cwd = ws.repoDir; }
    const started = Date.now();
    let lastProgress = 0;
    try {
      const r = await this.sandboxRun(this.o.buildArgs(req), {
        timeoutMs: req.maxWallTimeSec * 1000, cwdRoot: root, cwd, stdin, signal: ctx.signal, maxOutputBytes: req.maxOutputBytes,
        onOutput: (n) => { if (Date.now() - lastProgress > 500) { lastProgress = Date.now(); void seq.emit("agent.progress", { output_bytes: n }); } },
      });
      const reason = ctx.abortReason();
      if (reason) { const t = BaseRunAdapter["abortTerminal"](reason); return await ctx.finish({ exitStatus: t.exitStatus, failureCode: reason }, t.type, {}); }
      const combined = `${r.stdout}\n${r.stderr}`;
      if (r.exitCode !== 0 && (this.o.rateLimitPattern ?? DEFAULT_RATE_LIMIT).test(combined)) {
        await seq.emit("agent.rate_limited", { detail: "subscription usage limit reached", fallback: "none (pause or operator-approved local model)" });
        return await ctx.finish({ exitStatus: "failed", failureCode: "rate-limited" }, "agent.failed", { code: "rate-limited" });
      }
      if (r.exitCode !== 0) return await ctx.finish({ exitStatus: "failed", failureCode: `exit-${r.exitCode}` }, "agent.failed", { code: `exit-${r.exitCode}` });
      if (r.outputTruncated) return await ctx.finish({ exitStatus: "failed", failureCode: "output-too-large" }, "agent.failed", { code: "output-too-large" });

      const extracted = (this.o.parseOutput ?? defaultParseOutput)(r.stdout);
      const text = extracted.text;
      const usage = extracted.usage;
      try {
        const parsed = parseRoleOutput(req.role, extractJsonObject(text), { maxBytes: req.maxOutputBytes, expectedSha: req.candidateSha, schemaUri: req.outputSchemaUri, schemas: this.o.schemas });
        await seq.emit("agent.artifact", { role: req.role });
        const artifactUri = "artifactUri" in parsed ? parsed.artifactUri : undefined;
        const candidateSha = "candidateSha" in parsed ? parsed.candidateSha : undefined;
        await ctx.finish({
          exitStatus: "succeeded", output: parsed, ...(artifactUri ? { artifactUri } : {}), ...(candidateSha ? { candidateSha } : {}),
          usage: { ...(usage ?? {}), computeSeconds: (Date.now() - started) / 1000 }, usageSource: usage ? "cli_reported" : "unavailable",
        }, "agent.completed");
      } catch (e) {
        if (!(e instanceof OutputRejected)) throw e;
        await ctx.finish({ exitStatus: "failed", failureCode: `output-${e.code}` }, "agent.failed", { code: `output-${e.code}`, message: e.message.slice(0, 300) });
      }
    } finally {
      if (ws) teardownWorkspace(this.o.workspaceRoot, ws);
    }
  }
}
