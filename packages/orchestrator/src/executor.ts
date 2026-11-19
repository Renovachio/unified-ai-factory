import type { Sql } from "@factory/db";
import type { TaskExecutor } from "@factory/runner";
import { toTaskReporter, type AgentRole, type AgentRunRequest, type AgentRuntimeAdapter } from "@factory/runtimes";
import { artifactKind, AGENT_STAGES, type AgentStep } from "./pipeline";
import { recordArtifact, type FileArtifactStore } from "./artifacts";

export interface ExecutorDeps {
  sql: Sql;
  adapter: AgentRuntimeAdapter;
  store: FileArtifactStore;
  modelFor: (role: AgentRole) => string;
  /** Produces the immutable context manifest URI for a job/role. */
  contextUri: (jobId: string, role: AgentRole) => string;
}

const stepFor = (role: AgentRole, stage: string): { step: AgentStep; round: number } | undefined => {
  for (const def of Object.values(AGENT_STAGES)) {
    const step = def?.steps.find((s) => s.role === role);
    if (step) return { step, round: Number(/:r(\d+)$/.exec(stage)?.[1] ?? 0) };
  }
  return undefined;
};

/**
 * Runner executor for agent-role tasks: runs the adapter, validates and stores the structured output as a content-addressed
 * artifact (digest computed here), and succeeds only when the artifact is durably recorded.
 */
export function agentTaskExecutor(d: ExecutorDeps): TaskExecutor {
  return async (ctx) => {
    const role = ctx.lease.role as AgentRole;
    const found = stepFor(role, ctx.lease.stage);
    if (!found) return { ok: false, payload: { error: "unknown-role-stage" } };
    const [job] = await d.sql<{ head_sha: string | null }[]>`SELECT head_sha FROM jobs WHERE id = ${ctx.lease.jobId}`;
    const req: AgentRunRequest = {
      requestId: `${ctx.lease.taskId}:${ctx.lease.attempt}`, jobId: ctx.lease.jobId, attempt: ctx.lease.attempt, role,
      modelId: d.modelFor(role), promptVersion: "v1", immutableContextManifestUri: d.contextUri(ctx.lease.jobId, role),
      allowedTools: [], maxWallTimeSec: 600, maxOutputBytes: 1_000_000, outputSchemaUri: `schema://${role}`,
      ...(job?.head_sha && role.startsWith("review_") ? { candidateSha: job.head_sha } : {}),
    };
    const runId = await d.adapter.start(req, toTaskReporter(ctx.report));
    ctx.signal.addEventListener("abort", () => { void d.adapter.cancel(runId); }, { once: true });
    let s = await d.adapter.status(runId);
    while (s.exitStatus === "running") { await new Promise((r) => setTimeout(r, 5)); s = await d.adapter.status(runId); }
    if (s.exitStatus !== "succeeded" || s.output === undefined) return { ok: false, payload: { exit: s.exitStatus, code: "failureCode" in s ? s.failureCode : undefined } };
    const stored = d.store.put(JSON.stringify(s.output));
    await recordArtifact(d.sql, { jobId: ctx.lease.jobId, kind: artifactKind(found.step, found.round), stored });
    return { ok: true, payload: { artifact_digest: stored.digest } };
  };
}
