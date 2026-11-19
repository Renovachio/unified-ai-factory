export const JOB_STATES = [
  "QUEUED", "INTAKE", "NEEDS_INFO", "SPECIFYING", "READY", "PROVISIONING", "BUILDING", "GATING",
  "REVIEWING", "REWORK", "PREMERGE", "AWAITING_HUMAN", "MERGING", "MERGED", "POSTMERGE_MONITOR",
  "DONE", "REJECTED", "CANCELLED", "FAILED", "QUARANTINED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Blueprint §5 legal transitions. Any pair not listed is illegal. */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  QUEUED: ["INTAKE", "CANCELLED"],
  INTAKE: ["NEEDS_INFO", "SPECIFYING", "REJECTED", "FAILED", "CANCELLED"],
  NEEDS_INFO: ["INTAKE", "CANCELLED", "REJECTED"],
  SPECIFYING: ["READY", "NEEDS_INFO", "FAILED", "CANCELLED"],
  READY: ["PROVISIONING", "CANCELLED"],
  PROVISIONING: ["BUILDING", "FAILED", "QUARANTINED", "CANCELLED"],
  BUILDING: ["GATING", "REWORK", "FAILED", "QUARANTINED", "CANCELLED"],
  GATING: ["REVIEWING", "REWORK", "FAILED", "QUARANTINED", "CANCELLED"],
  REVIEWING: ["PREMERGE", "REWORK", "FAILED", "QUARANTINED", "CANCELLED"],
  REWORK: ["BUILDING", "AWAITING_HUMAN", "FAILED", "CANCELLED"],
  PREMERGE: ["AWAITING_HUMAN", "MERGING", "REWORK", "FAILED", "QUARANTINED", "CANCELLED"],
  AWAITING_HUMAN: ["PREMERGE", "REWORK", "REJECTED", "CANCELLED"],
  MERGING: ["MERGED", "PREMERGE", "FAILED", "QUARANTINED"],
  MERGED: ["POSTMERGE_MONITOR"],
  POSTMERGE_MONITOR: ["DONE", "FAILED"],
  DONE: [],
  REJECTED: [],
  CANCELLED: [],
  FAILED: ["QUEUED", "REWORK", "CANCELLED"],
  QUARANTINED: ["CANCELLED", "FAILED"],
};

export const TERMINAL_STATES: readonly JobState[] = JOB_STATES.filter((s) => TRANSITIONS[s].length === 0);

/** States where an unattended merge can never be reached and recovery needs an explicit authorised action. */
export const RECOVERY_ONLY_STATES: readonly JobState[] = ["FAILED", "QUARANTINED"];

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobState,
    readonly to: JobState,
  ) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function isJobState(v: unknown): v is JobState {
  return typeof v === "string" && (JOB_STATES as readonly string[]).includes(v);
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertAllowedTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
