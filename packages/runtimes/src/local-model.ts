import { InferenceSourcePolicy } from "./policy";
import { BaseRunAdapter, type RunContext } from "./base";
import { OutputRejected, parseRoleOutput } from "./output";
import { buildMessages, loadRolePrompt } from "./prompts";
import { isReviewRole, type ProbeResult } from "./types";

export interface LocalModelOptions {
  /** OpenAI-compatible server on loopback (Ollama, llama.cpp server, ...). Validated by InferenceSourcePolicy. */
  endpoint: string;
  policy: InferenceSourcePolicy;
  env: Readonly<Record<string, string | undefined>>;
  /** Resolves immutableContextManifestUri to text (read-only, factory-controlled). */
  loadContext: (uri: string) => Promise<string>;
  /** Extra request fields for the local server (e.g. Ollama `think: false`). Never credentials. */
  extraBody?: Record<string, unknown>;
  promptsDir?: string;
}

const OUTPUT_HINT: Record<"review" | "artifact", string> = {
  review: `{"reviewerRole":"code|security|ux|ui|performance","candidateSha":"<40 hex>","verdict":"pass|changes_requested|blocked","findings":[{"severity":"low|medium|high|critical","summary":"...","location":"...","remediation":"..."}]}`,
  artifact: `{"artifactUri":"<string>","summary":"<string>"}`,
};

function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (t.startsWith("{")) return t;
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

/** Self-hosted model adapter: loopback OpenAI-compatible endpoint, streaming, no credentials, no billing. */
export class LocalModelAdapter extends BaseRunAdapter {
  constructor(private readonly o: LocalModelOptions) {
    super("local-model", { inferenceBillingMode: "local_compute", usageSource: "local_runtime" });
  }

  private check() {
    this.o.policy.check({ adapterId: this.id, authMode: "local_model", env: this.o.env, endpoints: [this.o.endpoint] });
  }

  async probe(): Promise<ProbeResult> {
    try {
      this.check();
    } catch (e) {
      return { available: false, adapterId: this.id, reason: "policy-violation", detail: e instanceof Error ? e.message : "policy" };
    }
    try {
      const r = await fetch(`${this.o.endpoint}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return { available: false, adapterId: this.id, reason: "offline", detail: `HTTP ${r.status}` };
      return {
        available: true, adapterId: this.id,
        capabilities: { structuredOutput: true, shell: false, toolAllowlist: false, resume: false, tokenTelemetry: true, authMode: "local_model", sandboxModes: ["local", "cloud"] },
      };
    } catch (e) {
      return { available: false, adapterId: this.id, reason: "offline", detail: e instanceof Error ? e.message : "unreachable" };
    }
  }

  protected preflight(): void {
    this.check();
  }

  protected async execute(ctx: RunContext): Promise<void> {
    const req = ctx.request;
    const { seq, signal } = ctx;
    const started = Date.now();
    const prompt = loadRolePrompt(req.role, this.o.promptsDir);
    const context = await this.o.loadContext(req.immutableContextManifestUri);
    const messages = buildMessages(req.role, prompt, context, { candidateSha: req.candidateSha, outputHint: OUTPUT_HINT[isReviewRole(req.role) ? "review" : "artifact"] });
    await seq.emit("agent.started", { role: req.role, model: req.modelId, prompt_digest: prompt.digest, auth_mode: "local_model" });

    const stop = async (): Promise<boolean> => {
      const reason = ctx.abortReason();
      if (!reason) return false;
      const t = BaseRunAdapter["abortTerminal"](reason);
      await ctx.finish({ exitStatus: t.exitStatus, failureCode: reason }, t.type, {});
      return true;
    };

    let text = "";
    let bytes = 0;
    let tokens = 0;
    let usage: { prompt?: number; completion?: number } = {};
    let res: Response;
    try {
      res = await fetch(`${this.o.endpoint}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, signal,
        body: JSON.stringify({ model: req.modelId, messages, stream: true, stream_options: { include_usage: true }, temperature: 0, ...(this.o.extraBody ?? {}) }),
      });
    } catch (e) {
      if (await stop()) return;
      return ctx.finish({ exitStatus: "failed", failureCode: "offline" }, "agent.failed", { code: "offline", message: e instanceof Error ? e.message.slice(0, 200) : "unreachable", action: "pause-job-no-paid-fallback" });
    }
    if (res.status === 429) {
      await seq.emit("agent.rate_limited", { retry_after_sec: Number(res.headers.get("retry-after") ?? 60) });
      return ctx.finish({ exitStatus: "failed", failureCode: "rate-limited" }, "agent.failed", { code: "rate-limited" });
    }
    if (!res.ok || !res.body) return ctx.finish({ exitStatus: "failed", failureCode: `http-${res.status}` }, "agent.failed", { code: `http-${res.status}` });

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let lastProgress = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j: { choices?: Array<{ delta?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          try { j = JSON.parse(data); } catch { continue; }
          const piece = j.choices?.[0]?.delta?.content ?? "";
          if (piece) {
            text += piece; bytes += Buffer.byteLength(piece); tokens++;
            if (bytes > req.maxOutputBytes) { await reader.cancel(); return ctx.finish({ exitStatus: "failed", failureCode: "output-too-large" }, "agent.failed", { code: "output-too-large" }); }
            if (Date.now() - lastProgress > 500) { lastProgress = Date.now(); await seq.emit("agent.progress", { chunks: tokens, bytes }); }
          }
          if (j.usage) usage = { ...(j.usage.prompt_tokens !== undefined ? { prompt: j.usage.prompt_tokens } : {}), ...(j.usage.completion_tokens !== undefined ? { completion: j.usage.completion_tokens } : {}) };
        }
      }
    } catch (e) {
      if (await stop()) return;
      return ctx.finish({ exitStatus: "failed", failureCode: "stream-error" }, "agent.failed", { code: "stream-error", message: e instanceof Error ? e.message.slice(0, 200) : "" });
    }
    if (await stop()) return;
    try {
      const parsed = parseRoleOutput(req.role, extractJson(text), { maxBytes: req.maxOutputBytes, expectedSha: req.candidateSha });
      await seq.emit("agent.artifact", { role: req.role });
      const artifactUri = "artifactUri" in parsed ? parsed.artifactUri : undefined;
      const candidateSha = "candidateSha" in parsed ? parsed.candidateSha : undefined;
      await ctx.finish({
        exitStatus: "succeeded", output: parsed,
        ...(artifactUri ? { artifactUri } : {}), ...(candidateSha ? { candidateSha } : {}),
        usage: { ...(usage.prompt !== undefined ? { inputTokens: usage.prompt } : {}), ...(usage.completion !== undefined ? { outputTokens: usage.completion } : {}), computeSeconds: (Date.now() - started) / 1000 },
        usageSource: usage.completion !== undefined ? "local_runtime" : "estimated",
      }, "agent.completed");
    } catch (e) {
      if (!(e instanceof OutputRejected)) throw e;
      await ctx.finish({ exitStatus: "failed", failureCode: `output-${e.code}` }, "agent.failed", { code: `output-${e.code}`, message: e.message.slice(0, 300) });
    }
  }
}
