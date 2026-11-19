import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceBinding } from "./binding";
import { assertPolicyInvariants, assessMerge, classifyPaths, evaluatePolicy, loadPolicy, PolicyInvalid, policyDigest, type PolicyConfig, type PolicyInput, type UncertaintySignal } from "./policy";
import { RISK_LEVELS, requiresHumanApproval, riskRank, type RiskLevel } from "./risk";

const CONFIG_DIR = join(import.meta.dir, "../../../config");
const { policy: SHIPPED, digest: SHIPPED_DIGEST } = loadPolicy(CONFIG_DIR);
const clone = (): PolicyConfig => structuredClone(SHIPPED);
/** A hypothetical operator config that has legitimately turned on LOW-risk auto-merge after the pilot. */
const autoOn = (): PolicyConfig => { const p = clone(); p.merge.pilotHumanApproval = false; p.merge.autoMerge = { enabled: true, allowedRisks: ["LOW"], requireCalibration: true }; return p; };

describe("policy configuration", () => {
  test("the shipped policy loads, is the pilot (manual) policy, and has a stable digest", () => {
    expect(SHIPPED.merge.pilotHumanApproval).toBe(true);
    expect(SHIPPED.merge.autoMerge.enabled).toBe(false);
    expect(SHIPPED_DIGEST).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(loadPolicy(CONFIG_DIR).digest).toBe(SHIPPED_DIGEST);
  });
  test("any change to the policy changes its digest (so bound approvals go stale)", () => {
    const edits: Array<(p: PolicyConfig) => void> = [(p) => { p.version = "1.1"; }, (p) => { p.minimumRisk.unmatchedPathLevel = "LOW"; }, (p) => { p.merge.humanApproval.approvalMaxAgeMinutes = 5; }, (p) => { p.minimumRisk.pathRules.pop(); }];
    for (const e of edits) { const p = clone(); e(p); expect(policyDigest(p)).not.toBe(SHIPPED_DIGEST); }
  });
  test("configurations that would allow unattended HIGH/CRITICAL merges are refused", () => {
    const bad: Array<[string, (p: PolicyConfig) => void]> = [
      ["HIGH in autoMerge.allowedRisks", (p) => { p.merge.autoMerge.allowedRisks = ["LOW", "HIGH"]; }],
      ["CRITICAL in autoMerge.allowedRisks", (p) => { p.merge.autoMerge.allowedRisks = ["CRITICAL"]; }],
      ["HIGH not human-approved", (p) => { p.merge.humanApproval.requiredForRisks = ["CRITICAL"]; }],
      ["CRITICAL not human-approved", (p) => { p.merge.humanApproval.requiredForRisks = ["HIGH"]; }],
      ["two-person outside the human set", (p) => { p.merge.humanApproval.requiredForRisks = ["HIGH", "CRITICAL"]; p.merge.humanApproval.twoPersonForRisks = ["MEDIUM"]; }],
      ["auto-merge on during the pilot", (p) => { p.merge.autoMerge.enabled = true; }],
    ];
    for (const [name, e] of bad) { const p = clone(); e(p); expect(() => assertPolicyInvariants(p), name).toThrow(PolicyInvalid); }
    const dir = mkdtempSync(join(tmpdir(), "pol-"));
    cpSync(join(CONFIG_DIR, "risk-policy.json"), join(dir, "risk-policy.json"));
    const raw = JSON.parse(readFileSync(join(dir, "risk-policy.json"), "utf8")); raw.merge.autoMerge.allowedRisks = ["HIGH"];
    writeFileSync(join(dir, "risk-policy.json"), JSON.stringify(raw));
    expect(() => loadPolicy(dir)).toThrow(PolicyInvalid);
    raw.merge.autoMerge.allowedRisks = ["LOW"]; raw.surprise = true;
    writeFileSync(join(dir, "risk-policy.json"), JSON.stringify(raw));
    expect(() => loadPolicy(dir)).toThrow(); // strict schema
  });
});

describe("path classification (minimum-risk overrides)", () => {
  test("strictest rule wins; unmatched paths are never LOW by omission", () => {
    const c = (paths: string[]) => classifyPaths(paths, SHIPPED);
    expect(c([".github/workflows/ci.yml"]).floor).toBe("CRITICAL");
    expect(c(["config/risk-policy.json"]).floor).toBe("CRITICAL");
    expect(c(["migrations/0001.sql"]).floor).toBe("HIGH");
    expect(c(["apps/web/package.json"]).floor).toBe("HIGH");
    expect(c(["src/auth/session.ts"]).floor).toBe("HIGH");
    expect(c(["src/search.ts"]).floor).toBe("MEDIUM");
    expect(c(["README.md", "docs/a.md", "tests/a.test.ts"]).floor).toBe("LOW");
    expect(c(["weird/unknown.xyz"])).toMatchObject({ floor: "MEDIUM", classes: [{ matched: false }] });
    expect(c(["README.md", ".github/workflows/x.yml"]).floor).toBe("CRITICAL"); // one protected file lifts the whole change
    expect(c(["src/payments/charge.ts"]).floor).toBe("HIGH");
  });
});

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  policy: SHIPPED, policyDigest: SHIPPED_DIGEST, changedFiles: ["README.md"], gate: { passed: true, boundToHead: true }, reviews: { allRequiredPassed: true }, ...over,
});
const levels: Array<RiskLevel | undefined> = [undefined, ...RISK_LEVELS];

