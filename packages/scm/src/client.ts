import { z } from "zod";
import type { TokenProvider, TokenRole } from "./app-auth";

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
    this.name = "GitHubApiError";
  }
}

export const FACTORY_BRANCH = /^factory\/[A-Za-z0-9_-]{1,80}$/;

const PrSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  node_id: z.string().optional(),
  draft: z.boolean().optional(),
  state: z.string(),
  merged: z.boolean().optional(),
  merge_commit_sha: z.string().regex(/^[a-f0-9]{40}$/).nullable().optional(),
  mergeable_state: z.string().optional(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), ref: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/).optional() }),
});
export type PullRequest = z.infer<typeof PrSchema>;
const RefSchema = z.object({ object: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) });
const RepoSchema = z.object({ id: z.number(), default_branch: z.string() });

export interface GitHubClientOptions {
  apiBase?: string;
  tokens: TokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxGetRetries?: number;
}

export interface Repo { owner: string; name: string }

const CheckRunsSchema = z.object({ check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), head_sha: z.string().regex(/^[a-f0-9]{40}$/) })) });
export interface CheckRun { name: string; status: string; conclusion: string | null; headSha: string }
export type MergeCallResult = { merged: true; sha: string } | { merged: false; status: number; message: string };

/**
 * Deliberately narrow surface: read repo/refs/PRs/checks, create factory/* branches, create draft PRs, and (merge credential only)
 * merge a pull request at an EXACT head SHA. There is no method to change branch protection, rulesets, default branches, or delete anything.
 */
export class GitHubClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly o: GitHubClientOptions) {
    this.base = o.apiBase ?? "https://api.github.com";
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request(role: TokenRole, repo: Repo, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const retries = method === "GET" ? (this.o.maxGetRetries ?? 3) : 0; // only reads are retried blindly
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        const token = await this.o.tokens.token(role, repo);
        res = await this.f(`${this.base}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        if (attempt < retries) { await this.sleep(2 ** attempt * 100); continue; }
        throw new GitHubApiError(0, `network error: ${e instanceof Error ? e.message.replace(/ghs_\w+/g, "[REDACTED]") : "unknown"}`);
      }
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await this.sleep(Number(res.headers.get("retry-after") ?? 0) * 1000 || 2 ** attempt * 100);
        continue;
      }
      const text = await res.text();
      let json: unknown;
      try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body: leave undefined */ }
      return { status: res.status, json };
    }
  }

  private fail(status: number, json: unknown): never {
    const msg = typeof json === "object" && json && "message" in json ? String((json as { message: unknown }).message) : "request failed";
    throw new GitHubApiError(status, msg);
  }

  async getRepo(repo: Repo): Promise<{ id: number; defaultBranch: string }> {
    const r = await this.request("read", repo, "GET", `/repos/${repo.owner}/${repo.name}`);
    if (r.status !== 200) this.fail(r.status, r.json);
    const p = RepoSchema.parse(r.json);
    return { id: p.id, defaultBranch: p.default_branch };
  }

  async getBranchSha(repo: Repo, branch: string): Promise<string | null> {
    const r = await this.request("read", repo, "GET", `/repos/${repo.owner}/${repo.name}/git/ref/heads/${branch}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.fail(r.status, r.json);
    return RefSchema.parse(r.json).object.sha;
  }

  /** Creates factory/<job> at `sha`. Idempotent: an existing branch is returned as-is (caller compares SHAs). */
  async createBranch(repo: Repo, branch: string, sha: string): Promise<{ sha: string; created: boolean }> {
    if (!FACTORY_BRANCH.test(branch)) throw new GitHubApiError(0, `refusing to create non-factory branch ${branch}`);
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new GitHubApiError(0, "invalid sha");
    const existing = await this.getBranchSha(repo, branch);
    if (existing) return { sha: existing, created: false };
    const r = await this.request("branch_write", repo, "POST", `/repos/${repo.owner}/${repo.name}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    if (r.status === 422) {
      const again = await this.getBranchSha(repo, branch);
      if (again) return { sha: again, created: false };
    }
    if (r.status !== 201) this.fail(r.status, r.json);
    return { sha: RefSchema.parse(r.json).object.sha, created: true };
  }

  async findPrByHead(repo: Repo, branch: string): Promise<PullRequest | null> {
    const r = await this.request("read", repo, "GET", `/repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(`${repo.owner}:${branch}`)}&state=all&per_page=5`);
    if (r.status !== 200) this.fail(r.status, r.json);
    const list = z.array(PrSchema).parse(r.json);
    return list.find((p) => p.head.ref === branch) ?? null;
  }

  async getPr(repo: Repo, number: number): Promise<PullRequest> {
    const r = await this.request("read", repo, "GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`);
    if (r.status !== 200) this.fail(r.status, r.json);
    return PrSchema.parse(r.json);
  }

