import type { Sql } from "@factory/db";
import { digestOfJson } from "@factory/skills";

export type SignalKind = "uncovered_request" | "validation_failure" | "user_correction" | "low_quality" | "missing_tool" | "policy_refusal" | "regression" | "defect" | "rework";
export interface SignalInput {
  organizationId: string; workspaceId?: string; kind: SignalKind;
  /** The active version the signal is about (if any): signals are always mapped to an exact version. */
  targetVersionId?: string;
  /** Free-text intent; it is normalised into an intent key and NEVER stored raw. */
  intent: string;
  /** Telemetry consent and anonymisation must both be asserted by the caller; otherwise nothing is stored. */
  optedIn: boolean; anonymized: boolean;
  /** Only these structured, non-identifying hints are stored. */
  hints?: { needsState?: boolean; multiStep?: boolean; missingConnector?: string; inadequateData?: boolean; unqualifiedModel?: boolean; severity?: "low" | "medium" | "high"; count?: number };
  /** Opaque evidence (e.g. a failing output); only its SHA-256 is kept. */
  evidence: string;
}
export class SignalRejected extends Error { constructor(readonly code: "NOT_OPTED_IN" | "NOT_ANONYMIZED" | "EMPTY_INTENT", msg: string) { super(msg); this.name = "SignalRejected"; } }

const STOP = new Set(["the", "a", "an", "of", "to", "for", "and", "or", "in", "on", "with", "from", "please", "can", "you", "i", "we", "my", "our", "is", "this", "that", "into", "about", "some", "any", "by", "at", "as", "be"]);
const stem = (w: string) => w.replace(/z/g, "s").replace(/(ing|ed)$/, "").replace(/e$/, "").replace(/s$/, "").replace(/e$/, "");
/** Normalised intent: lowercase, stemmed-ish, stop words/numbers/emails/ids removed, sorted unique tokens. Same intent phrased differently collapses to one key. */
export function normalizeIntent(text: string): string {
  const t = text.toLowerCase().replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[0-9a-f]{8,}/g, " ").replace(/\d+/g, " ");
  const toks = t.split(/[^a-z]+/).filter((x) => x.length > 2 && !STOP.has(x)).map(stem).filter((x) => x.length > 1);
  return [...new Set(toks)].sort().slice(0, 12).join(" ");
}

/** Stores one opted-in, anonymised signal. Exact duplicates (same kind+intent+evidence digest) are ignored, so repeated events cannot flood the backlog. */
export async function recordSignal(sql: Sql, s: SignalInput): Promise<{ recorded: boolean; id?: string; intentKey: string }> {
  if (!s.optedIn) throw new SignalRejected("NOT_OPTED_IN", "telemetry is not opted in: nothing stored");
  if (!s.anonymized) throw new SignalRejected("NOT_ANONYMIZED", "signal is not anonymised: nothing stored");
  const intentKey = normalizeIntent(s.intent);
  if (!intentKey) throw new SignalRejected("EMPTY_INTENT", "intent has no usable content");
  const payload = { ...(s.hints ?? {}) };
  const evidenceDigest = digestOfJson({ e: s.evidence });
  const rows = await sql`INSERT INTO improvement_signals (organization_id, workspace_id, kind, target_version_id, intent_key, evidence_digest, anonymized, opted_in, payload)
    VALUES (${s.organizationId}, ${s.workspaceId ?? "default"}, ${s.kind}, ${s.targetVersionId ?? null}, ${intentKey}, ${evidenceDigest}, true, true, ${sql.json(payload as never)})
    ON CONFLICT (organization_id, workspace_id, kind, intent_key, evidence_digest) DO NOTHING RETURNING id`;
  return rows[0] ? { recorded: true, id: rows[0].id as string, intentKey } : { recorded: false, intentKey };
}

export interface StoredSignal { id: string; kind: SignalKind; intentKey: string; targetVersionId: string | null; evidenceDigest: string; payload: NonNullable<SignalInput["hints"]>; occurredAt: string }
export type GapCause = "missing_skill" | "missing_agent" | "missing_connector" | "inadequate_data" | "unqualified_model" | "policy_blocked_operation" | "quality_gap";
export type Recommendation = "discover_skill" | "create_skill" | "create_agent" | "revise_skill" | "revise_workflow" | "no_action";
export interface GapReport {
  intentKey: string; cause: GapCause; recommendation: Recommendation;
  /** 0..1, grows with the number of DISTINCT evidence items; never 1. */
  confidence: number; distinctEvidence: number; totalEvents: number;
  targetVersionId: string | null;
  cost: "low" | "medium" | "high"; risk: "low" | "medium" | "high";
  representativeEvidence: string[]; rationale: string;
}
const MIN_EVIDENCE = 3;

