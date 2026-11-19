/** Provenance rules for PM artifacts (v2.2 docs/PM_WORKFLOWS.md "Universal output rules"). Pure; no model is involved. */
export type ArtifactKind = "meeting" | "research" | "prd" | "epic" | "story" | "roadmap" | "analytics" | "decision" | "action";
export class ProvenanceError extends Error { constructor(readonly code: string, m: string) { super(m); this.name = "ProvenanceError"; } }

export interface MeetingBody {
  summary: string;
  /** Participants taken from the AUTHORIZED attendee list; never inferred from the transcript. */
  participants: string[];
  decisions: Array<{ text: string; status: "observed" | "proposed"; evidence: string[] }>;
  actions: Array<{ text: string; owner?: string; due?: string; uncertain?: boolean }>;
}
export interface ResearchBody { question: string; claims: Array<{ text: string; sources: string[]; strength: "strong" | "moderate" | "weak" }>; assumptions: string[] }
export interface AnalyticsBody { datasetDigest: string; computationVersion: string; schemaDigest: string; results: Record<string, number>; resultsDigest: string; limitations: string[]; confidence: string }

const SHA = /^sha256:[0-9a-f]{64}$/;
const fail = (code: string, m: string): never => { throw new ProvenanceError(code, m); };

export interface ProvenanceContext { sourceIds: readonly string[]; authorizedParticipants?: readonly string[] }
export function validateProvenance(kind: ArtifactKind, body: unknown, ctx: ProvenanceContext): void {
  if (!body || typeof body !== "object") fail("BAD_BODY", "artifact body must be an object");
  if (kind === "meeting") {
    const b = body as MeetingBody;
    if (!Array.isArray(b.participants) || !Array.isArray(b.decisions) || !Array.isArray(b.actions)) return fail("BAD_BODY", "meeting needs participants, decisions and actions");
    const allowed = ctx.authorizedParticipants;
    if (!allowed) return fail("NO_PARTICIPANT_LIST", "an authorized participant list is required; participants are never inferred");
    for (const p of b.participants) if (!allowed.includes(p)) fail("INVENTED_PARTICIPANT", `participant "${p.slice(0, 40)}" is not in the authorized attendee list`);
    for (const d of b.decisions) {
      // An LLM summary is never a formal stakeholder approval: only observed (cited) or proposed decisions exist.
      if (d.status !== "observed" && d.status !== "proposed") fail("FORMAL_APPROVAL_CLAIM", `decision status "${String((d as { status: unknown }).status).slice(0, 30)}" is not allowed; a summary cannot record formal approval`);
      if (d.status === "observed" && (!Array.isArray(d.evidence) || d.evidence.length === 0 || d.evidence.some((e) => !ctx.sourceIds.includes(e)))) fail("UNCITED_DECISION", "an observed decision must cite at least one provided source");
    }
    for (const a of b.actions) {
      if (a.owner && !b.participants.includes(a.owner) && a.uncertain !== true) fail("OWNER_NOT_PARTICIPANT", `action owner "${a.owner.slice(0, 40)}" is not a participant: flag it uncertain`);
      if ((a.owner === undefined || a.due === undefined) && a.uncertain !== true) fail("UNFLAGGED_UNCERTAINTY", "an action missing an owner or date must be flagged uncertain");
    }
  } else if (kind === "research") {
    const b = body as ResearchBody;
    if (!Array.isArray(b.claims) || !Array.isArray(b.assumptions)) return fail("BAD_BODY", "research needs claims and assumptions");
    for (const c of b.claims) {
      if (!Array.isArray(c.sources) || c.sources.length === 0 || c.sources.some((s) => !ctx.sourceIds.includes(s))) fail("UNCITED_CLAIM", `claim "${c.text.slice(0, 50)}" must cite provided sources`);
      if (!["strong", "moderate", "weak"].includes(c.strength)) fail("NO_EVIDENCE_STRENGTH", "every claim states its evidence strength");
    }
  } else if (kind === "analytics") {
    const b = body as AnalyticsBody;
    if (!SHA.test(b.datasetDigest ?? "") || !SHA.test(b.schemaDigest ?? "") || !SHA.test(b.resultsDigest ?? "") || !b.computationVersion) return fail("NO_DATA_PROVENANCE", "analytics needs dataset digest, schema digest, computation version and results digest");
    if (!Array.isArray(b.limitations) || b.limitations.length === 0 || !b.confidence) fail("NO_LIMITATIONS", "analytics must state limitations and confidence");
  }
}

/** Reproducibility check (T-19): recompute from the pinned dataset and compare the results digest. */
export async function verifyAnalyticsReproducible(b: AnalyticsBody, recompute: (datasetDigest: string, computationVersion: string) => Promise<{ results: Record<string, number>; resultsDigest: string }>): Promise<{ reproducible: boolean; reason?: string }> {
  const r = await recompute(b.datasetDigest, b.computationVersion);
  return r.resultsDigest === b.resultsDigest ? { reproducible: true } : { reproducible: false, reason: "recomputed results digest differs from the recorded one" };
}
