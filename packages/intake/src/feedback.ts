import { appendEvent, ConflictError, type Sql } from "@factory/db";
import { digestOf, redactString } from "@factory/telemetry";

export class FeedbackRejected extends Error {
  constructor(readonly code: "not-awaiting-info" | "version-conflict" | "too-long", message: string) { super(message); this.name = "FeedbackRejected"; }
}

/** Number of requester answers so far; intake artifacts are versioned by it so each round gets a fresh, immutable artifact. */
export async function intakeRound(sql: Sql, jobId: string): Promise<number> {
  return ((await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM events WHERE job_id = ${jobId} AND type = 'job.feedback'`)[0]?.c) ?? 0;
}

/** Records an answer and resumes intake (NEEDS_INFO -> INTAKE) atomically; all earlier artifacts and history are preserved. */
export async function answerQuestions(sql: Sql, a: { jobId: string; actorId: string; message: string; expectedVersion: number }): Promise<{ version: number }> {
  if (a.message.length < 1 || a.message.length > 10_000) throw new FeedbackRejected("too-long", "message must be 1..10000 characters");
  return sql.begin(async (tx) => {
    const [j] = await tx<{ state: string; version: number }[]>`SELECT state, version FROM jobs WHERE id = ${a.jobId} FOR UPDATE`;
    if (!j) throw new Error("unknown job");
    if (j.version !== a.expectedVersion) throw new FeedbackRejected("version-conflict", `job version is ${j.version}`);
    if (j.state !== "NEEDS_INFO") throw new FeedbackRejected("not-awaiting-info", `job is ${j.state}, not NEEDS_INFO`);
    const version = j.version + 1;
    await tx`UPDATE jobs SET state = 'INTAKE', version = ${version} WHERE id = ${a.jobId}`;
    await tx`INSERT INTO job_transitions (job_id, from_state, to_state, version, actor_id, evidence_digest) VALUES (${a.jobId}, 'NEEDS_INFO', 'INTAKE', ${version}, ${a.actorId}, ${digestOf({ feedback: true })})`;
    await appendEvent(tx, { jobId: a.jobId, type: "job.feedback", source: "api", actorId: a.actorId, payload: { message: redactString(a.message) } });
    await appendEvent(tx, { jobId: a.jobId, type: "job.transitioned", source: "api", actorId: a.actorId, payload: { from: "NEEDS_INFO", to: "INTAKE", version } });
    return { version };
  }).catch((e) => { if (e instanceof ConflictError) throw new FeedbackRejected("version-conflict", e.message); throw e; });
}
