import { appendEvent, ConflictError, transitionJob, type Q, type Sql } from "@factory/db";
import { assertTransition, assessMerge, type EvidenceBinding, type JobSnapshot, type PolicyDecision } from "@factory/domain";
import { digestOf } from "@factory/telemetry";
import type { GitHubClient, PullRequest, Repo } from "./client";
import { GitHubApiError } from "./client";

export type MergeNext = "AWAITING_HUMAN" | "QUARANTINED" | "stay";
export type MergeResult =
  | { status: "merged"; mergeSha: string; reconciled: boolean }
  | { status: "already-merged"; mergeSha: string | null }
  | { status: "blocked"; blockers: string[]; next: MergeNext }
  | { status: "pending"; detail: string };

export interface MergeDeps {
  sql: Sql;
  github: GitHubClient;
  repoFor: (repositoryId: string) => Promise<{ repo: Repo; baseBranch: string; requiredChecks: string[] }>;
  /** Snapshot for the domain transition guards (includes the latest approval binding). */
  snapshot: (q: Q, jobId: string) => Promise<JobSnapshot>;
  /** Fresh evidence binding + the reviewer roles required RIGHT NOW. */
  currentBinding: (jobId: string) => Promise<{ binding: EvidenceBinding | undefined; roles: string[] }>;
  /** Policy re-evaluated from the CURRENT durable evidence (never the stored decision). */
  freshDecision: (job: { id: string; repositoryId: string; headSha: string }) => Promise<PolicyDecision>;
  /** Signature + binding verification of the gate evidence for the exact head/base/manifest. */
  verifyGate: (q: { jobId: string; headSha: string; baseSha: string; manifestDigest: string }) => Promise<{ ok: boolean; reasons: string[] }>;
  mergeMethod?: "squash" | "merge" | "rebase";
  now?: () => number;
}

interface JobRow { id: string; repository_id: string; state: string; version: number; head_sha: string | null; base_sha: string | null; pr_number: number | null; created_by: string | null; risk: string }

const ACTOR = "merge-coordinator";

/**
 * Privileged merge coordinator (blueprint section 11): the ONLY component that writes merges. It re-fetches everything it relies on,
 * never trusts remembered approvals, binds the merge call to the exact head SHA, records a unique merge intent, and reconciles against the
 * authoritative PR after any uncertain outcome instead of retrying blindly.
 */
export class MergeCoordinator {
  constructor(private readonly d: MergeDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }

  private async loadJob(id: string): Promise<JobRow> {
    const [j] = await this.d.sql<JobRow[]>`SELECT id, repository_id, state, version, head_sha, base_sha, pr_number, created_by, risk FROM jobs WHERE id = ${id}`;
    if (!j) throw new Error(`unknown job ${id}`);
    return j;
  }

