/** Environment switch that allows a worker process to start at all. Anything other than "1" keeps it stopped (the default). */
export const WORKER_ENABLE_ENV = "DISPATCH_WORKER_ENABLE";

export interface WorkerStartDecision {
  start: boolean;
  reason: string;
}

/**
 * Decides whether a worker process may start. Fails closed: the worker must be explicitly enabled, and at least one runtime
 * adapter must be registered in this build. Memory has its own switch (DISPATCH_MEMORY_CONTEXT) and never enables a worker.
 */
export function workerStartDecision(env: Readonly<Record<string, string | undefined>>, registeredAdapters: number): WorkerStartDecision {
  if (env[WORKER_ENABLE_ENV] !== "1") return { start: false, reason: `worker disabled: set ${WORKER_ENABLE_ENV}=1 to allow it to start` };
  if (registeredAdapters === 0) return { start: false, reason: "no runtime adapter is registered in this build; nothing can run" };
  return { start: true, reason: "enabled and at least one runtime adapter is registered" };
}
