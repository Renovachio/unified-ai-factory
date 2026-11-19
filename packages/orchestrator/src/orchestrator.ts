import { appendEvent, ConflictError, transitionJob, type Q, type Sql } from "@factory/db";
import {
  assertTransition, RECOVERY_ONLY_STATES, TERMINAL_STATES, type EvidenceBinding, type JobSnapshot, type JobState, type RiskLevel,
} from "@factory/domain";
import { enqueueTask, expireLeases, revokeJobLeases } from "@factory/scheduler";
import { digestOf } from "@factory/telemetry";
import { artifactKind, AGENT_STAGES, taskStage } from "./pipeline";
import type { JobCtx, Ports } from "./ports";

export type FaultHook = (point: string) => void | Promise<void>;

export interface OrchestratorOptions {
  sql: Sql;
  ports: Ports;
  actor?: string;
  now?: () => Date;
  /** Test seam: throw from here to simulate a crash at a named point. */
  fault?: FaultHook;
}

export type TickAction =
  | "transitioned" | "waiting" | "enqueued" | "terminal" | "paused" | "awaiting-human" | "conflict";
export interface TickResult { state: JobState; action: TickAction; detail?: string }

const sha = (h: string) => /^[a-f0-9]{40}$/.test(h);

/**
 * Durable orchestrator. `tick` performs at most one unit of progress for a job and is safe to call repeatedly,
 * concurrently, and after a crash at any point: all progress lives in Postgres (tasks, artifacts, evidence rows, transitions)
 * and every side effect is idempotent or committed in the same transaction as the state transition.
 */
export class Orchestrator {
  private readonly actor: string;
  constructor(private readonly o: OrchestratorOptions) { this.actor = o.actor ?? "orchestrator"; }
  private hit(point: string) { return this.o.fault?.(point); }

  async load(jobId: string, q: Q = this.o.sql): Promise<JobCtx & { pausedAt: Date | null }> {
    const [r] = await (q as Sql)<{ id: string; repository_id: string; state: JobState; version: number; risk: RiskLevel; head_sha: string | null; base_sha: string | null; current_round: number; max_rounds: number; pr_number: number | null; paused_at: Date | null }[]>`
      SELECT id, repository_id, state, version, risk, head_sha, base_sha, current_round, max_rounds, pr_number, paused_at FROM jobs WHERE id = ${jobId}`;
    if (!r) throw new Error(`unknown job ${jobId}`);
    return { id: r.id, repositoryId: r.repository_id, state: r.state, version: r.version, risk: r.risk, headSha: r.head_sha, baseSha: r.base_sha, round: r.current_round, maxRounds: r.max_rounds, prNumber: r.pr_number, pausedAt: r.paused_at };
  }

  /** Evidence bindings for the domain guards, reconstructed from durable rows. */
  private async snapshot(tx: Q, jobId: string): Promise<JobSnapshot> {
    const q = tx as Sql;
    const job = await this.load(jobId, tx);
    const [j2] = await q<{ policy_digest: string | null; spec_digest: string | null }[]>`SELECT policy_digest, spec_digest FROM jobs WHERE id = ${jobId}`;
    const roles = this.o.ports.review.requiredRoles(job).slice().sort();
    const common = { repoId: job.repositoryId, policyDigest: j2?.policy_digest ?? "none", reviewerSetDigest: digestOf(roles), artifactDigest: j2?.spec_digest ?? "none", policyVersion: "1" };
    const [gate] = await q<{ head_sha: string; base_sha: string; gate_config_digest: string; verdict: string }[]>`
      SELECT head_sha, base_sha, gate_config_digest, verdict FROM gate_results WHERE job_id = ${jobId} AND verdict = 'pass' ORDER BY created_at DESC LIMIT 1`;
    const current: EvidenceBinding | undefined = job.headSha && job.baseSha && gate
      ? { ...common, headSha: job.headSha, baseSha: job.baseSha, gateConfigDigest: gate.gate_config_digest } : undefined;
    const gateB: EvidenceBinding | undefined = gate ? { ...common, headSha: gate.head_sha, baseSha: gate.base_sha, gateConfigDigest: gate.gate_config_digest } : undefined;
    const revs = job.headSha ? await q<{ reviewer_role: string; head_sha: string }[]>`
      SELECT DISTINCT reviewer_role, head_sha FROM review_results WHERE job_id = ${jobId} AND verdict = 'pass' AND head_sha = ${job.headSha}` : [];
    return {
      state: job.state, version: job.version, risk: job.risk, headSha: job.headSha ?? undefined, gate: gateB, current,
      reviews: current ? revs.map((r) => ({ role: r.reviewer_role, binding: { ...current, headSha: r.head_sha } })) : [],
      requiredReviewers: roles, round: job.round, maxRounds: job.maxRounds, pausedAt: job.pausedAt?.toISOString(),
    };
  }