  /** Everything that must hold, evaluated from FRESH facts. Returns blockers and where the job should go. */
  private async evaluate(job: JobRow, pr: PullRequest, ctx: { repo: Repo; baseBranch: string; requiredChecks: string[] }): Promise<{ blockers: string[]; next: MergeNext; approvers: string[] }> {
    const blockers: string[] = [];
    let next: MergeNext = "AWAITING_HUMAN";
    const head = job.head_sha;
    if (!head || !job.base_sha || job.pr_number === null) return { blockers: ["job has no recorded candidate/base/pull request"], next, approvers: [] };
    if (pr.number !== job.pr_number || pr.head.ref !== `factory/${job.id}`) { blockers.push("pull request does not map to this job"); next = "QUARANTINED"; }
    if (pr.head.sha !== head) { blockers.push(`GitHub head ${pr.head.sha} differs from the evaluated candidate ${head}`); next = "QUARANTINED"; }
    const tip = await this.d.github.getBranchSha(ctx.repo, ctx.baseBranch);
    // A PR that is ALREADY merged has legitimately moved the base tip; only the approvals matter then.
    if (!pr.merged && tip !== job.base_sha) { blockers.push(`base branch moved (${job.base_sha} -> ${tip ?? "missing"}); gates and reviews must be re-run`); }

    const { binding, roles } = await this.d.currentBinding(job.id);
    const decision = await this.d.freshDecision({ id: job.id, repositoryId: job.repository_id, headSha: head });
    const [stored] = await this.d.sql<{ policy_digest: string; risk: string }[]>`SELECT policy_digest, risk FROM policy_decisions WHERE job_id = ${job.id} AND head_sha = ${head} ORDER BY created_at DESC LIMIT 1`;
    if (!stored) blockers.push("no recorded policy decision for this head");
    else if (stored.policy_digest !== decision.policyDigest) blockers.push("policy changed since the decision was recorded");
    else if (rank(decision.risk) > rank(stored.risk)) blockers.push(`risk is now ${decision.risk}, higher than the ${stored.risk} that was reviewed and approved`);

    if (!binding) blockers.push("no passing gate evidence for the current head/base");
    else {
      const g = await this.d.verifyGate({ jobId: job.id, headSha: head, baseSha: job.base_sha, manifestDigest: binding.gateConfigDigest });
      if (!g.ok) blockers.push(`gate evidence not verifiable: ${g.reasons.join(", ")}`);
    }
    const reviews = await this.d.sql<{ reviewer_role: string }[]>`SELECT DISTINCT reviewer_role FROM review_results WHERE job_id = ${job.id} AND head_sha = ${head} AND verdict = 'pass'`;
    for (const role of roles) if (!reviews.some((r) => r.reviewer_role === role)) blockers.push(`required ${role} review is missing for this exact head`);

    const runs = await this.d.github.getCheckRuns(ctx.repo, pr.head.sha);
    for (const name of ctx.requiredChecks) {
      const run = runs.filter((r) => r.name === name && r.headSha === pr.head.sha).at(-1);
      if (!run) blockers.push(`required check "${name}" has not reported for this head`);
      else if (run.status !== "completed") { blockers.push(`required check "${name}" is still running`); if (next === "AWAITING_HUMAN" && blockers.length === 1) next = "stay"; }
      else if (run.conclusion !== "success") blockers.push(`required check "${name}" concluded ${run.conclusion}`);
    }

    const appr = await this.d.sql<{ actor_id: string; decision: "approve" | "reject" | "rework"; binding: EvidenceBinding; created_at: Date }[]>`SELECT actor_id, decision, binding, created_at FROM approvals WHERE job_id = ${job.id} ORDER BY created_at`;
    const assessed = binding
      ? assessMerge({
        decision, current: binding, prOpen: pr.merged || pr.state === "open", prDraft: false, /* a draft is flipped to ready only AFTER every other check passes */ nowMs: this.now(), ...(job.created_by ? { requestedBy: job.created_by } : {}),
        approvals: appr.map((a) => ({ actorId: a.actor_id, decision: a.decision, binding: a.binding, approvedAtMs: a.created_at.getTime() })),
      })
      : { allowed: false, blockers: ["cannot assess approvals without a current binding"], validApprovers: [] as string[] };
    blockers.push(...assessed.blockers);
    // A merge nobody validly approved is an incident, not a retry.
    if (pr.merged && blockers.length) next = "QUARANTINED";
    // Only "waiting for CI" blockers keep the job in place; any other blocker needs a human / rework / quarantine.
    if (next === "stay" && blockers.some((b) => !/still running/.test(b))) next = "AWAITING_HUMAN";
    return { blockers: [...new Set(blockers)], next, approvers: assessed.validApprovers };
  }

