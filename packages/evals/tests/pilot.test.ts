import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadThresholds, MIN_PILOT, validatePilotReport, type PilotReport } from "../src/index";
import { goodPilot } from "./pilot-fixture";

const thresholds = loadThresholds(join(import.meta.dir, "../../../config"));
describe("pilot calibration evidence", () => {
  test("a complete, signed pilot that meets every threshold is accepted and digest-bound", () => {
    const r = validatePilotReport(goodPilot(), thresholds);
    expect(r.ok).toBe(true);
    expect(r.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validatePilotReport(goodPilot(), thresholds).digest).toBe(r.digest);
  });
  test("every shortcoming is refused with a reason", () => {
    const cases: Array<[string, (p: PilotReport) => void, RegExp]> = [
      ["different fixtures", (p) => { p.fixtureDigest = "sha256:" + "0".repeat(64); }, /different benchmark fixture/],
      ["route misses review recall", (p) => { p.metrics.reviewRecall = 0.5; }, /reviewRecall/],
      ["route misses security recall", (p) => { p.metrics.securityReviewRecall = 0.1; }, /securityReviewRecall/],
      ["false positives too high", (p) => { p.metrics.reviewFalsePositiveRate = 0.9; }, /reviewFalsePositiveRate/],
      ["negative controls not escalated", (p) => { p.metrics.negativeControlEscalationRate = 0.8; }, /negativeControlEscalationRate/],
      ["high-risk auto-merge authorisation", (p) => { p.metrics.highRiskAutoMergeAuthorizations = 1; }, /highRiskAutoMergeAuthorizations/],
      ["too few tasks", (p) => { p.pilot.tasks = 29; }, /tasks 29 is below the required 30/],
      ["too few repositories", (p) => { p.pilot.repositories = 2; }, /repositories/],
      ["too few seeded defects", (p) => { p.pilot.seededDefects = 9; }, /seededDefects/],
      ["too few negative controls", (p) => { p.pilot.negativeControls = 4; }, /negativeControls/],
      ["too few manual merges in the pilot", (p) => { p.pilot.manualMerges = 3; }, /manualMerges/],
      ["escaped defects", (p) => { p.pilot.escapedDefects = 1; }, /escaped defects/],
      ["unauthorised auto merges", (p) => { p.pilot.unauthorizedAutoMerges = 1; }, /unauthorised automatic merges/],
    ];
    for (const [name, edit, why] of cases) { const p = goodPilot(); edit(p); const r = validatePilotReport(p, thresholds); expect(r.ok, name).toBe(false); expect(r.reasons.join(" "), name).toMatch(why); }
    expect(MIN_PILOT).toEqual({ tasks: 30, repositories: 3, seededDefects: 10, negativeControls: 5, manualMerges: 10 });
  });
  test("malformed or unsigned reports are refused (strict schema, sign-off and rollback plan required)", () => {
    for (const bad of [null, {}, { ...goodPilot(), signedOffBy: "" }, { ...goodPilot(), rollbackPlan: "short" }, { ...goodPilot(), extra: 1 }, { ...goodPilot(), pilot: { ...goodPilot().pilot, tasks: "30" } }]) expect(validatePilotReport(bad, thresholds).ok).toBe(false);
  });
});
