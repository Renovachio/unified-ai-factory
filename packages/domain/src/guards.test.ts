import { describe, expect, test } from "bun:test";
import { GuardError, assertPauseInvariant, assertTransition, onHeadShaChange, type JobSnapshot } from "./guards";
import { changedBindingFields, isApprovalStale, type EvidenceBinding } from "./binding";
import { effectiveRisk, maxRisk, requiresHumanApproval } from "./risk";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const B1 = "c".repeat(40);
const bind = (over: Partial<EvidenceBinding> = {}): EvidenceBinding => ({
  repoId: "r1", headSha: H1, baseSha: B1, gateConfigDigest: "g1", policyDigest: "p1", reviewerSetDigest: "rv1", artifactDigest: "a1", policyVersion: "1", ...over,
});
const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  state: "PREMERGE", version: 3, risk: "LOW", headSha: H1, gate: bind(), current: bind(), round: 0, maxRounds: 3,
  requiredReviewers: ["code"], reviews: [{ role: "code", binding: bind() }], approval: bind(), ...over,
});
const code = (fn: () => void): string | undefined => {
  try { fn(); } catch (e) { return e instanceof GuardError ? e.code : "other:" + String(e); }
  return undefined;
};

describe("stale SHA / evidence invalidation", () => {
  test.each(["repoId", "headSha", "baseSha", "gateConfigDigest", "policyDigest", "reviewerSetDigest", "artifactDigest", "policyVersion"] as const)(
    "changing %s makes approval stale",
    (field) => {
      const changed = bind({ [field]: field === "headSha" || field === "baseSha" ? H2 : "other" });
      expect(isApprovalStale(bind(), changed)).toBe(true);
      expect(changedBindingFields(bind(), changed)).toEqual([field]);
      expect(code(() => assertTransition(job({ current: changed }), "MERGING"))).toBe("stale-approval");
    },
  );
  test("fresh approval allows MERGING", () => {
    expect(code(() => assertTransition(job(), "MERGING"))).toBeUndefined();
  });
  test("missing approval blocks MERGING", () => {
    expect(code(() => assertTransition(job({ approval: undefined }), "MERGING"))).toBe("no-approval");
  });
  test("new head SHA returns post-gate states to GATING and invalidates everything", () => {
    for (const s of ["GATING", "REVIEWING", "PREMERGE", "AWAITING_HUMAN", "MERGING"] as const) {
      expect(onHeadShaChange(job({ state: s }), H2)).toEqual({ state: "GATING", invalidate: ["gate", "reviews", "approval"] });
    }
    expect(onHeadShaChange(job({ state: "BUILDING" }), H2).state).toBe("BUILDING");
    expect(onHeadShaChange(job(), H1)).toEqual({ state: "PREMERGE", invalidate: [] });
    expect(code(() => onHeadShaChange(job(), "nope"))).toBe("bad-sha");
  });
});

describe("guards", () => {
  test("illegal transition rejected", () => {
    expect(() => assertTransition(job({ state: "QUEUED" }), "MERGING")).toThrow();
  });
  test("GATING needs candidate SHA", () => {
    expect(code(() => assertTransition(job({ state: "BUILDING", headSha: undefined }), "GATING"))).toBe("no-candidate");
    expect(code(() => assertTransition(job({ state: "BUILDING" }), "GATING"))).toBeUndefined();
  });
  test("REVIEWING needs fresh gate", () => {
    expect(code(() => assertTransition(job({ state: "GATING", gate: undefined }), "REVIEWING"))).toBe("no-gate");
    expect(code(() => assertTransition(job({ state: "GATING", current: bind({ headSha: H2 }) }), "REVIEWING"))).toBe("stale-gate");
  });
  test("PREMERGE needs every required reviewer on the exact candidate", () => {
    expect(code(() => assertTransition(job({ state: "REVIEWING", requiredReviewers: ["code", "security"] }), "PREMERGE"))).toBe("missing-review");
    expect(code(() => assertTransition(job({ state: "REVIEWING", reviews: [{ role: "code", binding: bind({ headSha: H2 }) }] }), "PREMERGE"))).toBe("stale-review");
    expect(code(() => assertTransition(job({ state: "REVIEWING" }), "PREMERGE"))).toBeUndefined();
  });
  test("rework budget enforced", () => {
    expect(code(() => assertTransition(job({ state: "BUILDING", round: 3 }), "REWORK"))).toBe("rework-budget");
    expect(code(() => assertTransition(job({ state: "BUILDING", round: 2 }), "REWORK"))).toBeUndefined();
  });
  test("paused jobs can only be cancelled and hold no lease", () => {
    expect(code(() => assertTransition(job({ state: "BUILDING", pausedAt: "t" }), "GATING"))).toBe("paused");
    expect(code(() => assertTransition(job({ state: "BUILDING", pausedAt: "t" }), "CANCELLED"))).toBeUndefined();
    expect(code(() => assertPauseInvariant(job({ pausedAt: "t", hasActiveLease: true })))).toBe("paused-with-lease");
  });
});

describe("risk", () => {
  test("deterministic floor cannot be lowered by model proposal", () => {
    expect(effectiveRisk("HIGH", "LOW")).toBe("HIGH");
    expect(effectiveRisk("LOW", "CRITICAL")).toBe("CRITICAL");
    expect(effectiveRisk(undefined, undefined)).toBe("CRITICAL");
    expect(effectiveRisk(undefined, "LOW")).toBe("HIGH");
    expect(maxRisk("LOW", "MEDIUM")).toBe("MEDIUM");
  });
  test("HIGH/CRITICAL require humans", () => {
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((r) => requiresHumanApproval(r as never))).toEqual([false, false, true, true]);
  });
});
