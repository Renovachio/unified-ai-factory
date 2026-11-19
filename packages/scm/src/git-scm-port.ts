import type { Sql } from "@factory/db";
import { ensureDraftPr } from "./pr";
import type { GitHubClient, Repo } from "./client";

export interface JobLike { id: string; repositoryId: string; headSha: string | null; baseSha: string | null }

/** Read-only, idempotent view of recorded candidates (what the orchestrator needs at BUILDING -> GATING). */
export function candidateScm(sql: Sql) {
  return {
    async commitCandidate(job: { id: string }, round: number): Promise<{ headSha: string }> {
      const rows = await sql<{ head_sha: string }[]>`SELECT head_sha FROM candidates WHERE job_id = ${job.id} AND round = ${round} ORDER BY CASE role WHEN 'tester' THEN 0 ELSE 1 END LIMIT 1`;
      const c = rows[0];
      if (!c) throw new Error(`no recorded candidate for job ${job.id} round ${round}`);
      return { headSha: c.head_sha };
    },
  };
}

/**
 * Orchestrator ScmPort backed by durable state. Builder/tester TASKS create and push commits (see candidate executor);
 * this port only READS the recorded candidates, so it is idempotent by construction.
 */
export function createGitScmPort(d: { sql: Sql; github: GitHubClient; repoFor: (repositoryId: string) => Promise<{ repo: Repo; baseBranch: string }> }) {
  return {
    async prepare(job: JobLike): Promise<{ baseSha: string }> {
      const { repo, baseBranch } = await d.repoFor(job.repositoryId);
      if (job.baseSha) return { baseSha: job.baseSha }; // base is pinned once per job; later movement is detected by evidence invalidation
      const sha = await d.github.getBranchSha(repo, baseBranch);
      if (!sha) throw new Error(`base branch ${baseBranch} not found`);
      return { baseSha: sha };
    },
    commitCandidate: (job: JobLike, round: number) => candidateScm(d.sql).commitCandidate(job, round),
    async ensureDraftPr(job: JobLike, headSha: string): Promise<{ prNumber: number; url: string }> {
      const { repo, baseBranch } = await d.repoFor(job.repositoryId);
      const [q] = await d.sql<{ title: string }[]>`SELECT q.title FROM jobs j JOIN requests q ON q.id = j.request_id WHERE j.id = ${job.id}`;
      const r = await ensureDraftPr(d.sql, d.github, {
        jobId: job.id, repositoryId: job.repositoryId, repo, baseBranch, headSha,
        title: `Factory: ${(q?.title ?? "change").slice(0, 200)}`, body: `Automated draft for job ${job.id}. Candidate ${headSha}. Requires human review and approval.`,
      });
      return { prNumber: r.prNumber, url: r.url };
    },
  };
}