describe("evaluatePolicy invariants (exhaustive)", () => {
  test("HIGH/CRITICAL are NEVER auto-merge eligible and ALWAYS need a human, under every input and even under a permissive config; uncertainty escalates; floors only ratchet up", () => {
    let n = 0;
    const signalSets: Array<UncertaintySignal[]> = [[], ["diff-truncated"], ["symlink", "binary-change"]];
    const fileSets: Array<string[] | null> = [["README.md"], ["src/search.ts"], ["migrations/1.sql"], null];
    for (const cfg of [SHIPPED, autoOn()]) for (const text of levels) for (const spec of levels) for (const cur of levels) for (const model of levels) for (const sig of signalSets) for (const files of fileSets) {
      const input = base({ policy: cfg, changedFiles: files, textFloor: text, specFloor: spec, currentRisk: cur, modelProposal: model, uncertainty: sig, calibrated: true });
      const d = evaluatePolicy(input);
      n++;
      if (requiresHumanApproval(d.risk)) { expect(d.autoMergeEligible).toBe(false); expect(d.requiresHumanApproval).toBe(true); }
      if (d.autoMergeEligible) { expect(requiresHumanApproval(d.risk)).toBe(false); expect(d.uncertain).toBe(false); expect(d.blockers).toEqual([]); }
      if (d.uncertain) expect(riskRank(d.risk)).toBeGreaterThanOrEqual(riskRank("HIGH"));
      for (const f of [text, spec, cur, model]) if (f) expect(riskRank(d.risk)).toBeGreaterThanOrEqual(riskRank(f));
      const without = evaluatePolicy({ ...input, modelProposal: undefined });
      expect(riskRank(d.risk)).toBeGreaterThanOrEqual(riskRank(without.risk)); // a model can only raise
      if (cfg === SHIPPED) expect(d.autoMergeEligible).toBe(false); // pilot
    }
    expect(n).toBe(2 * 5 * 5 * 5 * 5 * 3 * 4);
  });
  test("unknown everything is CRITICAL; unknown diff escalates", () => {
    expect(evaluatePolicy({ ...base({ changedFiles: null }) }).risk).toBe("CRITICAL");
    const d = evaluatePolicy(base({ changedFiles: null, textFloor: "LOW" }));
    expect(d).toMatchObject({ uncertain: true, risk: "HIGH" });
    expect(d.reasons.join(" ")).toContain("uncertain classification");
    expect(evaluatePolicy(base({ changedFiles: [], textFloor: "LOW" })).uncertain).toBe(true);
    expect(evaluatePolicy(base({ changedFiles: Array.from({ length: 201 }, (_, i) => `docs/${i}.md`) })).uncertain).toBe(true);
  });
  test("a model proposing LOW cannot lower anything; proposing higher raises and is explained", () => {
    expect(evaluatePolicy(base({ changedFiles: ["migrations/1.sql"], modelProposal: "LOW" })).risk).toBe("HIGH");
    const raised = evaluatePolicy(base({ changedFiles: ["README.md"], modelProposal: "CRITICAL" }));
    expect(raised.risk).toBe("CRITICAL");
    expect(raised.reasons.join(" ")).toContain("model proposal CRITICAL raised the floor");
  });
  test("two-person approval is derived from the policy for CRITICAL", () => {
    expect(evaluatePolicy(base({ changedFiles: [".github/workflows/x.yml"] }))).toMatchObject({ risk: "CRITICAL", twoPerson: true });
    expect(evaluatePolicy(base({ changedFiles: ["migrations/1.sql"] })).twoPerson).toBe(false);
  });
});

