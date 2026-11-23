import type { Sql } from "@factory/db";
import { recordSignal } from "@factory/capabilities";
import { type Actor, type FeedbackInput, type FeedbackResult, type SignalSink, recordRetrievalFeedback } from "@factory/memory";

/**
 * Composition for memory feedback (MEM-06). Sends each gap signal to SAI-11 through the capability signal intake, which enforces its own
 * rules (opt-in, anonymisation, intent normalisation, digest-only evidence). Consent is taken from the caller's input and checked by
 * recordRetrievalFeedback before the sink is ever called.
 */
export function sai11SignalSink(sql: Sql, organizationId: string, workspaceId = "default"): SignalSink {
  return async (s) => {
    await recordSignal(sql, { organizationId, workspaceId, kind: s.kind, intent: s.intent, optedIn: true, anonymized: true, hints: { severity: "low", count: 1 }, evidence: s.evidence });
  };
}

export function feedbackWithSignals(sql: Sql, actor: Actor, projectId: string, input: FeedbackInput, workspaceId?: string): Promise<FeedbackResult> {
  return recordRetrievalFeedback(sql, actor, projectId, input, sai11SignalSink(sql, actor.organizationId, workspaceId));
}
