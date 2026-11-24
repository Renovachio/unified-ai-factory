import { SubscriptionCliAdapter, type SubscriptionCliOptions } from "./cli";

/**
 * Codex (official CLI) adapter. Shipped DISABLED exactly like the Claude Code adapter: no provider-terms approval for `codex` exists, so
 * every probe/run is refused with `terms-not-approved` and the binary is never executed (docs/adr/0002). The default argv and the JSONL
 * output parser below are UNVERIFIED against any installed version and MUST be checked by the operator before enabling.
 */
export const CODEX_ID = "codex";

/** Accepts either a single JSON envelope or JSON-lines events; the model text is the LAST message-like record. Defensive, no transcript assumptions. */
export function parseCodexOutput(stdout: string): { text: string; usage?: { inputTokens?: number; outputTokens?: number } } {
  let text = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as { type?: string; text?: unknown; message?: unknown; result?: unknown; content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
      const piece = [ev.result, ev.text, ev.message, ev.content].find((x): x is string => typeof x === "string");
      if (piece) text = piece;
      if (ev.usage) usage = { ...(ev.usage.input_tokens !== undefined ? { inputTokens: ev.usage.input_tokens } : {}), ...(ev.usage.output_tokens !== undefined ? { outputTokens: ev.usage.output_tokens } : {}) };
    } catch { /* ignore non-JSON lines */ }
  }
  return { text: text || stdout, ...(usage ? { usage } : {}) };
}

export class CodexSubscriptionCliAdapter extends SubscriptionCliAdapter {
  constructor(o: Omit<SubscriptionCliOptions, "id" | "buildArgs" | "parseOutput"> & { buildArgs?: SubscriptionCliOptions["buildArgs"]; parseOutput?: SubscriptionCliOptions["parseOutput"] }) {
    super({
      ...o, id: CODEX_ID,
      // Non-interactive exec mode reading the prompt from stdin; no sandbox/permission-bypass flags. UNVERIFIED defaults.
      buildArgs: o.buildArgs ?? ((req) => ["exec", "--json", "--model", req.modelId, "-"]),
      parseOutput: o.parseOutput ?? parseCodexOutput,
    });
  }
}
