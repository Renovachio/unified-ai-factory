import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { PathEscapeError, resolveInside } from "@factory/sandboxes";
import { z } from "zod";
import { InferenceSourcePolicy } from "./policy";

/** Controlled tools for a local model (RT-05). The model never gets a shell: `run_check` runs only operator-named commands. */
export interface ToolHostOptions {
  repoDir: string;
  /** Named, operator-defined verification commands (e.g. test -> bun test). The model picks a NAME, never argv. */
  checks: Record<string, () => Promise<{ exitCode: number | null; output: string }>>;
  maxFileBytes?: number;
  maxWrites?: number;
  maxReadBytes?: number;
}

const PROTECTED = [/^\.git(\/|$)/, /^\.github\//, /(^|\/)node_modules(\/|$)/, /(^|\/)\.env(\.|$)/];
const SchemaPath = z.strictObject({ path: z.string().min(1).max(500) });
const ToolArgs = {
  list_dir: SchemaPath,
  read_file: z.strictObject({ path: z.string().min(1).max(500), maxBytes: z.number().int().positive().max(200_000).optional() }),
  write_file: z.strictObject({ path: z.string().min(1).max(500), content: z.string().max(400_000) }),
  replace_in_file: z.strictObject({ path: z.string().min(1).max(500), find: z.string().min(1).max(50_000), replace: z.string().max(50_000) }),
  run_check: z.strictObject({ name: z.string().min(1).max(50) }),
} as const;
export type ToolName = keyof typeof ToolArgs;

export const TOOL_SPECS = [
  { name: "list_dir", description: "List files in a repository directory (relative path, '.' for root).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "read_file", description: "Read a UTF-8 file from the repository.", parameters: { type: "object", properties: { path: { type: "string" }, maxBytes: { type: "integer" } }, required: ["path"], additionalProperties: false } },
  { name: "write_file", description: "Create or overwrite a file in the repository.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "replace_in_file", description: "Replace the single exact occurrence of `find` with `replace` in a file.", parameters: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"], additionalProperties: false } },
  { name: "run_check", description: "Run a named verification command (e.g. test, typecheck, lint) and return its output.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
] as const;
/** Stable digest of the tool configuration: part of a model's qualification identity. */
export const toolsetDigest = (checkNames: string[]): string => `sha256:${createHash("sha256").update(JSON.stringify({ TOOL_SPECS, checks: [...checkNames].sort() })).digest("hex")}`;

export class ToolError extends Error {}

export class ToolHost {
  readonly changed = new Set<string>();
  private writes = 0;
  constructor(private readonly o: ToolHostOptions) {}
  private safe(rel: string, forWrite: boolean): string {
    const norm = rel.replace(/^\.\//, "");
    if (forWrite && PROTECTED.some((r) => r.test(norm))) throw new ToolError(`path is protected: ${rel}`);
    if (PROTECTED.some((r) => r.test(norm)) && /\.env/.test(norm)) throw new ToolError(`path is protected: ${rel}`);
    try { return resolveInside(this.o.repoDir, norm === "" ? "." : norm); } catch (e) { if (e instanceof PathEscapeError) throw new ToolError(e.message); throw e; }
  }
  async call(name: string, rawArgs: unknown): Promise<string> {
    if (!(name in ToolArgs)) throw new ToolError(`unknown tool ${name}`);
    const tool = name as ToolName;
    const parsed = ToolArgs[tool].safeParse(rawArgs);
    if (!parsed.success) throw new ToolError(`invalid arguments for ${tool}: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 200)}`);
    const a = parsed.data as Record<string, unknown>;
    const maxBytes = this.o.maxFileBytes ?? 200_000;
    switch (tool) {
      case "list_dir": {
        const p = this.safe(a.path as string, false);
        if (!existsSync(p) || !statSync(p).isDirectory()) throw new ToolError("not a directory");
        return readdirSync(p).filter((n) => n !== ".git" && n !== "node_modules").sort().map((n) => (statSync(join(p, n)).isDirectory() ? `${n}/` : n)).join("\n");
      }
      case "read_file": {
        const p = this.safe(a.path as string, false);
        if (!existsSync(p) || !statSync(p).isFile()) throw new ToolError("not a file");
        const cap = Math.min((a.maxBytes as number | undefined) ?? this.o.maxReadBytes ?? 100_000, this.o.maxReadBytes ?? 100_000);
        return readFileSync(p, "utf8").slice(0, cap);
      }
      case "write_file": {
        const content = a.content as string;
        if (Buffer.byteLength(content) > maxBytes) throw new ToolError(`file exceeds ${maxBytes} bytes`);
        this.budgetWrite();
        const p = this.safe(a.path as string, true);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        this.changed.add(relative(realpathSync(this.o.repoDir), p));
        return `wrote ${a.path as string} (${Buffer.byteLength(content)} bytes)`;
      }
      case "replace_in_file": {
        const p = this.safe(a.path as string, true);
        if (!existsSync(p) || !statSync(p).isFile()) throw new ToolError("not a file");
        const text = readFileSync(p, "utf8");
        const find = a.find as string;
        const n = text.split(find).length - 1;
        if (n !== 1) throw new ToolError(`expected exactly 1 occurrence of the text to replace, found ${n}`);
        this.budgetWrite();
        const out = text.replace(find, () => a.replace as string);
        if (Buffer.byteLength(out) > maxBytes) throw new ToolError(`file exceeds ${maxBytes} bytes`);
        writeFileSync(p, out);
        this.changed.add(relative(realpathSync(this.o.repoDir), p));
        return `replaced in ${a.path as string}`;
      }
      case "run_check": {
        const fn = this.o.checks[a.name as string];
        if (!fn) throw new ToolError(`unknown check ${a.name as string}; available: ${Object.keys(this.o.checks).join(", ")}`);
        const r = await fn();
        return `exit ${r.exitCode}\n${r.output.slice(-4000)}`;
      }
    }
  }
  private budgetWrite(): void { if (++this.writes > (this.o.maxWrites ?? 40)) throw new ToolError("write budget exhausted"); }
}

export interface ToolLoopOptions {
  endpoint: string;
  policy: InferenceSourcePolicy;
  env: Readonly<Record<string, string | undefined>>;
  modelId: string;
  system: string;
  task: string;
  host: ToolHost;
  maxIterations?: number;
  maxInvalidCalls?: number;
  /** Approximate prompt budget in characters (4 chars ~ 1 token); exceeding it ends the loop instead of silently truncating. */
  maxContextChars?: number;
  maxWallMs?: number;
  signal?: AbortSignal;
  extraBody?: Record<string, unknown>;
  /** Audit events: one per model turn and per tool call. Arguments are summarised, never raw file content. */
  onEvent?: (type: "loop.turn" | "loop.tool_call" | "loop.tool_error" | "loop.finished", payload: Record<string, unknown>) => void;
}
export type LoopStatus = "finished" | "iteration-budget" | "invalid-calls" | "context-limit" | "wall-time" | "aborted" | "model-error" | "rate-limited";
export interface ToolLoopResult { status: LoopStatus; iterations: number; changedFiles: string[]; finalMessage: string; toolCalls: number; invalidCalls: number }

interface Msg { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: unknown; tool_call_id?: string; name?: string }

/** Bounded read/edit/test/tool-result loop against a loopback OpenAI-compatible model. Never contacts anything but the policy-approved endpoint. */
export async function runToolLoop(o: ToolLoopOptions): Promise<ToolLoopResult> {
  o.policy.check({ adapterId: "local-model", authMode: "local_model", env: o.env, endpoints: [o.endpoint] });
  const maxIt = o.maxIterations ?? 12; const maxInvalid = o.maxInvalidCalls ?? 4; const maxCtx = o.maxContextChars ?? 120_000;
  const deadline = Date.now() + (o.maxWallMs ?? 600_000);
  const msgs: Msg[] = [{ role: "system", content: o.system }, { role: "user", content: o.task }];
  let calls = 0; let invalid = 0; let it = 0;
  const done = (status: LoopStatus, finalMessage = ""): ToolLoopResult => {
    const r = { status, iterations: it, changedFiles: [...o.host.changed].sort(), finalMessage, toolCalls: calls, invalidCalls: invalid };
    o.onEvent?.("loop.finished", { status, iterations: it, toolCalls: calls, invalidCalls: invalid, changedFiles: r.changedFiles });
    return r;
  };
  while (it < maxIt) {
    if (o.signal?.aborted) return done("aborted");
    if (Date.now() > deadline) return done("wall-time");
    if (msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0) > maxCtx) return done("context-limit");
    it++;
    let res: Response;
    try {
      res = await fetch(`${o.endpoint}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(Math.max(1000, deadline - Date.now()))]) : AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
        body: JSON.stringify({ model: o.modelId, messages: msgs, tools: TOOL_SPECS.map((t) => ({ type: "function", function: t })), temperature: 0, stream: false, ...(o.extraBody ?? {}) }),
      });
    } catch { return done(o.signal?.aborted ? "aborted" : Date.now() > deadline ? "wall-time" : "model-error"); }
    if (res.status === 429) return done("rate-limited");
    if (!res.ok) return done("model-error");
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number } };
    const m = j.choices?.[0]?.message;
    if (!m) return done("model-error");
    o.onEvent?.("loop.turn", { iteration: it, toolCalls: m.tool_calls?.length ?? 0, promptTokens: j.usage?.prompt_tokens ?? null });
    if (!m.tool_calls || m.tool_calls.length === 0) return done("finished", m.content ?? "");
    msgs.push({ role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls });
    for (const tc of m.tool_calls) {
      const name = tc.function?.name ?? "";
      calls++;
      let out: string;
      try {
        let args: unknown;
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { throw new ToolError("arguments are not valid JSON"); }
        out = await o.host.call(name, args);
        o.onEvent?.("loop.tool_call", { iteration: it, tool: name, ok: true, argSummary: summarise(args) });
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        invalid++; out = `ERROR: ${e.message}`;
        o.onEvent?.("loop.tool_error", { iteration: it, tool: name, message: e.message.slice(0, 200) });
      }
      msgs.push({ role: "tool", tool_call_id: tc.id ?? `call_${calls}`, name, content: out });
      if (invalid > maxInvalid) return done("invalid-calls");
    }
  }
  return done("iteration-budget");
}

/** Audit summary: paths and check names only; file content / search text are recorded as lengths, never as text. */
const CONTENT_KEYS = new Set(["content", "find", "replace"]);
const summarise = (a: unknown): Record<string, unknown> => {
  if (!a || typeof a !== "object") return {};
  return Object.fromEntries(Object.entries(a as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? (CONTENT_KEYS.has(k) ? `<${v.length} chars>` : v.slice(0, 200)) : v]));
};