  async merge(jobId: string): Promise<MergeResult> {
    let job = await this.loadJob(jobId);
    const [prior] = await this.d.sql<{ github_merge_sha: string | null; status: string }[]>`SELECT github_merge_sha, status FROM merge_intents WHERE job_id = ${jobId} AND status = 'merged' LIMIT 1`;
    if (prior || ["MERGED", "POSTMERGE_MONITOR", "DONE"].includes(job.state)) return { status: "already-merged", mergeSha: prior?.github_merge_sha ?? null };
    if (job.state !== "PREMERGE" && job.state !== "MERGING") return { status: "blocked", blockers: [`job is ${job.state}, not PREMERGE`], next: "stay" };
    const ctx = await this.d.repoFor(job.repository_id);
    if (job.pr_number === null) return { status: "blocked", blockers: ["no pull request"], next: "AWAITING_HUMAN" };
    const pr = await this.d.github.getPr(ctx.repo, job.pr_number);
    const ev = await this.evaluate(job, pr, ctx);

    if (ev.blockers.length) {
      if (job.state === "MERGING") {
        // Crash recovery: evidence went stale after MERGING began. Step back, never push through.
        try { await transitionJob(this.d.sql, { jobId, expectedVersion: job.version, next: "PREMERGE", actor: ACTOR, reason: "re-validation failed while MERGING" }); } catch (e) { if (!(e instanceof ConflictError)) throw e; }
        job = await this.loadJob(jobId);
      }
      await this.d.sql.begin(async (tx) => {
        await appendEvent(tx, { jobId, type: "merge.blocked", source: "merge-coordinator", payload: { head_sha: job.head_sha, blockers: ev.blockers, next: ev.next } });
        await tx`INSERT INTO audit_entries (actor, action, resource, result, reason, digest) VALUES (${ACTOR}, 'merge.blocked', ${`job:${jobId}`}, 'denied', ${ev.blockers.join("; ").slice(0, 900)}, ${digestOf({ jobId, blockers: ev.blockers, at: this.now() })})`;
      });
      return { status: "blocked", blockers: ev.blockers, next: ev.next };
    }

    const head = job.head_sha as string;
    const method = this.d.mergeMethod ?? "squash";
    const insertIntent = (q: Q) => (q as Sql)`INSERT INTO merge_intents (job_id, repository_id, pr_number, head_sha, status, merge_method) VALUES (${jobId}, ${job.repository_id}, ${job.pr_number}, ${head}, 'pending', ${method}) ON CONFLICT (repository_id, pr_number, head_sha) DO NOTHING`;
    if (job.state === "PREMERGE") {
      try {
        // State change + unique merge intent commit together, and the domain guard re-checks the approval binding inside the same transaction.
        await transitionJob(this.d.sql, {
          jobId, expectedVersion: job.version, next: "MERGING", actor: ACTOR, evidence: { head, approvers: ev.approvers },
          guard: async (_row, tx) => { assertTransition(await this.d.snapshot(tx, jobId), "MERGING"); await insertIntent(tx); },
        });
      } catch (e) {
        if (e instanceof ConflictError) return { status: "pending", detail: "another coordinator is handling this merge" };
        throw e;
      }
    } else {
      await insertIntent(this.d.sql); // resuming from MERGING after a crash
    }

    // The PR was already merged on GitHub for exactly the approved head (we crashed after the call, or a human merged it): reconcile, never merge twice.
    if (pr.merged && pr.merge_commit_sha && pr.head.sha === head) return this.finalize({ ...job, state: "MERGING", version: job.version + (job.state === "PREMERGE" ? 1 : 0) }, pr.merge_commit_sha, true, ctx);

    try {
      if (pr.draft && !pr.merged) {
        // The factory only ever opens DRAFT pull requests; after a valid human approval the coordinator marks it ready, then merges.
        const ready = pr.node_id ? await this.d.github.markPullRequestReady(ctx.repo, pr.node_id) : false;
        if (!ready) throw new GitHubApiError(0, "could not mark the pull request ready for review");
      }
      const res = await this.d.github.mergePullRequest(ctx.repo, job.pr_number, { sha: head, method });
      if (res.merged) return this.finalize({ ...job, state: "MERGING", version: job.version + (job.state === "PREMERGE" ? 1 : 0) }, res.sha, false, ctx);
      // Definitive refusal by GitHub (protection, draft, closed, head moved): never bypass.
      await this.d.sql`UPDATE merge_intents SET status = 'aborted', reason = ${res.message.slice(0, 500)}, updated_at = now() WHERE repository_id = ${job.repository_id} AND pr_number = ${job.pr_number} AND head_sha = ${head} AND status = 'pending'`;
      const cur = await this.loadJob(jobId);
      await transitionJob(this.d.sql, { jobId, expectedVersion: cur.version, next: "PREMERGE", actor: ACTOR, reason: `GitHub refused the merge: ${res.message}` });
      await this.d.sql.begin(async (tx) => { await appendEvent(tx, { jobId, type: "merge.blocked", source: "merge-coordinator", payload: { head_sha: head, blockers: [`GitHub refused: ${res.status} ${res.message}`], next: "AWAITING_HUMAN" } }); });
      return { status: "blocked", blockers: [`GitHub refused the merge: ${res.status} ${res.message}`], next: "AWAITING_HUMAN" };
    } catch (e) {
      if (!(e instanceof GitHubApiError)) throw e;
      // UNKNOWN outcome (timeout / 5xx / network): consult the authoritative PR before anything else.
      const after = await this.d.github.getPr(ctx.repo, job.pr_number).catch(() => null);
      if (after?.merged && after.merge_commit_sha) return this.finalize({ ...job, state: "MERGING", version: job.version + (job.state === "PREMERGE" ? 1 : 0) }, after.merge_commit_sha, true, ctx);
      return { status: "pending", detail: `merge outcome unknown (${e.message}); will reconcile against GitHub before any retry` };
    }
  }

