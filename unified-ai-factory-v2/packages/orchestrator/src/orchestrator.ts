import { appendEvent, ConflictError, transitionJob, type Q, type Sql } from "@factory/db";
import {
  assertTransition, maxRisk, RECOVERY_ONLY_STATES, TERMINAL_STATES, type JobSnapshot, type JobState, type RiskLevel,
} from "@factory/domain";
import { enqueueTask, expireLeases, revokeJobLeases } from "@factory/scheduler";
import { artifactKind, AGENT_STAGES, taskStage } from "./pipeline";
import { loadJobSnapshot } from "./snapshot";
import type { IntakeHandler, JobCtx, MergePort, Ports, SpecHandler } from "./ports";

/** Automated fix attempts allowed per gate-failure class (blueprint section 5). */
export const MAX_FIXES_PER_CLASS = 2;
/** Attempts to obtain a usable report from the same reviewer for the same SHA before the job stops for a human. */
export const MAX_REVIEW_INVALID = 2;
export const REVIEW_CONCURRENCY = 2;
/** Failure classes that indicate tampering or an untrustworthy gate: no automated retry, straight to a human. */
export const ESCALATE_IMMEDIATELY_CLASSES: readonly string[] = ["manifest-mismatch", "checks-tampered", "head-mismatch"];

export type FaultHook = (point: string) => void | Promise<void>;

export interface OrchestratorOptions {
  sql: Sql;
  ports: Ports;
  /** Trusted intake logic; when absent every request is accepted unchanged (mock pipeline). */
  intake?: IntakeHandler;
  /** Trusted traceability validation of the specification; when absent the spec is accepted unchanged (mock pipeline). */
  spec?: SpecHandler;
  /** Privileged merge coordinator. Without it the orchestrator never merges (it stops at AWAITING_HUMAN). */
  merge?: MergePort;
  actor?: string;
  now?: () => Date;
  /** Test seam: throw from here to simulate a crash at a named point. */
  fault?: FaultHook;
}

