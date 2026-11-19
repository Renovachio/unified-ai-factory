import { describe, expect, test } from "bun:test";
import { validateAgentResult } from "@factory/contracts";
import { PolicyViolation } from "@factory/sandboxes";
import type { MockBehavior } from "../mock";
import { AgentEventSchema, TERMINAL_EVENTS, toWireResult, type AgentEvent, type AgentRunRequest, type AgentRunResult, type AgentRuntimeAdapter, type AuthMode } from "../types";

export interface ContractHarness {
  name: string;
  expectedAuthMode: AuthMode;
  /** Build an adapter wired to a (fake) backend exhibiting the named behavior. */
  create(behavior: MockBehavior): AgentRuntimeAdapter | Promise<AgentRuntimeAdapter>;
  /** Build an adapter whose environment contains a forbidden model credential. */
  createWithForbiddenEnv(): AgentRuntimeAdapter | Promise<AgentRuntimeAdapter>;
}

export const request = (over: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  requestId: crypto.randomUUID(), jobId: "job_1", attempt: 1, role: "builder", modelId: "test-model", promptVersion: "p1",
  immutableContextManifestUri: "file:///ctx.json", allowedTools: ["read"], maxWallTimeSec: 30, maxOutputBytes: 100_000, outputSchemaUri: "schema://builder",
  ...over,
});

const TERMINAL = TERMINAL_EVENTS as readonly string[];

