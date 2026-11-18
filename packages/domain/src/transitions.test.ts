import { describe, expect, test } from "bun:test";
import { JOB_STATES, TRANSITIONS, canTransition, assertAllowedTransition, InvalidTransitionError, TERMINAL_STATES, type JobState } from "./states";

// Independent copy of the blueprint table (§5) so a typo in the implementation is caught.
const SPEC: Record<string, string> = {
  QUEUED: "INTAKE,CANCELLED",
  INTAKE: "NEEDS_INFO,SPECIFYING,REJECTED,FAILED,CANCELLED",
  NEEDS_INFO: "INTAKE,CANCELLED,REJECTED",
  SPECIFYING: "READY,NEEDS_INFO,FAILED,CANCELLED",
  READY: "PROVISIONING,CANCELLED",
  PROVISIONING: "BUILDING,FAILED,QUARANTINED,CANCELLED",
  BUILDING: "GATING,REWORK,FAILED,QUARANTINED,CANCELLED",
  GATING: "REVIEWING,REWORK,FAILED,QUARANTINED,CANCELLED",
  REVIEWING: "PREMERGE,REWORK,FAILED,QUARANTINED,CANCELLED",
  REWORK: "BUILDING,AWAITING_HUMAN,FAILED,CANCELLED",
  PREMERGE: "AWAITING_HUMAN,MERGING,REWORK,FAILED,QUARANTINED,CANCELLED",
  AWAITING_HUMAN: "PREMERGE,REWORK,REJECTED,CANCELLED",
  MERGING: "MERGED,PREMERGE,FAILED,QUARANTINED",
  MERGED: "POSTMERGE_MONITOR",
  POSTMERGE_MONITOR: "DONE,FAILED",
  DONE: "", REJECTED: "", CANCELLED: "",
  FAILED: "QUEUED,REWORK,CANCELLED",
  QUARANTINED: "CANCELLED,FAILED",
};

const pairs = JOB_STATES.flatMap((f) => JOB_STATES.map((t) => [f, t] as const));

describe("state transition matrix (every pair)", () => {
  test("has 20 states and 400 pairs", () => {
    expect(JOB_STATES.length).toBe(20);
    expect(pairs.length).toBe(400);
  });
  test.each(pairs)("%s -> %s", (from, to) => {
    const legal = (SPEC[from] ?? "").split(",").filter(Boolean).includes(to);
    expect(canTransition(from, to)).toBe(legal);
    if (legal) expect(() => assertAllowedTransition(from, to)).not.toThrow();
    else expect(() => assertAllowedTransition(from, to)).toThrow(InvalidTransitionError);
  });
  test("terminal states have no exits; FAILED/QUARANTINED are not terminal", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["CANCELLED", "DONE", "REJECTED"]);
    expect(TRANSITIONS.FAILED.length).toBeGreaterThan(0);
  });
  test("no path from FAILED/QUARANTINED straight to MERGING/MERGED", () => {
    for (const s of ["FAILED", "QUARANTINED"] as JobState[]) {
      expect(canTransition(s, "MERGING")).toBe(false);
      expect(canTransition(s, "MERGED")).toBe(false);
    }
  });
});
