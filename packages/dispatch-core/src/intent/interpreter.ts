import { type Intent, validateIntent } from "./schema";

export interface InterpretContext { activeProjectId: string | null }
export type Interpretation = { via: "deterministic" | "model"; intent: Intent } | { via: "none"; reason: "no-interpreter" | "invalid-output" | "ambiguous"; question?: string };
/** Optional natural-language fallback. It is given untrusted text and must return a candidate Intent; the result is validated against the strict schema and is NEVER executed by this layer. */
export interface NlInterpreter { readonly id: string; interpret(text: string, ctx: InterpretContext): Promise<unknown> }

const norm = (s: string) => s.trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");
export function deterministic(text: string): Intent | { ambiguous: string } | null {
  const t = norm(text);
  if (/^(show|list|what are|what's|whats)( me)?( my| the| all)?( active| current)? (jobs|tasks)\??$/.test(t) || t === "jobs") return { type: "job.list" };
  if (/^(how is|how's|what is|what's|show)( the)?( factory| system| everything)?( doing| status| health)?\??$/.test(t) && /status|health|doing|how/.test(t)) return { type: "factory.status" };
  if (/^(factory )?status$/.test(t)) return { type: "factory.status" };
  const cap = /^(show|list|what are)( me)?( my| the| all| available)? (skills|agents|models)\??$/.exec(t); if (cap) return { type: "capability.list", category: cap[4] as "skills" | "agents" | "models" };
  if (/^(stop|kill|shut ?down|halt) (everything|all)$/.test(t)) return { ambiguous: "“Stop everything” could mean pausing all jobs, closing this terminal, or shutting down the whole factory. Which do you want? (/jobs to pick a job, /exit to detach, /shutdown to stop the factory.)" };
  return null;
}
/** Deterministic path first (no inference). Otherwise ask the interpreter, if one is configured; fail closed when there is none or it returns anything the schema rejects. */
export async function interpret(text: string, ctx: InterpretContext, nl?: NlInterpreter): Promise<Interpretation> {
  const d = deterministic(text);
  if (d && "ambiguous" in d) return { via: "none", reason: "ambiguous", question: d.ambiguous };
  if (d) return { via: "deterministic", intent: d };
  if (!nl) return { via: "none", reason: "no-interpreter" };
  let raw: unknown; try { raw = await nl.interpret(text, ctx); } catch { return { via: "none", reason: "invalid-output" }; }
  const v = validateIntent(raw); if (!v.ok) return { via: "none", reason: "invalid-output" };
  if (v.intent.type === "clarification.required") return { via: "none", reason: "ambiguous", question: v.intent.question };
  return { via: "model", intent: v.intent };
}