  private async move(job: JobCtx, next: JobState, evidence: Record<string, unknown>, write?: (tx: Q) => Promise<void>): Promise<TickResult> {
    await this.hit(`before-transition:${job.state}->${next}`);
    try {
      await transitionJob(this.o.sql, {
        jobId: job.id, expectedVersion: job.version, next, actor: this.actor, evidence,
        guard: async (_row, tx) => {
          if (write) await write(tx);
          assertTransition(await this.snapshot(tx, job.id), next);
        },
      });
    } catch (e) {
      if (e instanceof ConflictError) return { state: job.state, action: "conflict" };
      throw e;
    }
    await this.hit(`after-transition:${job.state}->${next}`);
    return { state: next, action: "transitioned" };
  }

  /** One unit of progress. */
  async tick(jobId: string): Promise<TickResult> {
    await expireLeases(this.o.sql, { ...(this.o.now ? { now: this.o.now() } : {}) });
    const job = await this.load(jobId);
    if ((TERMINAL_STATES as readonly string[]).includes(job.state)) return { state: job.state, action: "terminal" };
    if ((RECOVERY_ONLY_STATES as readonly string[]).includes(job.state)) return { state: job.state, action: "terminal", detail: "explicit authorised recovery required" };
    if (job.pausedAt) return { state: job.state, action: "paused" };

    const stage = AGENT_STAGES[job.state];
    if (stage) return this.runAgentSteps(job, stage);

    switch (job.state) {
      case "QUEUED": return this.move(job, "INTAKE", {});
      case "READY": return this.move(job, "PROVISIONING", {});
      case "PROVISIONING": {
        const { baseSha } = await this.o.ports.scm.prepare(job);
        await this.hit("after-port:scm.prepare");
        if (!sha(baseSha)) throw new Error("scm.prepare returned an invalid SHA");
        return this.move(job, "BUILDING", { baseSha }, async (tx) => { await (tx as Sql)`UPDATE jobs SET base_sha = ${baseSha} WHERE id = ${job.id}`; });
      }
      case "GATING": return this.gate(job);
      case "REVIEWING": return this.review(job);
      case "REWORK": {
        if (job.round + 1 > job.maxRounds) return this.move(job, "AWAITING_HUMAN", { reason: "rework-budget-exhausted" });
        return this.move(job, "BUILDING", { round: job.round + 1 }, async (tx) => { await (tx as Sql)`UPDATE jobs SET current_round = current_round + 1 WHERE id = ${job.id}`; });
      }
      case "PREMERGE": return this.premerge(job);
      case "AWAITING_HUMAN": return { state: job.state, action: "awaiting-human" };
      default: return { state: job.state, action: "waiting", detail: "no handler" };
    }
  }

  private async runAgentSteps(job: JobCtx, stage: NonNullable<(typeof AGENT_STAGES)[JobState]>): Promise<TickResult> {
    const q = this.o.sql;
    for (const step of stage.steps) {
      const kind = artifactKind(step, job.round);
      const [have] = await q<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${job.id} AND kind = ${kind} LIMIT 1`;
      if (have) continue;
      const taskId = await enqueueTask(q, { jobId: job.id, stage: taskStage(job.state, step, job.round), role: step.role });
      await this.hit("after-enqueue");
      const [t] = await q<{ status: string }[]>`SELECT status FROM tasks WHERE id = ${taskId}`;
      if (t?.status === "failed") return this.fail(job, `task-failed:${step.role}`);
      if (t?.status === "cancelled") return { state: job.state, action: "waiting", detail: "task cancelled" };
      return { state: job.state, action: t?.status === "pending" ? "enqueued" : "waiting", detail: `${step.role}:${t?.status}` };
    }
    // All artifacts present. Stage-specific bookkeeping happens atomically with the transition.
    if (job.state === "BUILDING") {
      const { headSha } = await this.o.ports.scm.commitCandidate(job, job.round);
      await this.hit("after-port:scm.commitCandidate");
      if (!sha(headSha)) throw new Error("scm.commitCandidate returned an invalid SHA");
      return this.move(job, "GATING", { headSha }, async (tx) => { await (tx as Sql)`UPDATE jobs SET head_sha = ${headSha} WHERE id = ${job.id}`; });
    }
    if (job.state === "SPECIFYING") {
      const [spec] = await q<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${job.id} AND kind = 'spec.json' LIMIT 1`;
      return this.move(job, stage.next, { spec: spec?.digest }, async (tx) => { await (tx as Sql)`UPDATE jobs SET spec_digest = ${spec?.digest ?? null} WHERE id = ${job.id}`; });
    }
    return this.move(job, stage.next, {});
  }

