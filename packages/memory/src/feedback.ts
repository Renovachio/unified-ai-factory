import type postgres from "postgres";
import type { Sql } from "@factory/db";
import { MemoryError, READER_ROLES } from "./domain";
import { type Actor, requireActor, requireProject } from "./lifecycle";
import { telemetryOptedIn } from "./consent";

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
}
export type FeedbackSignalState = "not_requested" | "sent" | "failed";
export interface FeedbackResult { id: string; signalState: FeedbackSignalState }

/** The transaction handle the client passes to begin(); it has savepoint(). */
type Tx = postgres.TransactionSql;

/** Sends one signal inside the given transaction's savepoint. Returns the state to record; never throws. */
async function sendInSavepoint(tx: Tx, sink: SignalSink | undefined, organizationId: string, projectId: string, memoryId: string, kind: string, verdict: FeedbackVerdict, optedIn: boolean): Promise<FeedbackSignalState> {
  // optedIn is read from the database by the caller (telemetryOptedIn); it is never taken from the request.
  if (verdict === "useful" || !optedIn) return "not_requested";
  if (!sink) return "failed"; // consent given but no SAI-11 intake wired: not sent, and the row says so
  try {
    await tx.savepoint((sp) => sink({ organizationId, kind: SIGNAL_KIND[verdict as Exclude<FeedbackVerdict, "useful">], subject: `memory retrieval ${kind}`, evidence: `${memoryId}:${verdict}`, optedIn: true, workspaceId: projectId }, sp as unknown as Sql));
    return "sent";
  } catch {
    return "failed";
  }
}

export async function recordRetrievalFeedback(sql: Sql, actor: Actor, projectId: string, input: FeedbackInput, sink?: SignalSink): Promise<FeedbackResult> {
  await requireActor(sql, actor, READER_ROLES);
  await requireProject(sql, actor.organizationId, projectId);
  if (!(FEEDBACK_VERDICTS as readonly string[]).includes(input.verdict)) throw new MemoryError("INVALID_CLAIM", "feedback verdict must be useful, wrong, stale or missing");
  if (!UUID.test(input.memoryId)) throw new MemoryError("NOT_FOUND", "no such memory in this project");
  const [m] = await sql<{ id: string; kind: string }[]>`SELECT id, kind FROM memory_records WHERE id = ${input.memoryId} AND organization_id = ${actor.organizationId} AND project_id = ${projectId}`;
  if (!m) throw new MemoryError("NOT_FOUND", "no such memory in this project");
  return sql.begin(async (tx) => {
    const optedIn = await telemetryOptedIn(tx, actor.organizationId, projectId, true);
    const signalState = await sendInSavepoint(tx, sink, actor.organizationId, projectId, input.memoryId, m.kind, input.verdict, optedIn);
    const [row] = await tx<{ id: string }[]>`INSERT INTO memory_feedback (organization_id, project_id, memory_id, actor_id, verdict, signal_state)
      VALUES (${actor.organizationId}, ${projectId}, ${input.memoryId}, ${actor.userId}, ${input.verdict}, ${signalState}) RETURNING id`;
    if (!row) throw new MemoryError("DB_REJECTED", "feedback row was not stored");
    return { id: row.id, signalState };
  }) as Promise<FeedbackResult>;
}

export interface RetryReport { attempted: number; sent: number; failed: number; skipped: number }

/**
 * Re-sends gap signals whose first attempt failed. Each retry is a NEW row pointing at the failed one (retry_of). A failed row is
 * retried at most once: a retry that fails again is final. Consent is read per row, inside that row's transaction, under the project
 * share lock; if consent is off when a row is reached, the batch stops. A row already retried by a concurrent call is skipped
 * (unique index on retry_of); its signal rolls back with its transaction.
 */
export async function retryFailedSignals(sql: Sql, actor: Actor, projectId: string, sink: SignalSink | undefined, limit = 100): Promise<RetryReport> {
  await requireActor(sql, actor, READER_ROLES);
  await requireProject(sql, actor.organizationId, projectId);
  const report: RetryReport = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  if (!sink) return report;
  const pending = await sql<{ id: string; memory_id: string; verdict: FeedbackVerdict; kind: string }[]>`
    SELECT f.id, f.memory_id, f.verdict, m.kind FROM memory_feedback f JOIN memory_records m ON m.id = f.memory_id
    WHERE f.organization_id = ${actor.organizationId} AND f.project_id = ${projectId} AND f.signal_state = 'failed' AND f.retry_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM memory_feedback r WHERE r.retry_of = f.id)
    ORDER BY f.created_at, f.id LIMIT ${limit}`;
  for (const f of pending) {
    report.attempted++;
    try {
      const state = await sql.begin(async (tx) => {
        const optedIn = await telemetryOptedIn(tx, actor.organizationId, projectId, true);
        if (!optedIn) return "stop" as const;
        const st = await sendInSavepoint(tx, sink, actor.organizationId, projectId, f.memory_id, f.kind, f.verdict, true);
        await tx`INSERT INTO memory_feedback (organization_id, project_id, memory_id, actor_id, verdict, signal_state, retry_of)
          VALUES (${actor.organizationId}, ${projectId}, ${f.memory_id}, ${actor.userId}, ${f.verdict}, ${st}, ${f.id})`;
        return st;
      });
      if (state === "stop") { report.attempted--; break; }
      if (state === "sent") report.sent++; else report.failed++;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") { report.skipped++; continue; }
      throw e;
    }
  }
  return report;
}
