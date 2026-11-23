import type { Sql } from "@factory/db";
import { buildContextPack, resolveContextPack, ROLE_INPUT_CAPS, type Actor, type PackTextStore } from "@factory/memory";
import type { AgentRole } from "@factory/runtimes";

/**
 * Opt-in wiring of project memory into agent runs (MEM-04 follow-up). Only the roles listed here receive a memory pack.
 * Every other role keeps its existing context URI. A role that opted in is refused (the run fails) if its pack cannot be
 * built: there is no silent fallback to the old context. Nothing here calls a model.
 */
export const MEMORY_CONTEXT_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["spec", "builder"]);

export interface MemoryPackInput {
  actor: Actor;
  projectId: string;
  task: string;
  systemInstructions: string;
  directSource?: string;
  /** Optional lower budget for this run. Never above the role cap. */
  maxInputTokens?: number;
}

export interface MemoryContextDeps {
  sql: Sql;
  store: PackTextStore;
  roles?: ReadonlySet<AgentRole>;
  /** Supplies the actor, project, task and instructions for a job and role. Trusted composition code. */
  packInputFor: (jobId: string, role: AgentRole) => Promise<MemoryPackInput>;
  /** Existing behaviour for every role that did not opt in. */
  fallback: (jobId: string, role: AgentRole) => string | Promise<string>;
}

/** Returns a contextUri function for ExecutorDeps: `context-pack:<id>` for opted-in roles, the fallback URI otherwise. */
export function memoryContextUri(d: MemoryContextDeps): (jobId: string, role: AgentRole) => Promise<string> {
  const roles = d.roles ?? MEMORY_CONTEXT_ROLES;
  return async (jobId, role) => {
    if (!roles.has(role)) return d.fallback(jobId, role);
    const input = await d.packInputFor(jobId, role);
    const pack = await buildContextPack(d.sql, input.actor, {
      projectId: input.projectId,
      modelRole: role,
      // Above the role cap is refused by buildContextPack (ROLE_CAP_EXCEEDED); it is never clipped here.
      maxInputTokens: input.maxInputTokens ?? ROLE_INPUT_CAPS[role],
      systemInstructions: input.systemInstructions,
      task: input.task,
      ...(input.directSource !== undefined ? { directSource: input.directSource } : {}),
    }, d.store);
    return pack.manifestUri;
  };
}

/** The runtime's loadContext hook: resolves `context-pack:<id>` to verified text, or throws (the run fails closed). */
export function memoryContextLoader(sql: Sql, store: PackTextStore): (uri: string) => Promise<string> {
  return async (uri) => (await resolveContextPack(sql, uri, store)).text;
}