describe("auto-merge eligibility needs EVERY condition", () => {
  const ok = (): PolicyInput => base({ policy: autoOn(), changedFiles: ["README.md", "docs/a.md"], calibrated: true });
  test("all conditions met => eligible (hypothetical post-pilot config)", () => {
    const d = evaluatePolicy(ok());
    expect(d).toMatchObject({ risk: "LOW", autoMergeEligible: true, requiresHumanApproval: false, blockers: [] });
  });
  const flips: Array<[string, (i: PolicyInput) => PolicyInput]> = [
    ["auto-merge disabled", (i) => { const p = structuredClone(i.policy); p.merge.autoMerge.enabled = false; return { ...i, policy: p }; }],
    ["pilot flag on", (i) => { const p = structuredClone(i.policy); p.merge.pilotHumanApproval = true; p.merge.autoMerge.enabled = false; return { ...i, policy: p }; }],
    ["MEDIUM not allowlisted", (i) => ({ ...i, changedFiles: ["src/a.ts"] })],
    ["HIGH change", (i) => ({ ...i, changedFiles: ["migrations/1.sql"] })],
    ["uncertain", (i) => ({ ...i, uncertainty: ["binary-change"] as UncertaintySignal[] })],
    ["gate not passing", (i) => ({ ...i, gate: { passed: false, boundToHead: true } })],
    ["gate not bound to head", (i) => ({ ...i, gate: { passed: true, boundToHead: false } })],
    ["reviews incomplete", (i) => ({ ...i, reviews: { allRequiredPassed: false } })],
    ["not calibrated", (i) => ({ ...i, calibrated: false })],
    ["model raised risk", (i) => ({ ...i, modelProposal: "HIGH" as RiskLevel })],
  ];
  test.each(flips)("%s => NOT eligible, with the reason listed", (_n, flip) => {
    const d = evaluatePolicy(flip(ok()));
    expect(d.autoMergeEligible).toBe(false);
    expect(d.requiresHumanApproval).toBe(true);
    expect(d.blockers.length).toBeGreaterThan(0);
  });
  test("the shipped pilot policy never auto-merges anything, with the pilot reason", () => {
    const d = evaluatePolicy(base({ changedFiles: ["README.md"], calibrated: true }));
    expect(d.autoMergeEligible).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/pilot/);
  });
});

describe("assessMerge (server-side, fresh facts)", () => {
  const H = "a".repeat(40); const B = "b".repeat(40);
  const bind = (over: Partial<EvidenceBinding> = {}): EvidenceBinding => ({ repoId: "r", headSha: H, baseSha: B, gateConfigDigest: "g", policyDigest: SHIPPED_DIGEST, reviewerSetDigest: "rv", artifactDigest: "a", policyVersion: "1", ...over });
  const now = 1_000_000_000_000;
  const high = evaluatePolicy(base({ changedFiles: ["migrations/1.sql"] }));
  const critical = evaluatePolicy(base({ changedFiles: [".github/workflows/x.yml"] }));
  const approve = (actor: string, over: Partial<EvidenceBinding> = {}, ageMin = 1): { actorId: string; decision: "approve" | "reject" | "rework"; binding: EvidenceBinding; approvedAtMs: number } => ({ actorId: actor, decision: "approve", binding: bind(over), approvedAtMs: now - ageMin * 60_000 });
  const input = (decision: typeof high, approvals: ReturnType<typeof approve>[], over: Partial<Parameters<typeof assessMerge>[0]> = {}) => ({ decision, current: bind(), approvals, prOpen: true, prDraft: false, nowMs: now, ...over });

  test("HIGH with a fresh approval bound to exactly this head/base/policy/evidence is allowed; without one it is not", () => {
    expect(assessMerge(input(high, [approve("u1")]))).toMatchObject({ allowed: true, validApprovers: ["u1"] });
    expect(assessMerge(input(high, [])).blockers.join(" ")).toMatch(/no human approval/);
  });
  test.each(["headSha", "baseSha", "gateConfigDigest", "policyDigest", "reviewerSetDigest", "artifactDigest", "policyVersion"] as const)("an approval is stale when %s changed", (f) => {
    const r = assessMerge(input(high, [approve("u1", { [f]: f.endsWith("Sha") ? "c".repeat(40) : "x" })]));
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/stale|policy changed/);
  });
  test("expired approvals, rejections, draft/closed PRs, and policy changes block", () => {
    expect(assessMerge(input(high, [approve("u1", {}, 241)])).allowed).toBe(false);
    expect(assessMerge(input(high, [approve("u1", {}, 239)])).allowed).toBe(true);
    expect(assessMerge(input(high, [approve("u1"), { actorId: "u2", decision: "reject", binding: bind(), approvedAtMs: now }])).blockers.join(" ")).toMatch(/rejected/);
    expect(assessMerge(input(high, [approve("u1")], { prOpen: false })).allowed).toBe(false);
    expect(assessMerge(input(high, [approve("u1")], { prDraft: true })).allowed).toBe(false);
    expect(assessMerge({ ...input(high, [approve("u1")]), current: bind({ policyDigest: "sha256:" + "9".repeat(64) }) }).blockers.join(" ")).toMatch(/policy changed/);
  });
  test("CRITICAL needs two DISTINCT approvers, neither being the requester", () => {
    expect(assessMerge(input(critical, [approve("u1")])).allowed).toBe(false);
    expect(assessMerge(input(critical, [approve("u1"), approve("u1")])).allowed).toBe(false);
    expect(assessMerge(input(critical, [approve("u1"), approve("u2")], { requestedBy: "u2" })).allowed).toBe(false);
    expect(assessMerge(input(critical, [approve("u1"), approve("u2")])).allowed).toBe(true);
  });
  test("a decision that WRONGLY claims auto-merge eligibility for HIGH still cannot merge without a human", () => {
    const forged = { ...high, requiresHumanApproval: false, autoMergeEligible: true };
    const r = assessMerge(input(forged, []));
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/HIGH changes can only be merged with a valid human approval/);
  });
});
