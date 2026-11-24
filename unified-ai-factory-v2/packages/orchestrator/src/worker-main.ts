/**
 * Agent worker entrypoint. Stopped by default. Run with: bun packages/orchestrator/src/worker-main.ts
 *
 * In this build no runtime adapter is registered, so the start decision is always "no" and the process exits with the reason.
 * Starting for real needs: (1) adapters registered here, (2) a configured DATABASE_URL, organization, workspace root and sandbox
 * backend, and (3) an operator enabling DISPATCH_WORKER_ENABLE=1. Memory (DISPATCH_MEMORY_CONTEXT) stays off unless also set.
 */
import { workerStartDecision } from "./worker-start";

const REGISTERED_ADAPTERS = 0; // adapters that exist in this build; none are wired into a process yet

const decision = workerStartDecision(process.env, REGISTERED_ADAPTERS);
if (!decision.start) {
  console.error(`[agent-worker] not started: ${decision.reason}`);
  process.exit(process.env.DISPATCH_WORKER_ENABLE === "1" ? 1 : 0);
}
console.error("[agent-worker] start is allowed, but the process wiring (DB, sandbox backend, adapters) is not part of this build");
process.exit(1);