  /** Always a draft. Never auto-merges. A 422 "already exists" is resolved by the caller via findPrByHead. */
  async createDraftPr(repo: Repo, input: { head: string; base: string; title: string; body: string }): Promise<{ pr: PullRequest } | { alreadyExists: true }> {
    if (!FACTORY_BRANCH.test(input.head)) throw new GitHubApiError(0, `refusing PR from non-factory branch ${input.head}`);
    const r = await this.request("branch_write", repo, "POST", `/repos/${repo.owner}/${repo.name}/pulls`, { ...input, draft: true, maintainer_can_modify: false });
    if (r.status === 422) return { alreadyExists: true };
    if (r.status !== 201) this.fail(r.status, r.json);
    return { pr: PrSchema.parse(r.json) };
  }

  async getCheckRuns(repo: Repo, sha: string): Promise<CheckRun[]> {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new GitHubApiError(0, "invalid sha");
    const r = await this.request("read", repo, "GET", `/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`);
    if (r.status !== 200) this.fail(r.status, r.json);
    return CheckRunsSchema.parse(r.json).check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, headSha: c.head_sha }));
  }

  /**
   * Merge at EXACTLY `sha` (GitHub refuses with 409 if the head moved). Uses the separate `merge` credential. Never forces, never bypasses
   * protections: a refusal (405/409/422) is returned as a definitive `merged: false`; transport errors/5xx throw (outcome UNKNOWN: caller must
   * reconcile against the authoritative PR before any retry).
   */
  async mergePullRequest(repo: Repo, number: number, input: { sha: string; method: "squash" | "merge" | "rebase" }): Promise<MergeCallResult> {
    if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new GitHubApiError(0, "merge requires the exact 40-hex head sha");
    const r = await this.request("merge", repo, "PUT", `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, { sha: input.sha, merge_method: input.method });
    if (r.status === 200) {
      const j = z.object({ merged: z.boolean(), sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(r.json);
      return j.merged ? { merged: true, sha: j.sha } : { merged: false, status: 200, message: "not merged" };
    }
    if (r.status === 405 || r.status === 409 || r.status === 422) return { merged: false, status: r.status, message: typeof r.json === "object" && r.json && "message" in r.json ? String((r.json as { message: unknown }).message) : "refused" };
    this.fail(r.status, r.json);
  }

  /** Draft -> ready for review (GraphQL). Done by the merge coordinator only, after a human approval; uses the merge credential. */
  async markPullRequestReady(repo: Repo, nodeId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_=-]{1,100}$/.test(nodeId)) throw new GitHubApiError(0, "invalid node id");
    const r = await this.request("merge", repo, "POST", "/graphql", { query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}", variables: { id: nodeId } });
    if (r.status !== 200) this.fail(r.status, r.json);
    const j = z.object({ data: z.object({ markPullRequestReadyForReview: z.object({ pullRequest: z.object({ isDraft: z.boolean() }) }) }).optional(), errors: z.array(z.unknown()).optional() }).parse(r.json);
    return j.data?.markPullRequestReadyForReview.pullRequest.isDraft === false;
  }
}
