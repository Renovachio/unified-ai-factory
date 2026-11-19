import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Intent } from "./schema";
import { targetOf } from "./schema";

/** What a confirmation authorises. Changing ANY field (action, target, project, actor, revision) invalidates it. */
export interface Binding { actor: string; projectId: string | null; intentType: Intent["type"]; target: string | null; targetRevision: number | null; sessionId: string }
export const bindingDigest = (b: Binding): string => createHash("sha256").update(JSON.stringify([b.actor, b.projectId, b.intentType, b.target, b.targetRevision, b.sessionId])).digest("hex");
export const bindingFor = (intent: Intent, ctx: { actor: string; projectId: string | null; sessionId: string; targetRevision: number | null }): Binding => ({ actor: ctx.actor, projectId: ctx.projectId, intentType: intent.type, target: targetOf(intent), targetRevision: ctx.targetRevision, sessionId: ctx.sessionId });

export type ConfirmResult = { ok: true } | { ok: false; reason: "unknown" | "expired" | "used" | "mismatch" };
/** Single-use, short-lived, bound confirmations. Tokens are random and unguessable; the bound digest is compared in constant time. */
export class ConfirmationStore {
  private readonly m = new Map<string, { digest: string; exp: number; used: boolean }>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 120_000) {}
  issue(b: Binding): { token: string; expiresAt: number } { const token = randomBytes(18).toString("base64url"); const exp = this.now() + this.ttlMs; this.m.set(token, { digest: bindingDigest(b), exp, used: false }); this.gc(); return { token, expiresAt: exp }; }
  consume(token: string, b: Binding): ConfirmResult {
    const r = this.m.get(token); if (!r) return { ok: false, reason: "unknown" };
    if (r.used) return { ok: false, reason: "used" };
    if (this.now() >= r.exp) { this.m.delete(token); return { ok: false, reason: "expired" }; }
    const a = Buffer.from(r.digest); const c = Buffer.from(bindingDigest(b));
    if (a.length !== c.length || !timingSafeEqual(a, c)) return { ok: false, reason: "mismatch" }; // does not burn the token: a wrong-context attempt must not DoS the right one
    r.used = true; return { ok: true };
  }
  private gc() { const t = this.now(); for (const [k, v] of this.m) if (v.used || v.exp <= t) this.m.delete(k); }
}