  /** Record the authoritative merge exactly once and walk the job MERGING -> MERGED -> POSTMERGE_MONITOR. */
  private async finalize(job: JobRow, mergeSha: string, reconciled: boolean, ctx: { repo: Repo }): Promise<MergeResult> {
    const fresh = await this.loadJob(job.id);
    await this.d.sql.begin(async (tx) => {
      const upd = await tx<{ id: string }[]>`UPDATE merge_intents SET status = 'merged', github_merge_sha = ${mergeSha}, updated_at = now() WHERE job_id = ${job.id} AND head_sha = ${fresh.head_sha} AND status <> 'merged' RETURNING id`;
      if (upd.length === 0) return; // someone already recorded it
      await appendEvent(tx, { jobId: job.id, type: "merge.completed", source: "merge-coordinator", payload: { head_sha: fresh.head_sha, merge_sha: mergeSha, pr_number: fresh.pr_number, reconciled, repo: `${ctx.repo.owner}/${ctx.repo.name}` } });
      await tx`INSERT INTO audit_entries (actor, action, resource, result, digest) VALUES (${ACTOR}, 'merge.completed', ${`job:${job.id}`}, 'ok', ${digestOf({ job: job.id, merge: mergeSha })})`;
    });
    let cur = await this.loadJob(job.id);
    for (const next of ["MERGED", "POSTMERGE_MONITOR"] as const) {
      if (cur.state === "MERGING" && next === "MERGED" || cur.state === "MERGED" && next === "POSTMERGE_MONITOR") {
        try { await transitionJob(this.d.sql, { jobId: job.id, expectedVersion: cur.version, next, actor: ACTOR, evidence: { merge_sha: mergeSha } }); } catch (e) { if (!(e instanceof ConflictError)) throw e; }
        cur = await this.loadJob(job.id);
      }
    }
    return { status: "merged", mergeSha, reconciled };
  }

  /** Post-merge health result (E2E 15): DONE if healthy, otherwise FAILED with an incident event for the operator. */
  async recordPostmerge(jobId: string, r: { ok: boolean; detail: string }): Promise<void> {
    const job = await this.loadJob(jobId);
    if (job.state !== "POSTMERGE_MONITOR") throw new Error(`job is ${job.state}, not POSTMERGE_MONITOR`);
    await transitionJob(this.d.sql, { jobId, expectedVersion: job.version, next: r.ok ? "DONE" : "FAILED", actor: ACTOR, reason: r.detail, evidence: { ok: r.ok } });
    if (!r.ok) {
      await this.d.sql.begin(async (tx) => {
        await tx`UPDATE jobs SET last_error_code = 'postmerge-failed' WHERE id = ${jobId}`;
        await appendEvent(tx, { jobId, type: "postmerge.failed", source: "merge-coordinator", payload: { detail: r.detail } });
      });
    }
  }
}

const rank = (r: string) => ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(r);
