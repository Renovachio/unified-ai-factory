/** Strict validator for CONTRACTS/dispatch.schema.json `Intent`: exactly one known type, required fields present, no unknown fields, no wrong types. Fails closed. */
export type Intent =
  | { type: "project.create"; title: string; description?: string }
  | { type: "project.select"; projectId: string }
  | { type: "job.create"; projectId: string; request: string }
  | { type: "job.list"; projectId?: string }
  | { type: "job.pause" | "job.resume" | "job.cancel"; jobId: string }
  | { type: "approval.review"; approvalId: string }
  | { type: "capability.list"; category: "skills" | "agents" | "models" }
  | { type: "factory.status" }
  | { type: "clarification.required"; question: string };
export type IntentType = Intent["type"];

type Spec = Record<string, "str" | "str?" | "ref" | "ref?" | "text" | "text?" | readonly string[]>;
const SPECS: Record<IntentType, Spec> = {
  "project.create": { title: "text", description: "text?" },
  "project.select": { projectId: "ref" },
  "job.create": { projectId: "ref", request: "text" },
  "job.list": { projectId: "ref?" },
  "job.pause": { jobId: "str" }, "job.resume": { jobId: "str" }, "job.cancel": { jobId: "str" },
  "approval.review": { approvalId: "str" },
  "capability.list": { category: ["skills", "agents", "models"] },
  "factory.status": {},
  "clarification.required": { question: "text" },
};
export const INTENT_TYPES = Object.keys(SPECS) as IntentType[];
export const MAX_TEXT = 8_000;
/** Identifiers are opaque tokens, never free text: a restricted alphabet keeps them out of shell/SQL/log-injection territory. */
/** A project is addressed by id or by `owner/name`. Each segment must start alphanumeric, so `..`, leading dots, absolute paths and empty segments cannot match. */
export const PROJECT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type Validation = { ok: true; intent: Intent } | { ok: false; error: string };
export function validateIntent(raw: unknown): Validation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "intent must be an object" };
  const o = raw as Record<string, unknown>; const t = o.type;
  if (typeof t !== "string" || !Object.hasOwn(SPECS, t)) return { ok: false, error: "unknown intent type" };
  const spec = SPECS[t as IntentType];
  for (const k of Object.keys(o)) if (k !== "type" && !Object.hasOwn(spec, k)) return { ok: false, error: `unknown field: ${k.slice(0, 40)}` };
  for (const [k, kind] of Object.entries(spec)) {
    const v = o[k]; const optional = Array.isArray(kind) ? false : (kind as string).endsWith("?");
    if (v === undefined) { if (optional) continue; return { ok: false, error: `missing field: ${k}` }; }
    if (Array.isArray(kind)) { if (typeof v !== "string" || !kind.includes(v)) return { ok: false, error: `invalid ${k}` }; continue; }
    if (typeof v !== "string") return { ok: false, error: `${k} must be a string` };
    const base = (kind as string).replace("?", "");
    if (base === "str") { if (!ID_RE.test(v)) return { ok: false, error: `${k} is not a valid identifier` }; }
    else if (base === "ref") { if (!PROJECT_REF_RE.test(v) && !ID_RE.test(v)) return { ok: false, error: `${k} is not a valid project reference` }; }
    else if (v.trim().length === 0 || v.length > MAX_TEXT) return { ok: false, error: `${k} must be 1..${MAX_TEXT} characters` };
  }
  return { ok: true, intent: raw as Intent };
}

export const DESTRUCTIVE: ReadonlySet<IntentType> = new Set(["job.cancel"]);
export const MUTATING: ReadonlySet<IntentType> = new Set(["project.create", "job.create", "job.pause", "job.resume", "job.cancel", "approval.review", "project.select"]);
export const targetOf = (i: Intent): string | null => ("jobId" in i ? i.jobId : "approvalId" in i ? i.approvalId : "projectId" in i ? (i.projectId ?? null) : null);
