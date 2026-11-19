import { mkdirSync } from "node:fs";
import type { Sql } from "@factory/db";
import type { TaskContext, TaskExecutor } from "@factory/runner";
import { commitCandidate, CandidateRejected, descriptorDigest, fetchWorkspaceRepo, pushFactoryBranch, type CandidateDescriptor } from "@factory/scm";
import { artifactKind, AGENT_STAGES } from "./pipeline";
import { recordArtifact, type FileArtifactStore } from "./artifacts";

/**
 * The code-writing agent. It runs INSIDE the task's sandbox (no network, no credentials, workspace-only filesystem) and edits
 * files under `ctx.workspace.repoDir`. It cannot create commits we trust: the trusted side builds the commit afterwards.
 */
export interface BuilderRuntime {
  edit(ctx: TaskContext, input: { role: "builder" | "tester"; jobId: string; round: number; feedback: unknown[]; scope: string[] }): Promise<{ ok: boolean; note?: string }>;
}

export interface BuilderDeps {
  sql: Sql;
  store: FileArtifactStore;
  runtime: BuilderRuntime;
  remoteFor: (repositoryId: string) => Promise<{ url: string; allowLocalRemote?: boolean }>;
  /** Short-lived branch_write token (trusted side only). */
  tokenFor?: (repositoryId: string) => Promise<string | undefined>;
  limits?: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number };
}

const stageRound = (stage: string) => Number(/:r(\d+)$/.exec(stage)?.[1] ?? 0);

/** Executor for the builder and tester roles: checkout exact parent -> sandboxed edit -> trusted commit -> push -> immutable record. */
export function builderTaskExecutor(d: BuilderDeps): TaskExecutor {
  return async (ctx) => {
    const role = ctx.lease.role as "builder" | "tester";
    const round = stageRound(ctx.lease.stage);
    const jobId = ctx.lease.jobId;
    const step = AGENT_STAGES.BUILDING?.steps.find((s) => s.role === role);
    if (!step) return { ok: false, payload: { error: "not-a-build-role" } };

    // Idempotency: a retry after a crash must not create a second candidate.
    const [done] = await d.sql<{ head_sha: string }[]>`SELECT head_sha FROM candidates WHERE job_id = ${jobId} AND round = ${round} AND role = ${role}`;
    if (done) return { ok: true, payload: { head_sha: done.head_sha, reused: true } };

    const [job] = await d.sql<{ repository_id: string; base_sha: string | null; created_at: Date }[]>`SELECT repository_id, base_sha, created_at FROM jobs WHERE id = ${jobId}`;
    if (!job?.base_sha) return { ok: false, payload: { error: "no-base-sha" } };
    const parent = await parentFor(d.sql, jobId, role, round, job.base_sha);
    if (!parent) return { ok: false, payload: { error: "no-parent-candidate" } };

    const [design] = await d.sql<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${jobId} AND kind = 'design.json' LIMIT 1`;
    const scope = design ? (JSON.parse(d.store.get(design.digest).toString("utf8")) as { files_affected: Array<{ path: string }> }).files_affected.map((f) => f.path) : [];
    if (scope.length === 0) return { ok: false, payload: { error: "no-approved-scope" } };

    const remote = await d.remoteFor(job.repository_id);
    const token = await d.tokenFor?.(job.repository_id);
    mkdirSync(ctx.workspace.repoDir, { recursive: true });
    await fetchWorkspaceRepo({ repoDir: ctx.workspace.repoDir, remoteUrl: remote.url, sha: parent, ...(token ? { token } : {}), ...(remote.allowLocalRemote ? { allowLocalRemote: true } : {}) });

    const feedback = (await d.sql<{ type: string; payload_redacted: unknown }[]>`SELECT type, payload_redacted FROM events WHERE job_id = ${jobId} AND type IN ('gate.failed','review.changes_requested','human.changes_requested') ORDER BY sequence`).map((e) => ({ type: e.type, ...(e.payload_redacted as object) }));
    const r = await d.runtime.edit(ctx, { role, jobId, round, feedback, scope });
    if (!r.ok) return { ok: false, payload: { error: "runtime-failed", note: r.note } };

    let c;
    try {
      c = await commitCandidate({
        repoDir: ctx.workspace.repoDir, parentSha: parent, allowedPaths: scope, message: `factory(${role}): job ${jobId} round ${round}`,
        dateIso: job.created_at.toISOString(), ...(d.limits ?? {}),
      });
    } catch (e) {
      if (e instanceof CandidateRejected && e.code === "empty" && role === "tester") {
        // Nothing new to test this round (e.g. a rework that only touched source): the candidate stays at the builder's commit.
        const stored = d.store.put(JSON.stringify({ schema: "factory.candidate/1", jobId, round, role, noop: true, headSha: parent }));
        await recordArtifact(d.sql, { jobId, kind: artifactKind(step, round), stored });
        return { ok: true, payload: { head_sha: parent, noop: true } };
      }
      if (e instanceof CandidateRejected) return { ok: false, payload: { error: "candidate-rejected", code: e.code, message: e.message } };
      throw e;
    }
    await pushFactoryBranch({ repoDir: ctx.workspace.repoDir, remoteUrl: remote.url, branch: `factory/${jobId}`, sha: c.headSha, ...(token ? { token } : {}), ...(remote.allowLocalRemote ? { allowLocalRemote: true } : {}) });

    const patch = d.store.put(c.patch);
    await recordArtifact(d.sql, { jobId, kind: `patch.${role}.r${round}`, stored: patch });
    const descriptor: CandidateDescriptor = { schema: "factory.candidate/1", jobId, round, role, parentSha: parent, headSha: c.headSha, treeSha: c.treeSha, patchDigest: patch.digest, files: c.files, protectedHits: c.protectedHits };
    const stored = d.store.put(JSON.stringify(descriptor));
    await recordArtifact(d.sql, { jobId, kind: artifactKind(step, round), stored });
    await d.sql`INSERT INTO candidates (job_id, round, role, parent_sha, head_sha, tree_sha, patch_digest, descriptor_digest, files_changed)
      VALUES (${jobId}, ${round}, ${role}, ${parent}, ${c.headSha}, ${c.treeSha}, ${patch.digest}, ${descriptorDigest(descriptor)}, ${c.files.length}) ON CONFLICT (job_id, round, role) DO NOTHING`;
    return { ok: true, payload: { head_sha: c.headSha, files: c.files.length, protected: c.protectedHits.length } };
  };
}

async function parentFor(sql: Sql, jobId: string, role: "builder" | "tester", round: number, baseSha: string): Promise<string | null> {
  if (role === "tester") return (await sql<{ head_sha: string }[]>`SELECT head_sha FROM candidates WHERE job_id = ${jobId} AND round = ${round} AND role = 'builder'`)[0]?.head_sha ?? null;
  if (round === 0) return baseSha;
  return (await sql<{ head_sha: string }[]>`SELECT head_sha FROM candidates WHERE job_id = ${jobId} AND round = ${round - 1} ORDER BY CASE role WHEN 'tester' THEN 0 ELSE 1 END LIMIT 1`)[0]?.head_sha ?? null;
}

/** Route by role: build roles get the git-aware executor, everything else the structured-output executor. */
export const composeExecutors = (agent: TaskExecutor, build: TaskExecutor): TaskExecutor => (ctx) => (ctx.lease.role === "builder" || ctx.lease.role === "tester" ? build(ctx) : agent(ctx));
