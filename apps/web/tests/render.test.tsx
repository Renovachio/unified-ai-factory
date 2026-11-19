import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AuditTable, CandidateDiff, ComparisonPanel, ImprovementsTable, SkillsTable, ErrorNote, JobsTable, PolicyPanel, safeUrl, StateBadge, Timeline, UntrustedText, UsagePanel, WorkersTable, type UsageView } from "../lib/view";

const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const MONEY = /(\$\s?\d|usd|dollar|price|pricing|cost|invoice|billed|spend)/i;

describe("dashboard rendering is safe", () => {
  test("untrusted request text and event data are escaped, never interpreted", () => {
    const evil = `<img src=x onerror=alert(1)><script>steal()</script>"><a href="javascript:alert(1)">x</a>`;
    const out = html(<UntrustedText title={evil} text={evil} />);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("untrusted input");
    const tl = html(<Timeline entries={[{ ts: "2026-11-19T10:00:00.000Z", source: "event", id: "1", kind: evil, summary: evil, data: { message: evil } }]} />);
    expect(tl).not.toContain("<script>");
    expect(tl).not.toContain("<img");
  });
  test("only http(s) URLs become links (javascript:, data: and garbage are dropped)", () => {
    expect(safeUrl("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x", "//evil", "not a url", undefined, 5]) expect(safeUrl(bad)).toBeNull();
  });
  test("tables are accessible (captions, scoped headers) and empty states are explicit", () => {
    const jobs = html(<JobsTable items={[{ id: "11111111-2222-3333-4444-555555555555", repositoryId: "r", state: "AWAITING_HUMAN", version: 3, risk: "HIGH", priority: "normal", prNumber: 7, createdAt: "2026-11-19T10:00:00Z", updatedAt: "2026-11-19T11:00:00.000Z" }]} />);
    expect(jobs).toContain("<caption");
    expect(jobs).toContain('scope="col"');
    expect(jobs).toContain("AWAITING_HUMAN");
    expect(jobs).toContain('href="/jobs/11111111-2222-3333-4444-555555555555"');
    expect(html(<JobsTable items={[]} />)).toContain("No jobs yet");
    expect(html(<WorkersTable items={[]} />)).toContain("No workers");
    expect(html(<AuditTable items={[]} />)).toContain("No audit entries");
  });
  test("errors are announced; 401/403 get useful text", () => {
    expect(html(<ErrorNote error={{ status: 401, title: "Unauthorized" }} />)).toContain('role="alert"');
    expect(html(<ErrorNote error={{ status: 401, title: "Unauthorized" }} />)).toContain("Sign in required");
    expect(html(<ErrorNote error={{ status: 403, title: "Forbidden" }} />)).toContain("Not permitted");
  });
  test("state badges render every state", () => {
    for (const s of ["DONE", "FAILED", "AWAITING_HUMAN", "QUARANTINED", "BUILDING"]) expect(html(<StateBadge state={s} />)).toContain(s);
  });
});

