import type { Sql } from "@factory/db";
import { MemoryError, READER_ROLES } from "./domain";
import { type Actor, requireActor, requireProject } from "./lifecycle";

/**
 * Retrieval feedback (MEM-06). A user says whether a returned memory was useful, wrong, stale or missing. The verdict is stored with
 * no free text. A non-useful verdict may also be sent, as a gap signal, to SAI-11 through a SignalSink supplied by the caller. This module
 * does not import the capabilities package: SAI-11 is reached only through the sink. Feedback never changes a memory or approves anything.
 */
export const FEEDBACK_VERDICTS = ["useful", "wrong", "stale", "missing"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];
export type FeedbackSignalKind = "low_quality" | "user_correction" | "uncovered_request";
const SIGNAL_KIND: Readonly<Record<Exclude<FeedbackVerdict, "useful">, FeedbackSignalKind>> = {
  wrong: "low_quality",
  stale: "user_correction",
  missing: "uncovered_request",
};

/** Receives one anonymised gap signal. The caller implements it (for example, by calling SAI-11's recordSignal with optedIn set). */
export type SignalSink = (s: { kind: FeedbackSignalKind; intent: string; evidence: string }) => Promise<void>;

export interface FeedbackInput {
  memoryId: string;
  verdict: FeedbackVerdict;
  /** The request the memory was returned for. Used only to form an intent key; never stored raw by this module. */
  intent: string;
  /** Telemetry consent. Without it nothing is sent to SAI-11, but the verdict is still kept. */
  optedIn: boolean;
}
export type FeedbackSignalState = "not_requested" | "sent" | "failed";
export interface FeedbackResult { id: string; signalState: FeedbackSignalState }

export async function recordRetrievalFeedback(sql: Sql, actor: Actor, projectId: string, input: FeedbackInput, sink?: SignalSink): Promise<FeedbackResult> {
  await requireActor(sql, actor, READER_ROLES);
  await requireProject(sql, actor.organizationId, projectId);
  if (!(FEEDBACK_VERDICTS as readonly string[]).includes(input.verdict)) throw new MemoryError("INVALID_CLAIM", "feedback verdict must be useful, wrong, stale or missing");
  const [m] = await sql<{ id: string }[]>`SELECT id FROM memory_records WHERE id = ${input.memoryId} AND organization_id = ${actor.organizationId} AND project_id = ${projectId}`;
  if (!m) throw new MemoryError("NOT_FOUND", "no such memory in this project");

  let signalState: FeedbackSignalState = "not_requested";
  if (input.verdict !== "useful" && input.optedIn && sink) {
    const intent = input.intent.trim();
    if (!intent) throw new MemoryError("INVALID_QUERY", "a non-useful verdict needs the request it was returned for");
    try {
      // The evidence is the memory id and verdict only: no claim text leaves the database through feedback.
      await sink({ kind: SIGNAL_KIND[input.verdict], intent, evidence: `${input.memoryId}:${input.verdict}` });
      signalState = "sent";
    } catch {
      // SAI-11 unavailable or rejected the signal. The verdict is kept; the caller can see the state and nothing is retried silently.
      signalState = "failed";
    }
  }

  const [row] = await sql<{ id: string }[]>`INSERT INTO memory_feedback (organization_id, project_id, memory_id, actor_id, verdict, signal_state)
    VALUES (${actor.organizationId}, ${projectId}, ${input.memoryId}, ${actor.userId}, ${input.verdict}, ${signalState}) RETURNING id`;
  if (!row) throw new MemoryError("DB_REJECTED", "feedback row was not stored");
  return { id: row.id, signalState };
}