export type TickAction =
  | "transitioned" | "waiting" | "enqueued" | "terminal" | "paused" | "awaiting-human" | "awaiting-info" | "conflict";
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

  /** Evidence bindings for the domain guards, reconstructed from durable rows (see snapshot.ts). */
  private snapshot(tx: Q, jobId: string): Promise<JobSnapshot> { return loadJobSnapshot(tx, this.o.ports.review, jobId); }

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
        // At most MAX_FIXES_PER_CLASS automated fixes per gate failure class; the next failure of that class goes to a human.
        const [lastFail] = await this.o.sql<{ cls: string | null }[]>`SELECT payload_redacted->>'class' AS cls FROM events WHERE job_id = ${job.id} AND type = 'gate.failed' ORDER BY sequence DESC LIMIT 1`;
        if (lastFail?.cls && ESCALATE_IMMEDIATELY_CLASSES.includes(lastFail.cls)) return this.move(job, "AWAITING_HUMAN", { reason: `untrusted-gate:${lastFail.cls}` });
        if (lastFail?.cls) {
          const [cnt] = await this.o.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM events WHERE job_id = ${job.id} AND type = 'gate.failed' AND payload_redacted->>'class' = ${lastFail.cls}`;
          if ((cnt?.c ?? 0) > MAX_FIXES_PER_CLASS) return this.move(job, "AWAITING_HUMAN", { reason: `fix-budget-exhausted:${lastFail.cls}` });
        }
        return this.move(job, "BUILDING", { round: job.round + 1 }, async (tx) => { await (tx as Sql)`UPDATE jobs SET current_round = current_round + 1 WHERE id = ${job.id}`; });
      }
      case "PREMERGE": {
        if (this.o.merge && job.headSha) {
          const [ap] = await this.o.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM approvals WHERE job_id = ${job.id} AND head_sha = ${job.headSha} AND decision = 'approve'`;
          if ((ap?.c ?? 0) > 0) return this.mergeStep(job);
        }
        return this.premerge(job);
      }
      case "MERGING": return this.o.merge ? this.mergeStep(job) : { state: job.state, action: "waiting", detail: "no merge coordinator" };
      case "MERGED":
      case "POSTMERGE_MONITOR": return { state: job.state, action: "waiting", detail: "post-merge monitoring" };
      case "NEEDS_INFO": return { state: job.state, action: "awaiting-info" };
      case "AWAITING_HUMAN": return { state: job.state, action: "awaiting-human" };
      default: return { state: job.state, action: "waiting", detail: "no handler" };
    }
  }

  private async runAgentSteps(job: JobCtx, stage: NonNullable<(typeof AGENT_STAGES)[JobState]>): Promise<TickResult> {
    const q = this.o.sql;
    if (job.state === "INTAKE" && this.o.intake) {
      const pre = await this.o.intake.pre(job);
      if (pre) return this.applyIntake(job, pre);
    }
    const intakeN = ((await q<{ c: number }[]>`SELECT count(*)::int AS c FROM events WHERE job_id = ${job.id} AND type = 'job.feedback'`)[0]?.c) ?? 0;
    for (const step of stage.steps) {
      const n = step.scope === "intake" ? intakeN : job.round;
      const kind = artifactKind(step, n);
      const [have] = await q<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${job.id} AND kind = ${kind} LIMIT 1`;
      if (have) continue;
      const taskId = await enqueueTask(q, { jobId: job.id, stage: taskStage(job.state, step, n), role: step.role });
      await this.hit("after-enqueue");
      const [t] = await q<{ status: string }[]>`SELECT status FROM tasks WHERE id = ${taskId}`;
      if (t?.status === "failed") return this.fail(job, `task-failed:${step.role}`);
      if (t?.status === "cancelled") return { state: job.state, action: "waiting", detail: "task cancelled" };
      return { state: job.state, action: t?.status === "pending" ? "enqueued" : "waiting", detail: `${step.role}:${t?.status}` };
    }
    // All artifacts present. Stage-specific bookkeeping happens atomically with the transition.
    if (job.state === "INTAKE" && this.o.intake) return this.applyIntake(job, await this.o.intake.decide(job));
    if (job.state === "BUILDING") {
      const { headSha } = await this.o.ports.scm.commitCandidate(job, job.round);
      await this.hit("after-port:scm.commitCandidate");
      if (!sha(headSha)) throw new Error("scm.commitCandidate returned an invalid SHA");
      return this.move(job, "GATING", { headSha }, async (tx) => { await (tx as Sql)`UPDATE jobs SET head_sha = ${headSha} WHERE id = ${job.id}`; });
    }
    if (job.state === "SPECIFYING") {
      const [spec] = await q<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${job.id} AND kind = 'spec.json' LIMIT 1`;
      const v = this.o.spec ? await this.o.spec.validate(job) : { ok: true, errors: [] as string[], riskFloor: "LOW" as RiskLevel, specDigest: spec?.digest, traceabilityDigest: undefined as string | undefined };
      await this.hit("after-port:spec.validate");
      if (!v.ok) {
        // An untraceable specification never reaches the builder. FAILED requires explicit authorised recovery.
        const r = await this.move(job, "FAILED", { code: "spec-traceability" }, async (tx) => {
          await (tx as Sql)`UPDATE jobs SET last_error_code = 'spec-traceability' WHERE id = ${job.id}`;
          await appendEvent(tx, { jobId: job.id, type: "spec.rejected", source: "orchestrator", payload: { errors: v.errors.slice(0, 50) } });
        });
        if (r.action === "transitioned") await revokeJobLeases(this.o.sql, job.id, "spec-traceability");
        return r;
      }
      return this.move(job, stage.next, { spec: v.specDigest, traceability: v.traceabilityDigest }, async (tx) => {
        const t = tx as Sql;
        await t`UPDATE jobs SET spec_digest = ${v.specDigest ?? null} WHERE id = ${job.id}`;
        // Protected-path touches ratchet the risk floor up (never down).
        const cur = (await t<{ risk: RiskLevel; risk_classified: boolean }[]>`SELECT risk, risk_classified FROM jobs WHERE id = ${job.id}`)[0];
        if (cur && v.riskFloor !== "LOW") await t`UPDATE jobs SET risk = ${cur.risk_classified ? maxRisk(cur.risk, v.riskFloor) : maxRisk(v.riskFloor, "MEDIUM")}, risk_classified = true WHERE id = ${job.id}`;
        if (v.traceabilityDigest) await appendEvent(tx, { jobId: job.id, type: "spec.accepted", source: "orchestrator", payload: { traceability: v.traceabilityDigest, risk_floor: v.riskFloor } });
      });
    }
    return this.move(job, stage.next, {});
  }

  private async applyIntake(job: JobCtx, r: import("./ports").IntakeResult): Promise<TickResult> {
    return this.move(job, r.next, { intake: r.next, risk: r.risk }, async (tx) => {
      await (tx as Sql)`UPDATE jobs SET risk = ${r.risk}, risk_classified = true WHERE id = ${job.id}`;
      for (const e of r.events) await appendEvent(tx, { jobId: job.id, type: e.type, source: "orchestrator", payload: e.payload });
    });
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
    if (r.verdict === "pass") {
      // Re-assess risk from the actual candidate BEFORE reviewers are routed, so a change that turns out to touch protected paths
      // gets the reviewers its real risk demands. Risk only ratchets up.
      const pol = await this.o.ports.policy.evaluate(job, headSha);
      await this.hit("after-port:policy.assess");
      return this.move(job, "REVIEWING", { gate: r.resultsDigest, risk: pol.risk }, async (tx) => {
        await write(tx);
        await this.ratchetRisk(tx, job.id, pol.risk);
      });
    }
    return this.move(job, "REWORK", { gate: r.resultsDigest, verdict: r.verdict }, async (tx) => {
      await write(tx);
      await appendEvent(tx, { jobId: job.id, type: "gate.failed", source: "orchestrator", payload: { round: job.round, head_sha: headSha, class: r.failureClass ?? r.verdict, results: r.resultsDigest } });
    });
  }

  private async review(job: JobCtx): Promise<TickResult> {
    if (!job.headSha) return this.fail(job, "review-without-candidate");
    const head = job.headSha;
    const roles = await this.o.ports.review.requiredRoles(job);
    const results: Array<{ role: string } & import("./ports").ReviewRunResult> = [];
    // Reviewers are independent read-only sessions; run at most REVIEW_CONCURRENCY at a time.
    for (let i = 0; i < roles.length; i += REVIEW_CONCURRENCY) {
      const batch = roles.slice(i, i + REVIEW_CONCURRENCY);
      const got = await Promise.all(batch.map(async (role) => ({ role, ...(await this.o.ports.review.run(job, role, head)) })));
      results.push(...got);
      for (const g of got) await this.hit(`after-port:review.${g.role}`);
    }
    const invalid = results.filter((r) => r.verdict === "invalid");
    if (invalid.length) {
      // A missing/garbled/wrong-SHA report never counts as a pass: hold and retry a bounded number of times, then stop for a human.
      for (const r of invalid) {
        const [c] = await this.o.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM events WHERE job_id = ${job.id} AND type = 'review.invalid' AND payload_redacted->>'head_sha' = ${head} AND payload_redacted->>'role' = ${r.role}`;
        if ((c?.c ?? 0) + 1 > MAX_REVIEW_INVALID) return this.fail(job, `review-unavailable:${r.role}`);
        await appendEvent(this.o.sql, { jobId: job.id, type: "review.invalid", source: "orchestrator", payload: { role: r.role, head_sha: head, reason: r.reason ?? "invalid report", attempt: (c?.c ?? 0) + 1 } });
      }
      return { state: job.state, action: "waiting", detail: `review-invalid:${invalid.map((r) => r.role).join(",")}` };
    }
    if (results.some((r) => r.verdict === "blocked")) return this.fail(job, "review-blocked");
    const reasons = (await this.o.ports.review.routingReasons?.(job)) ?? [];
    const write = async (tx: Q) => {
      for (const r of results) {
        await (tx as Sql)`INSERT INTO review_results (job_id, head_sha, reviewer_role, reviewer_run_id, verdict, findings_digest)
          SELECT ${job.id}, ${head}, ${r.role}, ${r.reviewerRunId ?? null}, ${r.verdict}, ${r.findingsDigest}
          WHERE NOT EXISTS (SELECT 1 FROM review_results WHERE job_id = ${job.id} AND head_sha = ${head} AND reviewer_role = ${r.role} AND findings_digest = ${r.findingsDigest})`;
      }
      await appendEvent(tx, { jobId: job.id, type: "review.routed", source: "orchestrator", payload: { head_sha: head, roles, reasons } });
      for (const r of results.filter((x) => x.verdict === "changes_requested"))
        await appendEvent(tx, { jobId: job.id, type: "review.changes_requested", source: "orchestrator", payload: { round: job.round, head_sha: head, role: r.role, findings: (r.findings ?? []).slice(0, 30) } });
    };
    const allPass = results.every((r) => r.verdict === "pass");
    return this.move(job, allPass ? "PREMERGE" : "REWORK", { reviews: results.map((r) => `${r.role}:${r.verdict}`) }, write);
  }

  /** Raise (never lower) the job's risk. An unclassified job simply takes the policy's value. */
  private async ratchetRisk(tx: Q, jobId: string, polRisk: RiskLevel): Promise<void> {
    const t = tx as Sql;
    const [cur] = await t<{ risk: RiskLevel; risk_classified: boolean }[]>`SELECT risk, risk_classified FROM jobs WHERE id = ${jobId}`;
    const next = cur?.risk_classified ? maxRisk(cur.risk, polRisk) : polRisk;
    await t`UPDATE jobs SET risk = ${next}, risk_classified = true WHERE id = ${jobId}`;
  }

  private async premerge(job: JobCtx): Promise<TickResult> {
    if (!job.headSha) return this.fail(job, "premerge-without-candidate");
    const head = job.headSha;
    const pol = await this.o.ports.policy.evaluate(job, head);
    await this.hit("after-port:policy.evaluate");
    const pr = await this.o.ports.scm.ensureDraftPr(job, head);
    await this.hit("after-port:scm.ensureDraftPr");
    const record = async (tx: Q) => {
      const q = tx as Sql;
      await this.ratchetRisk(tx, job.id, pol.risk);
      const [rr] = await q<{ risk: RiskLevel }[]>`SELECT risk FROM jobs WHERE id = ${job.id}`;
      const risk = (rr?.risk ?? pol.risk) as RiskLevel;
      await q`UPDATE jobs SET policy_digest = ${pol.policyDigest}, pr_number = ${pr.prNumber} WHERE id = ${job.id}`;
      await q`INSERT INTO policy_decisions (job_id, head_sha, policy_digest, risk, eligible, reasons)
        SELECT ${job.id}, ${head}, ${pol.policyDigest}, ${risk}, ${pol.eligible && (risk === "LOW" || risk === "MEDIUM")}, ${q.json(pol.reasons as never)}
        WHERE NOT EXISTS (SELECT 1 FROM policy_decisions WHERE job_id = ${job.id} AND head_sha = ${head} AND policy_digest = ${pol.policyDigest})`;
    };
    // Unattended path: policy says eligible AND a privileged coordinator exists. The coordinator still re-validates everything freshly
    // (and the rollout controls) before merging; if anything is off, mergeStep sends the job to a human. HIGH/CRITICAL are never eligible.
    if (pol.eligible && this.o.merge) {
      await this.o.sql.begin(async (tx) => {
        await record(tx);
        await appendEvent(tx, { jobId: job.id, type: "auto_merge.eligible", source: "orchestrator", payload: { head_sha: head, pr_number: pr.prNumber, reasons: pol.reasons } });
      });
      await this.hit("after-record:auto-merge");
      return this.mergeStep(job);
    }
    return this.move(job, "AWAITING_HUMAN", { policy: pol.policyDigest, pr: pr.prNumber }, async (tx) => {
      await record(tx);
      await appendEvent(tx, { jobId: job.id, type: "approval.requested", source: "orchestrator", payload: { head_sha: head, pr_number: pr.prNumber, reasons: pol.reasons } });
    });
  }

  /** Delegates to the privileged coordinator and maps a refusal onto a legal state transition. The orchestrator itself never merges. */
  private async mergeStep(job: JobCtx): Promise<TickResult> {
    const r = await (this.o.merge as MergePort).merge(job.id);
    await this.hit("after-port:merge");
    if (r.status === "merged" || r.status === "already-merged") return { state: "MERGED", action: "transitioned" };
    if (r.status === "pending") return { state: job.state, action: "waiting", detail: r.detail };
    if (r.next === "stay") return { state: job.state, action: "waiting", detail: r.blockers.join("; ") };
    const cur = await this.load(job.id);
    if (cur.state !== "PREMERGE") return { state: cur.state, action: "waiting", detail: "awaiting coordinator state" };
    if (r.next === "QUARANTINED") {
      const q = await this.move(cur, "QUARANTINED", { blockers: r.blockers });
      if (q.action === "transitioned") await revokeJobLeases(this.o.sql, job.id, "merge-integrity-violation");
      return q;
    }
    return this.move(cur, "AWAITING_HUMAN", { blockers: r.blockers });
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