  private async gate(job: JobCtx): Promise<TickResult> {
    if (!job.headSha || !job.baseSha) return this.fail(job, "gate-without-candidate");
    const { headSha, baseSha } = job;
    const r = await this.o.ports.gate.run(job, headSha, baseSha);
    await this.hit("after-port:gate.run");
    const write = async (tx: Q) => {
      await (tx as Sql)`INSERT INTO gate_results (job_id, head_sha, base_sha, gate_config_digest, verdict, results_digest)
        VALUES (${job.id}, ${headSha}, ${baseSha}, ${r.configDigest}, ${r.verdict}, ${r.resultsDigest}) ON CONFLICT DO NOTHING`;
    };
    if (r.verdict === "pass") return this.move(job, "REVIEWING", { gate: r.resultsDigest }, write);
    return this.move(job, "REWORK", { gate: r.resultsDigest, verdict: r.verdict }, write);
  }

  private async review(job: JobCtx): Promise<TickResult> {
    if (!job.headSha) return this.fail(job, "review-without-candidate");
    const head = job.headSha;
    const roles = this.o.ports.review.requiredRoles(job);
    const results: Array<{ role: string; verdict: string; findingsDigest: string }> = [];
    for (const role of roles) {
      const r = await this.o.ports.review.run(job, role, head);
      results.push({ role, ...r });
      await this.hit(`after-port:review.${role}`);
    }
    const write = async (tx: Q) => {
      for (const r of results) {
        await (tx as Sql)`INSERT INTO review_results (job_id, head_sha, reviewer_role, verdict, findings_digest)
          SELECT ${job.id}, ${head}, ${r.role}, ${r.verdict}, ${r.findingsDigest}
          WHERE NOT EXISTS (SELECT 1 FROM review_results WHERE job_id = ${job.id} AND head_sha = ${head} AND reviewer_role = ${r.role} AND findings_digest = ${r.findingsDigest})`;
      }
    };
    const allPass = results.every((r) => r.verdict === "pass");
    return this.move(job, allPass ? "PREMERGE" : "REWORK", { reviews: results.map((r) => `${r.role}:${r.verdict}`) }, write);
  }

  private async premerge(job: JobCtx): Promise<TickResult> {
    if (!job.headSha) return this.fail(job, "premerge-without-candidate");
    const head = job.headSha;
    const pol = await this.o.ports.policy.evaluate(job, head);
    await this.hit("after-port:policy.evaluate");
    const pr = await this.o.ports.scm.ensureDraftPr(job, head);
    await this.hit("after-port:scm.ensureDraftPr");
    return this.move(job, "AWAITING_HUMAN", { policy: pol.policyDigest, pr: pr.prNumber }, async (tx) => {
      const q = tx as Sql;
      await q`UPDATE jobs SET policy_digest = ${pol.policyDigest}, pr_number = ${pr.prNumber}, risk = ${pol.risk} WHERE id = ${job.id}`;
      await q`INSERT INTO policy_decisions (job_id, head_sha, policy_digest, risk, eligible, reasons)
        SELECT ${job.id}, ${head}, ${pol.policyDigest}, ${pol.risk}, ${pol.eligible && (pol.risk === "LOW" || pol.risk === "MEDIUM")}, ${q.json(pol.reasons as never)}
        WHERE NOT EXISTS (SELECT 1 FROM policy_decisions WHERE job_id = ${job.id} AND head_sha = ${head} AND policy_digest = ${pol.policyDigest})`;
      await appendEvent(q, { jobId: job.id, type: "approval.requested", source: "orchestrator", payload: { head_sha: head, pr_number: pr.prNumber, reasons: pol.reasons } });
    });
  }

  private async fail(job: JobCtx, code: string): Promise<TickResult> {
    const r = await this.move(job, "FAILED", { code }, async (tx) => { await (tx as Sql)`UPDATE jobs SET last_error_code = ${code} WHERE id = ${job.id}`; });
    if (r.action === "transitioned") await revokeJobLeases(this.o.sql, job.id, code);
    return r;
  }

  /** Cancellation: revoke capabilities first, then record the transition (idempotent). */
  async cancel(jobId: string, reason: string, actor = this.actor): Promise<TickResult> {
    const job = await this.load(jobId);
    if ((TERMINAL_STATES as readonly string[]).includes(job.state)) return { state: job.state, action: "terminal" };
    await revokeJobLeases(this.o.sql, jobId, reason);
    try {
      await transitionJob(this.o.sql, { jobId, expectedVersion: job.version, next: "CANCELLED", actor, reason, guard: () => assertTransition({ state: job.state, version: job.version, risk: job.risk, round: job.round, maxRounds: job.maxRounds }, "CANCELLED") });
    } catch (e) {
      if (e instanceof ConflictError) return this.cancel(jobId, reason, actor);
      throw e;
    }
    return { state: "CANCELLED", action: "transitioned" };
  }
}
