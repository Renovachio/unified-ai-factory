import type { AgentRole } from "@factory/runtimes";
import type { JobState } from "@factory/domain";

export interface AgentStep {
  role: AgentRole;
  /** Artifact kind produced by the step. `{r}` expands to the rework round so reruns do not collide. */
  artifact: string;
  /** Whether the artifact is round-scoped. */
  perRound?: boolean;
}

/** Declarative pipeline: agent steps run in order within a state; when all are satisfied the job moves to `next`. */
export const AGENT_STAGES: Partial<Record<JobState, { steps: AgentStep[]; next: JobState }>> = {
  INTAKE: { steps: [{ role: "intake", artifact: "intake.json" }], next: "SPECIFYING" },
  SPECIFYING: {
    steps: [
      { role: "analyst", artifact: "requirements.json" },
      { role: "architect", artifact: "design.json" },
      { role: "spec", artifact: "spec.json" },
    ],
    next: "READY",
  },
  BUILDING: {
    steps: [
      { role: "builder", artifact: "build.json", perRound: true },
      { role: "tester", artifact: "test-plan.json", perRound: true },
    ],
    next: "GATING",
  },
};

export const artifactKind = (s: AgentStep, round: number): string => (s.perRound ? s.artifact.replace(/\.json$/, `.r${round}.json`) : s.artifact);
export const taskStage = (state: JobState, s: AgentStep, round: number): string => `${state}:${s.role}${s.perRound ? `:r${round}` : ""}`;
