import { appendEvent, type Sql } from "@factory/db";
import { FACTORY_BRANCH, GitHubApiError, type GitHubClient, type PullRequest, type Repo } from "./client";

export interface EnsurePrInput {
  jobId: string;
  repositoryId: string;
  repo: Repo;
  baseBranch: string;
  headSha: string;
  title: string;
  body: string;
}

export interface EnsuredPr {
  prNumber: number;
  url: string;
  headRef: string;
  created: boolean;
}

/**
 * Idempotently materialise the job's branch and DRAFT pull request. Safe to call repeatedly and concurrently:
 * a per-job advisory lock serialises creators, the job->PR mapping is unique, and existing GitHub state is
 * looked up before and after any create, so a crash between "created on GitHub" and "recorded in DB" is adopted on retry.
 */
export async function ensureDraftPr(sql: Sql, github: GitHubClient, input: EnsurePrInput): Promise<EnsuredPr> {
  const headRef = `factory/${input.jobId}`;
  if (!FACTORY_BRANCH.test(headRef)) throw new Error(`job id cannot form a factory branch: ${input.jobId}`);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"pr:" + input.jobId}))`;
    const [row] = await tx<{ pr_number: number; html_url: string; head_sha: string }[]>`SELECT pr_number, html_url, head_sha FROM pull_requests WHERE job_id = ${input.jobId}`;
    if (row) {
      if (row.head_sha !== input.headSha) await tx`UPDATE pull_requests SET head_sha = ${input.headSha}, updated_at = now() WHERE job_id = ${input.jobId}`;
      return { prNumber: row.pr_number, url: row.html_url, headRef, created: false };
    }
    const branch = await github.createBranch(input.repo, headRef, input.headSha);
    if (branch.sha !== input.headSha) {
      throw new GitHubApiError(409, `branch ${headRef} exists at ${branch.sha}, expected ${input.headSha}; refusing to adopt a diverged branch`);
    }
    let pr: PullRequest | null = await github.findPrByHead(input.repo, headRef);
    let created = false;
    if (!pr) {
      const res = await github.createDraftPr(input.repo, { head: headRef, base: input.baseBranch, title: input.title, body: input.body });
      if ("pr" in res) { pr = res.pr; created = true; }
      else pr = await github.findPrByHead(input.repo, headRef); // lost a race with another creator
    }
    if (!pr) throw new GitHubApiError(502, "pull request neither created nor found");
    const [ins] = await tx<{ id: string }[]>`
      INSERT INTO pull_requests (job_id, repository_id, pr_number, head_ref, head_sha, base_ref, draft, html_url)
      VALUES (${input.jobId}, ${input.repositoryId}, ${pr.number}, ${headRef}, ${input.headSha}, ${input.baseBranch}, ${pr.draft ?? true}, ${pr.html_url})
      ON CONFLICT (job_id) DO NOTHING RETURNING id`;
    if (ins) {
      await tx`UPDATE jobs SET pr_number = ${pr.number}, head_sha = ${input.headSha} WHERE id = ${input.jobId}`;
      await appendEvent(tx, { jobId: input.jobId, type: "pr.created", source: "scm", payload: { pr_number: pr.number, url: pr.html_url, head_ref: headRef, head_sha: input.headSha, draft: pr.draft ?? true, adopted: !created } });
    }
    return { prNumber: pr.number, url: pr.html_url, headRef, created };
  });
}
