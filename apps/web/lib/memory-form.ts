// MEM-07: pure validation of the memory forms the browser submits. Server actions use these before calling the API, so a malformed
// or tampered form never reaches it. The API re-checks everything (role, project, exact overlap set); this is not the security boundary.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const str = (f: FormData, k: string): string => { const v = f.get(k); return typeof v === "string" ? v : ""; };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function memoryPage(projectId: string, q?: { error?: string; notice?: string }): string {
  const base = `/projects/${encodeURIComponent(projectId)}/memory`;
  if (q?.error) return `${base}?error=${encodeURIComponent(q.error.slice(0, 300))}`;
  if (q?.notice) return `${base}?notice=${encodeURIComponent(q.notice.slice(0, 300))}`;
  return base;
}

export function parseNote(f: FormData): Parsed<{ projectId: string; text: string }> {
  const projectId = str(f, "projectId"); const text = str(f, "text").trim();
  if (!isId(projectId)) return { ok: false, error: "Invalid project." };
  if (!text) return { ok: false, error: "Write what Claude should remember." };
  if (text.length > 4000) return { ok: false, error: "A note can be at most 4000 characters." };
  return { ok: true, value: { projectId, text } };
}

export interface Decision { projectId: string; memoryId: string; decision: "approve" | "reject"; reason?: string; acceptErasureOf: string[] }
/** Approve or reject one proposed memory. `erase` holds the overlapping APPROVED memories the reviewer ticked; the API requires exactly the overlap set. */
export function parseDecision(f: FormData): Parsed<Decision> {
  const projectId = str(f, "projectId"); const memoryId = str(f, "memoryId"); const decision = str(f, "decision");
  if (!isId(projectId) || !isId(memoryId)) return { ok: false, error: "Invalid memory." };
  if (decision !== "approve" && decision !== "reject") return { ok: false, error: "Invalid decision." };
  const erase = [...new Set(f.getAll("erase").filter((x): x is string => typeof x === "string"))];
  if (erase.some((x) => !isId(x))) return { ok: false, error: "Invalid overlapping memory." };
  if (decision === "reject" && erase.length > 0) return { ok: false, error: "Rejecting never erases other memory." };
  const reason = str(f, "reason").trim().slice(0, 500);
  return { ok: true, value: { projectId, memoryId, decision, acceptErasureOf: erase, ...(reason ? { reason } : {}) } };
}

export function parseConsent(f: FormData): Parsed<{ projectId: string; optedIn: boolean; reason: string }> {
  const projectId = str(f, "projectId"); const v = str(f, "optedIn"); const reason = str(f, "reason").trim();
  if (!isId(projectId)) return { ok: false, error: "Invalid project." };
  if (v !== "on" && v !== "off") return { ok: false, error: "Invalid consent value." };
  if (!reason || reason.length > 500) return { ok: false, error: "Give a reason (at most 500 characters) for changing consent." };
  return { ok: true, value: { projectId, optedIn: v === "on", reason } };
}
