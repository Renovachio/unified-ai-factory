import type { Sql } from "@factory/db";
import { MemoryError, type Actor } from "@factory/memory";
import type { TaskExecutor } from "@factory/runner";
import { loadRolePrompt, type AgentRole, type AgentRuntimeAdapter } from "@factory/runtimes";
import { agentTaskExecutor } from "./executor";
import { FileArtifactStore } from "./artifacts";
import { memoryContextLoader, memoryContextUri, MEMORY_CONTEXT_ROLES, type MemoryPackInput } from "./memory-context";

/** Environment switch for memory packs. Anything other than "1" leaves memory OFF (the default). */
export const MEMORY_CONTEXT_ENV = "DISPATCH_MEMORY_CONTEXT";
export const memoryContextEnabled = (env: Readonly<Record<string, string | undefined>>): boolean => env[MEMORY_CONTEXT_ENV] === "1";

/**
 * Supplies the pack inputs for a job and role. The pack is built on behalf of the job's creator (jobs.created_by), so it reaches
 * only what that person can see in the job's project, and their current role and disabled status are checked when the run starts.
 * Task text is the request title and description (requester-supplied, escaped inside <task>). System instructions are the
 * factory's role prompt, not requester text.
 */
export function jobPackInput(sql: Sql): (jobId: string) => Promise<Omit<MemoryPackInput, "systemInstructions">> {
  return async (jobId) => {
    const [row] = await sql<{ created_by: string | null; repository_id: string; organization_id: string; title: string; description: string }[]>`
      SELECT j.created_by, j.repository_id, r.organization_id, rq.title, rq.description
      FROM jobs j JOIN requests rq ON rq.id = j.request_id JOIN repositories r ON r.id = j.repository_id WHERE j.id = ${jobId}`;
    if (!row) throw new MemoryError("NOT_FOUND", "job not found");
    if (!row.created_by) throw new MemoryError("FORBIDDEN", "job has no creator; no memory pack can be built on anyone's behalf");
    const actor: Actor = { organizationId: row.organization_id, userId: row.created_by };
    return { actor, projectId: row.repository_id, task: `${row.title}\n\n${row.description}` };
  };
}

export interface AgentCompositionDeps {
  sql: Sql;
  adapter: AgentRuntimeAdapter;
  store: FileArtifactStore;
  modelFor: (role: AgentRole) => string;
  /** Existing context URI for every role that is not memory-enabled. */
  fallbackContextUri: (jobId: string, role: AgentRole) => string | Promise<string>;
  memory?: { enabled: boolean; roles?: ReadonlySet<AgentRole>; promptsDir?: string };
}

/**
 * Composes the agent-role executor. With memory disabled (the default) it behaves exactly as agentTaskExecutor with the
 * fallback URI. With memory enabled, opted-in roles get a verified memory pack, and the returned loadContext resolves it.
 */
export function composeAgentExecutor(d: AgentCompositionDeps): { executor: TaskExecutor; loadContext: (uri: string) => Promise<string> } {
  const enabled = d.memory?.enabled === true;
  const roles = d.memory?.roles ?? MEMORY_CONTEXT_ROLES;
  const contextUri = enabled
    ? memoryContextUri({
        sql: d.sql,
        store: d.store,
        roles,
        packInputFor: async (jobId, role) => {
          const input = await jobPackInput(d.sql)(jobId);
          return { ...input, systemInstructions: loadRolePrompt(role, d.memory?.promptsDir).text };
        },
        fallback: d.fallbackContextUri,
      })
    : d.fallbackContextUri;
  const executor = agentTaskExecutor({ sql: d.sql, adapter: d.adapter, store: d.store, modelFor: d.modelFor, contextUri });
  return { executor, loadContext: memoryContextLoader(d.sql, d.store) };
}
