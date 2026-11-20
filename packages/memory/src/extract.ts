/**
 * Deterministic, conservative extraction (MEM-02). No model is called. A sentence becomes a candidate ONLY if it carries
 * an explicit marker (decision, requirement or constraint wording). Everything else is ignored, which keeps precision high.
 * Output is data for proposals: it is never an approval and never an instruction.
 */

export const EXTRACTOR_ID = "deterministic-v1" as const;
export const MAX_SOURCE_CHARS = 200_000;
export const MAX_CANDIDATES = 200;
const MIN_SENTENCE = 12;
const MAX_SENTENCE = 400;

export type CandidateKind = "decision" | "requirement" | "constraint";

export interface Candidate {
  claim: string;
  kind: CandidateKind;
  /** Offsets of the claim inside the source text (end exclusive). */
  start: number;
  end: number;
}

// Order matters: "must not" is a constraint, not a requirement.
const MARKERS: ReadonlyArray<readonly [RegExp, CandidateKind]> = [
  [/\bcannot\b|\bmust not\b|\bno more than\b|\bconstraint:/i, "constraint"],
  [/\bmust\b|\bshall\b|\bneeds? to\b|\brequirement:/i, "requirement"],
  [/\bdecided\b|\bwe will\b|\bdecision:|\bagreed\b/i, "decision"],
];

export function extractCandidates(text: string): Candidate[] {
  if (text.length > MAX_SOURCE_CHARS) throw new RangeError("source too large for extraction");
  const out: Candidate[] = [];
  for (const m of text.matchAll(/[^.!?\n]+[.!?]?/g)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const claim = raw.trim();
    if (claim.length < MIN_SENTENCE || claim.length > MAX_SENTENCE) continue;
    const marker = MARKERS.find(([re]) => re.test(claim));
    if (!marker) continue;
    const start = (m.index ?? 0) + lead;
    out.push({ claim, kind: marker[1], start, end: start + claim.length });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["api-key-sk", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["credential-assignment", /\b(password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*\S{4,}/i],
];

/** Returns the kind of secret found, or null. A claim containing any secret is dropped, never stored redacted. */
export function detectSecret(text: string): string | null {
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) return kind;
  return null;
}

const INJECTION = /ignore (all |any |the )?(previous|prior|above) (instructions|rules|policy|policies)|disregard (all |the )?(previous|prior|above)|\bsystem\s*:|\byou are now\b|\boverride (the )?(policy|policies|guard)|\bset (its |the )?status\b|approved_by|\bapprove (this|the) (memory|record)\b/i;

/** Instruction-like text inside a source. Such candidates are dropped and counted; the source is still data. */
export function detectInjection(text: string): boolean {
  return INJECTION.test(text);
}
