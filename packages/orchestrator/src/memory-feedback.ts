import type { Sql } from "@factory/db";
import { recordSignal } from "@factory/capabilities";
import { type Actor, type FeedbackInput, type FeedbackResult, type SignalSink, recordRetrievalFeedback } from "@factory/memory";

/**
 * Sends a memory feedback gap signal to SAI-11 through the capability intake. The intake enforces opt-in and anonymisation with the
 * values passed here (not hard-coded), and normalises the subject. Each project has its own signal workspace, so signals from
 * different projects are not merged.
 */
export const sai11SignalSink: SignalSink = async (s, q) => {
  await recordSignal(q, { organizationId: s.organizationId, workspaceId: s.workspaceId, kind: s.kind, intent: s.subject, optedIn: s.optedIn, anonymized: true, hints: { severity: "low", count: 1 }, evidence: s.evidence });
};

/** Composed entry point: the organization is taken from the actor, never from the caller's input. */
export function feedbackWithSignals(sql: Sql, actor: Actor, projectId: string, input: FeedbackInput): Promise<FeedbackResult> {
  return recordRetrievalFeedback(sql, actor, projectId, input, sai11SignalSink);
}