async function runToEnd(a: AgentRuntimeAdapter, req: AgentRunRequest) {
  const events: AgentEvent[] = [];
  const runId = await a.start(req, (e) => { events.push(e); });
  for (let i = 0; i < 600; i++) {
    const s = await a.status(runId);
    if (s.exitStatus !== "running") return { runId, result: s as AgentRunResult, events };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run did not finish");
}

/** One suite for every runtime adapter (mock and every future adapter must pass the same tests). */
export function adapterContractSuite(h: ContractHarness): void {
  describe(`adapter contract: ${h.name}`, () => {
    test("probe reports availability, capabilities and an allowed auth mode", async () => {
      const p = await (await h.create("ok")).probe();
      expect(p.available).toBe(true);
      if (p.available) {
        expect(p.capabilities.authMode).toBe(h.expectedAuthMode);
        expect(["subscription_cli", "local_model"]).toContain(p.capabilities.authMode);
        expect(typeof p.capabilities.structuredOutput).toBe("boolean");
        expect(p.adapterId.length).toBeGreaterThan(0);
      }
      const off = await (await h.create("offline")).probe();
      expect(off.available).toBe(false);
      if (!off.available) expect(["offline", "not-installed", "not-authenticated", "disabled"]).toContain(off.reason);
    });

    test("start validates the request strictly (no smuggled keys, bounds enforced)", async () => {
      const a = await h.create("ok");
      const sink = () => undefined;
      for (const bad of [
        { ...request(), apiKey: "sk-x" }, { ...request(), baseUrl: "https://api.openai.com" }, { ...request(), billingMode: "metered" },
        { ...request(), role: "hacker" }, { ...request(), maxWallTimeSec: 0 }, { ...request(), attempt: 0 }, { ...request(), requestId: "" },
        { ...request(), subscriptionUsageGuard: { stopWhenRateLimited: false } },
      ]) await expect(a.start(bad as unknown as AgentRunRequest, sink)).rejects.toThrow();
    });

    test("normalized event stream: gap-free sequence, schema-valid, started first, exactly one terminal and it is last", async () => {
      const { events, result } = await runToEnd(await h.create("ok"), request());
      expect(result.exitStatus).toBe("succeeded");
      expect(events.length).toBeGreaterThanOrEqual(2);
      events.forEach((e, i) => { expect(AgentEventSchema.safeParse(e).success).toBe(true); expect(e.sequence).toBe(i + 1); });
      expect(events[0]?.type).toBe("agent.started");
      expect(events.filter((e) => TERMINAL.includes(e.type)).length).toBe(1);
      expect(TERMINAL.includes(events.at(-1)?.type ?? "")).toBe(true);
      expect(events.at(-1)?.type).toBe("agent.completed");
    });

    test("result satisfies CONTRACTS/agent-result.schema.json, uses only allowed billing modes, and carries no price/credential fields", async () => {
      const { result } = await runToEnd(await h.create("ok"), request());
      expect(validateAgentResult(toWireResult(result)).errors).toEqual([]);
      expect(["subscription_included", "local_compute"]).toContain(result.inferenceBillingMode);
      expect(JSON.stringify(result)).not.toMatch(/usd|dollar|cost|price|invoice|api_?key|bearer/i);
    });

    test("review roles return schema-valid output bound to the requested candidate SHA", async () => {
      const sha = "c".repeat(40);
      const { result } = await runToEnd(await h.create("ok"), request({ role: "review_code", candidateSha: sha }));
      expect(result.exitStatus).toBe("succeeded");
      expect(result.output).toMatchObject({ reviewerRole: "code", candidateSha: sha, verdict: "pass" });
    });

    test("invalid structured output can never succeed (schema error / wrong SHA)", async () => {
      const bad = await runToEnd(await h.create("bad_output"), request());
      expect(bad.result.exitStatus).toBe("failed");
      expect(bad.result.failureCode).toMatch(/^output-(schema|not-json)$/);
      expect(bad.events.at(-1)?.type).toBe("agent.failed");
      const wrong = await runToEnd(await h.create("wrong_sha"), request({ role: "review_security", candidateSha: "a".repeat(40) }));
      expect(wrong.result).toMatchObject({ exitStatus: "failed", failureCode: "output-sha-mismatch" });
    });

    test("failures are reported as failed with a code", async () => {
      const { result, events } = await runToEnd(await h.create("fail"), request());
      expect(result.exitStatus).toBe("failed");
      expect(result.failureCode).toBeTruthy();
      expect(events.at(-1)?.type).toBe("agent.failed");
    });

    test("rate limiting stops the run; it never switches billing mode or falls back to a paid source", async () => {
      const { result, events } = await runToEnd(await h.create("rate_limited"), request());
      expect(result).toMatchObject({ exitStatus: "failed", failureCode: "rate-limited" });
      expect(events.some((e) => e.type === "agent.rate_limited")).toBe(true);
      expect(["subscription_included", "local_compute"]).toContain(result.inferenceBillingMode);
    });

    test("status is running while in flight; cancel is prompt, idempotent, safe for unknown runs, and no events follow the terminal one", async () => {
      const a = await h.create("slow");
      const events: AgentEvent[] = [];
      const runId = await a.start(request(), (e) => { events.push(e); });
      expect(await a.status(runId)).toEqual({ exitStatus: "running" });
      await Promise.all([a.cancel(runId), a.cancel(runId)]);
      await a.cancel("run_does_not_exist");
      const s = await a.status(runId);
      expect(s.exitStatus).toBe("cancelled");
      expect(events.at(-1)?.type).toBe("agent.cancelled");
      const n = events.length;
      await new Promise((r) => setTimeout(r, 50));
      expect(events.length).toBe(n);
      expect(events.filter((e) => TERMINAL.includes(e.type)).length).toBe(1);
    });

    test("wall-time limit yields timed_out", async () => {
      const { result, events } = await runToEnd(await h.create("slow"), request({ maxWallTimeSec: 1 }));
      expect(result.exitStatus).toBe("timed_out");
      expect(events.at(-1)?.type).toBe("agent.timed_out");
    });

    test("start is idempotent on requestId (one run, one event stream)", async () => {
      const a = await h.create("ok");
      const events: AgentEvent[] = [];
      const req = request();
      const r1 = await a.start(req, (e) => { events.push(e); });
      const r2 = await a.start(req, (e) => { events.push(e); });
      expect(r2).toBe(r1);
      for (let i = 0; i < 200 && (await a.status(r1)).exitStatus === "running"; i++) await new Promise((r) => setTimeout(r, 10));
      expect(events.filter((e) => e.type === "agent.started").length).toBe(1);
    });

    test("concurrent runs are isolated from each other", async () => {
      const a = await h.create("ok");
      const [x, y] = await Promise.all([runToEnd(a, request({ jobId: "job_x" })), runToEnd(a, request({ jobId: "job_y" }))]);
      expect(x.runId).not.toBe(y.runId);
      expect(x.events.every((e) => e.job_id === "job_x" && e.run_id === x.runId)).toBe(true);
      expect(y.events.every((e) => e.job_id === "job_y" && e.run_id === y.runId)).toBe(true);
      expect(x.events[0]?.sequence).toBe(1);
      expect(y.events[0]?.sequence).toBe(1);
    });

    test("a model API key in the environment refuses the run before anything executes", async () => {
      const a = await h.createWithForbiddenEnv();
      const events: AgentEvent[] = [];
      await expect(a.start(request(), (e) => { events.push(e); })).rejects.toBeInstanceOf(PolicyViolation);
      expect(events).toEqual([]);
    });
  });
}
