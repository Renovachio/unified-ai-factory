import { describe, expect, test } from "bun:test";
import { MockAdapter } from "../src/mock";
import { parseRoleOutput, OutputRejected } from "../src/output";
import { AGENT_ROLES, type AgentEvent, type AgentRole, type AgentRunRequest } from "../src/types";
import { request } from "../src/testing/contract-suite";

const SHA = "d".repeat(40);

async function play(a: MockAdapter, role: AgentRole, extra: Partial<AgentRunRequest> = {}) {
  const events: AgentEvent[] = [];
  const runId = await a.start(request({ role, ...extra }), (e) => { events.push(e); });
  let s = await a.status(runId);
  for (let i = 0; i < 300 && s.exitStatus === "running"; i++) { await new Promise((r) => setTimeout(r, 5)); s = await a.status(runId); }
  return { s, events };
}

describe("mock pipeline simulation (every role, end to end)", () => {
  test("all 12 roles complete with schema-valid output; reviewers are bound to the candidate SHA", async () => {
    const a = new MockAdapter();
    const out: Record<string, unknown> = {};
    for (const role of AGENT_ROLES) {
      const { s } = await play(a, role, role.startsWith("review_") ? { candidateSha: SHA } : {});
      expect(s.exitStatus).toBe("succeeded");
      out[role] = "output" in s ? s.output : undefined;
    }
    for (const r of ["review_code", "review_security", "review_ux", "review_ui", "review_performance"]) expect(out[r]).toMatchObject({ candidateSha: SHA, verdict: "pass" });
    expect(Object.keys(out).length).toBe(12);
  });
  test("a reviewer that returns garbage or someone else's SHA blocks progress instead of passing", async () => {
    const garbage = await play(new MockAdapter({ behavior: "bad_output" }), "review_code", { candidateSha: SHA });
    expect(garbage.s).toMatchObject({ exitStatus: "failed" });
    const wrong = await play(new MockAdapter({ behavior: "wrong_sha" }), "review_code", { candidateSha: SHA });
    expect(wrong.s).toMatchObject({ exitStatus: "failed", failureCode: "output-sha-mismatch" });
  });
  test("output parsing: size cap, non-JSON, wrong reviewer role, extra keys", () => {
    const ok = { reviewerRole: "code", candidateSha: SHA, verdict: "pass", findings: [] };
    expect(() => parseRoleOutput("review_code", JSON.stringify(ok), { maxBytes: 1000, expectedSha: SHA })).not.toThrow();
    expect(() => parseRoleOutput("review_code", JSON.stringify(ok), { maxBytes: 5 })).toThrow(OutputRejected);
    expect(() => parseRoleOutput("review_code", "not json", { maxBytes: 1000 })).toThrow(/not valid JSON/);
    expect(() => parseRoleOutput("review_security", ok, { maxBytes: 1000 })).toThrow(/does not match role/);
    expect(() => parseRoleOutput("builder", { artifactUri: "x", approve: true }, { maxBytes: 1000 })).toThrow(OutputRejected);
    expect(() => parseRoleOutput("review_code", { ...ok, verdict: "approved" }, { maxBytes: 1000 })).toThrow(OutputRejected);
  });
});
