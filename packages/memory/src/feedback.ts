import type { Sql } from "@factory/db";
import { MemoryError, READER_ROLES } from "./domain";
import { type Actor, requireActor, requireProject } from "./lifecycle";

/**
 * Retrieval feedback (MEM-06). A user says whether a returned memory was useful, wrong, stale or missing. The verdict is stored with
 * no free text. A non-useful verdict with consent is sent as a gap signal through a SignalSink supplied by the caller. The sink runs in
 * the same transaction as the feedback row (inside a savepoint): if the sink fails, only its own write is undone and the row records
 * `failed`; if the row cannot be stored, the signal is undone too. Feedback never changes a memory or approves anything.
 */
export const FEEDBACK_VERDICTS = ["useful", "wrong", "stale", "missing"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];
export type FeedbackSignalKind = "low_quality" | "user_correction" | "uncovered_request";
const SIGNAL_KIND: Readonly<Record<Exclude<FeedbackVerdict, "useful">, FeedbackSignalKind>> = {
  wrong: "low_quality",
  stale: "user_correction",
  missing: "uncovered_request",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sends one gap signal, using the executor it is given (the feedback transaction's savepoint). `subject` is a fixed label derived from
 * the memory's kind; NO request text, claim text or user identifier is passed. `optedIn` is the consent the caller asserted; the
 * intake must refuse when it is false.
 */
export type SignalSink = (s: { organizationId: string; kind: FeedbackSignalKind; subject: string; evidence: string; optedIn: boolean; workspaceId: string }, q: Sql) => Promise<void>;

export interface FeedbackInput {
  memoryId: string;
  verdict: FeedbackVerdict;
  /** Telemetry consent for this project. Without it nothing is sent to SAI-11, but the verdict is still kept. */
  optedIn: boolean;
}
export type FeedbackSignalState = "not_requested" | "sent" | "failed";
export interface FeedbackResult { id: string; signalState: FeedbackSignalState }

export async function recordRetrievalFeedback(sql: Sql, actor: Actor, projectId: string, input: FeedbackInput, sink?: SignalSink): Promise<FeedbackResult> {
  await requireActor(sql, actor, READER_ROLES);
  await requireProject(sql, actor.organizationId, projectId);
  if (!(FEEDBACK_VERDICTS as readonly string[]).includes(input.verdict)) throw new MemoryError("INVALID_CLAIM", "feedback verdict must be useful, wrong, stale or missing");
  if (!UUID.test(input.memoryId)) throw new MemoryError("NOT_FOUND", "no such memory in this project");
  const [m] = await sql<{ id: string; kind: string }[]>`SELECT id, kind FROM memory_records WHERE id = ${input.memoryId} AND organization_id = ${actor.organizationId} AND project_id = ${projectId}`;
  if (!m) throw new MemoryError("NOT_FOUND", "no such memory in this project");

  return sql.begin(async (tx) => {
    let signalState: FeedbackSignalState = "not_requested";
    if (input.verdict !== "useful" && input.optedIn) {
      if (!sink) {
        // Consent was given but no SAI-11 intake is wired: the signal was not sent, and the row says so.
        signalState = "failed";
      } else {
        try {
          await tx.savepoint((sp) => sink({ organizationId: actor.organizationId, kind: SIGNAL_KIND[input.verdict as Exclude<FeedbackVerdict, "useful">], subject: `memory retrieval ${m.kind}`, evidence: `${input.memoryId}:${input.verdict}`, optedIn: true, workspaceId: projectId }, sp as unknown as Sql));
          signalState = "sent";
        } catch {
          signalState = "failed";
        }
      }
    }
    const [row] = await tx<{ id: string }[]>`INSERT INTO memory_feedback (organization_id, project_id, memory_id, actor_id, verdict, signal_state)
      VALUES (${actor.organizationId}, ${projectId}, ${input.memoryId}, ${actor.userId}, ${input.verdict}, ${signalState}) RETURNING id`;
    if (!row) throw new MemoryError("DB_REJECTED", "feedback row was not stored");
    return { id: row.id, signalState };
  }) as Promise<FeedbackResult>;
}
