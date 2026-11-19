import { effectiveRisk } from "@factory/domain";
import type { Sql } from "@factory/db";
import { classifyText, precheck } from "./classify";
import { decideIntake, type IntakeOutcome } from "./decide";
import { intakeRound } from "./feedback";
import type { ContextStore } from "./context";

export interface IntakeResultLike {
  next: "SPECIFYING" | "NEEDS_INFO" | "REJECTED";
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

async function loadText(sql: Sql, jobId: string) {
  const [r] = await sql<{ title: string; description: string }[]>`SELECT q.title, q.description FROM jobs j JOIN requests q ON q.id = j.request_id WHERE j.id = ${jobId}`;
  if (!r) throw new Error(`unknown job ${jobId}`);
  const feedback = (await sql<{ payload_redacted: { message?: string } }[]>`SELECT payload_redacted FROM events WHERE job_id = ${jobId} AND type = 'job.feedback' ORDER BY sequence`).map((e) => e.payload_redacted.message ?? "");
  return { title: r.title, description: r.description, feedback };
}

const toResult = (o: IntakeOutcome): IntakeResultLike => ({
  next: o.next,
  risk: o.risk,
  events: [
    {
      type: "intake.decision",
      payload: {
        outcome: o.next, risk: o.risk, deterministic_floor: o.classification.minimumRisk, floor_reasons: o.classification.reasons,
        injection_suspected: o.classification.injectionSuspected, injection_signals: o.classification.injectionSignals, secrets_redacted: o.classification.secretsRedacted,
        acceptance_criteria: o.decision?.acceptance_criteria.length ?? 0, ...(o.invalid ? { invalid_output: o.invalid } : {}),
      },
    },
    ...(o.questions.length ? [{ type: "intake.questions", payload: { questions: o.questions, reasons: o.reasons } }] : []),
  ],
});

/** Orchestrator-facing intake logic backed by the database and the artifact store. */
export function createIntakeHandler(d: { sql: Sql; store: ContextStore }) {
  return {
    /** Deterministic ambiguity screen: ambiguous requests go to NEEDS_INFO without spending any model time. */
    async pre(job: { id: string }): Promise<IntakeResultLike | null> {
      const t = await loadText(d.sql, job.id);
      const p = precheck(t.title, [t.description, ...t.feedback].join("\n"));
      if (p.ok) return null;
      const cls = classifyText(t.title, t.description, ...t.feedback);
      const risk = effectiveRisk(cls.minimumRisk, undefined);
      return toResult({ next: "NEEDS_INFO", risk, decision: null, classification: cls, reasons: p.reasons, questions: p.questions });
    },
    async decide(job: { id: string }): Promise<IntakeResultLike> {
      const n = await intakeRound(d.sql, job.id);
      const [a] = await d.sql<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${job.id} AND kind = ${`intake.r${n}.json`} LIMIT 1`;
      let output: unknown = null;
      if (a) { try { output = JSON.parse(d.store.get(a.digest).toString("utf8")); } catch { output = null; } }
      return toResult(decideIntake(output, await loadText(d.sql, job.id)));
    },
  };
}