export function analyzeGaps(signals: readonly StoredSignal[]): GapReport[] {
  const groups = new Map<string, StoredSignal[]>();
  for (const s of signals) { const k = `${s.intentKey}|${s.targetVersionId ?? ""}`; const bucket = groups.get(k) ?? []; bucket.push(s); groups.set(k, bucket); }
  const out: GapReport[] = [];
  for (const [, g] of groups) {
    const distinct = new Set(g.map((s) => s.evidenceDigest)).size;
    const first = g[0] as StoredSignal;
    const has = (k: SignalKind) => g.some((s) => s.kind === k);
    const any = (f: (h: StoredSignal["payload"]) => boolean) => g.some((s) => f(s.payload));
    let cause: GapCause; let rec: Recommendation; let cost: GapReport["cost"] = "medium"; let risk: GapReport["risk"] = "medium"; let why: string;
    if (has("policy_refusal") && !has("uncovered_request")) { cause = "policy_blocked_operation"; rec = "no_action"; cost = "low"; risk = "high"; why = "the request was refused by policy; that is not a missing capability and must not trigger creation of a capability that circumvents it"; }
    else if (any((h) => h.unqualifiedModel === true)) { cause = "unqualified_model"; rec = "no_action"; why = "a capability exists but no model is qualified for the role; fix qualification, not the skill"; }
    else if (has("missing_tool") || any((h) => !!h.missingConnector)) { cause = "missing_connector"; rec = "revise_workflow"; why = `a tool/connector is missing (${g.map((s) => s.payload.missingConnector).find(Boolean) ?? "unspecified"}); a new skill cannot supply it`; risk = "high"; }
    else if (any((h) => h.inadequateData === true)) { cause = "inadequate_data"; rec = "no_action"; cost = "low"; why = "inputs were inadequate; collecting better data is not a capability change"; }
    else if (first.targetVersionId && (has("validation_failure") || has("user_correction") || has("low_quality") || has("regression") || has("defect") || has("rework"))) { cause = "quality_gap"; rec = "revise_skill"; why = "repeated quality signals on an exact active version; propose one bounded revision"; cost = "low"; }
    else if (has("uncovered_request")) {
      if (any((h) => h.needsState === true || h.multiStep === true)) { cause = "missing_agent"; rec = "create_agent"; cost = "high"; why = "recurring multi-step/stateful request with no covering capability"; }
      else { cause = "missing_skill"; rec = "discover_skill"; cost = "low"; why = "recurring uncovered request; look for an existing skill first, create one only if discovery finds none"; }
    } else { cause = "quality_gap"; rec = "no_action"; why = "signals do not identify an actionable gap"; }
    if (distinct < MIN_EVIDENCE && rec !== "no_action") { rec = "no_action"; why = `only ${distinct} distinct evidence item(s) (< ${MIN_EVIDENCE}); not enough to recommend action. ${why}`; }
    const confidence = Math.min(0.95, 1 - 1 / (1 + distinct / 2));
    out.push({ intentKey: first.intentKey, cause, recommendation: rec, confidence: Number(confidence.toFixed(3)), distinctEvidence: distinct, totalEvents: g.length, targetVersionId: first.targetVersionId, cost, risk,
      representativeEvidence: [...new Set(g.map((s) => s.evidenceDigest))].slice(0, 3), rationale: why });
  }
  return out.sort((a, b) => b.confidence - a.confidence || (a.intentKey < b.intentKey ? -1 : 1));
}

export async function loadSignals(sql: Sql, org: string, workspace = "default"): Promise<StoredSignal[]> {
  const rows = await sql`SELECT id, kind, intent_key, target_version_id, evidence_digest, payload, occurred_at FROM improvement_signals WHERE organization_id = ${org} AND workspace_id = ${workspace}`;
  return rows.map((r) => ({ id: r.id as string, kind: r.kind as SignalKind, intentKey: r.intent_key as string, targetVersionId: (r.target_version_id as string | null) ?? null, evidenceDigest: r.evidence_digest as string, payload: r.payload as StoredSignal["payload"], occurredAt: new Date(r.occurred_at as string).toISOString() }));
}