describe("usage and policy views show capacity and reasons, never money", () => {
  const u: UsageView = {
    window: { since: "2026-11-12T00:00:00Z", until: "2026-11-19T00:00:00Z" }, jobs: { byState: { DONE: 2 } },
    runtimes: [{ runtimeId: "local-model", modelId: "qwen", authMode: "local_model", usageSource: "local_runtime", runs: 5, succeeded: 4, failed: 1, computeSeconds: 61.5, tokensIn: 1000, tokensOut: 400 }],
    roles: [{ role: "builder", runs: 2, avgComputeSeconds: 12 }], pressure: { rateLimitEvents: 1, expiredLeases: 0, invalidReviewReports: 2, reworkRequests: 1, gateFailures: 3 },
    capacity: { runningTasks: 1, workers: { active: 1 }, localMaxRunningJobs: 1, host: { cpuCount: 8, loadAvg1m: 1.2, memTotalMb: 16000, memFreeMb: 4000 } },
    note: "Counts and compute seconds only. No monetary, price or per-token-cost metrics are collected.",
  };
  test("usage panel", () => {
    const out = html(<UsagePanel u={u} />);
    expect(out).toContain("local_model");
    expect(out).toContain("Rate-limit events: 1");
    expect(out).toContain("capacity");
    // the only money-related words allowed are in the explicit disclaimer
    expect(out.replace(/No monetary, price or per-token-cost metrics are collected\./, "")).not.toMatch(MONEY);
  });
  test("policy panel explains risk with reasons and states human approval", () => {
    const out = html(<PolicyPanel p={{ risk: "HIGH", reviewers: { required: ["code", "security"], reasons: ["security: HIGH risk"] }, gates: [], mergeEligibility: { autoMergeEligible: false, requiresHuman: true, reasons: ["blocker: pilot"], policyDigest: "sha256:" + "a".repeat(64), headSha: "b".repeat(40) } }} />);
    expect(out).toContain("not eligible");
    expect(out).toContain("required");
    expect(out).toContain("security: HIGH risk");
    expect(out).not.toMatch(MONEY);
  });
  test("worker rows show sandbox isolation", () => {
    const out = html(<WorkersTable items={[{ id: "a".repeat(36), mode: "local", status: "quarantined", heartbeatAt: null, activeLeases: 0, capabilities: { sandbox: "seatbelt", isolation: "strong" } }]} />);
    expect(out).toContain("seatbelt / strong");
    expect(out).toContain("never");
  });
});

describe("v2.2 registry and improvement views", () => {
  test("skills table states inactive-by-default, shows digests, and has an explicit empty state", () => {
    const out = html(<SkillsTable items={[{ id: "1", kind: "skill", slug: "story-writer", version: "1.0.0", digest: "sha256:" + "a".repeat(64), state: "validated", active: false, createdAt: "2026-11-19T10:00:00Z" }]} />);
    expect(out).toContain("<caption"); expect(out).toContain("inactive"); expect(out).toContain("aaaaaaaaaaaa");
    expect(html(<SkillsTable items={[]} />)).toContain("stay inactive until an independent human approves");
  });
  test("a malicious diff or problem text is inert (escaped), and the diff has no clickable links", () => {
    const evil = `+<script>alert(1)</script><a href="javascript:x">y</a>`;
    const d = html(<CandidateDiff diff={`--- a/SKILL.md\n${evil}`} />);
    expect(d).not.toContain("<script>"); expect(d).not.toContain("<a "); expect(d).toContain("&lt;script&gt;"); expect(d).toContain('class="add"');
    const t = html(<ImprovementsTable items={[{ id: "12345678-aaaa-bbbb-cccc-dddddddddddd", state: "awaiting_approval", action: "revise_skill", risk: "low", problem: evil, hypothesis: "h", targetDigest: "sha256:" + "b".repeat(64), candidateDigest: null, comparisonId: null, rank: 0.1234 }]} />);
    expect(t).not.toContain("<script>"); expect(t).toContain("untrusted input"); expect(t).toContain('href="/improvements/12345678-aaaa-bbbb-cccc-dddddddddddd"');
  });
  test("the comparison panel reports uncertainty and never recommends approval without a passing evaluation; no pricing appears", () => {
    const base = { id: "c1", benchmarkDigest: "sha256:" + "c".repeat(64), evaluator: "grader:independent", metrics: { baselineMean: 0.5, candidateMean: 0.8, meanImprovement: 0.3, ciLow: -0.1, ciHigh: 0.7 }, criticalRegressions: 0, sampleSize: 6, uncertaintyNotes: "small sample widens the interval", reasons: ["sample size 6 < required 20"] };
    const low = html(<ComparisonPanel c={{ ...base, status: "insufficient_evidence", recommendation: "do_not_recommend" }} />);
    expect(low).toContain("approval NOT recommended"); expect(low).toContain("sample size 6 &lt; required 20"); expect(low).toContain("small sample widens the interval");
    const ok = html(<ComparisonPanel c={{ ...base, status: "passed", recommendation: "recommend_approval", sampleSize: 40 }} />);
    expect(ok).toContain("approval may be recommended"); expect(ok).not.toMatch(MONEY);
    expect(html(<ComparisonPanel c={null} />)).toContain("No independent evaluation");
  });
});
