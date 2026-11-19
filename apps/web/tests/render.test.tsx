import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AuditTable, ErrorNote, JobsTable, PolicyPanel, safeUrl, StateBadge, Timeline, UntrustedText, UsagePanel, WorkersTable, type UsageView } from "../lib/view";

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
