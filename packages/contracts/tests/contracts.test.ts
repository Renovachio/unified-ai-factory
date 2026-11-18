import { describe, expect, test } from "bun:test";
import { validateAgentResult, validateCreateJob, validateEvent, validateJobResponse, validatePolicy, validateReview } from "../src/index";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sha = "a".repeat(40);
describe("contract validators (CONTRACTS/*.schema.json)", () => {
  test("create job", () => {
    expect(validateCreateJob({ repositoryId: "r", request: { type: "feature", title: "t", description: "d" } }).ok).toBe(true);
    expect(validateCreateJob({ repositoryId: "r", request: { type: "feature", title: "t", description: "d" }, extra: 1 }).ok).toBe(false);
    expect(validateCreateJob({ repositoryId: "r", request: { type: "nope", title: "t", description: "d" } }).ok).toBe(false);
    expect(validateCreateJob({ repositoryId: "r", request: { type: "bug", title: "x".repeat(251), description: "d" } }).ok).toBe(false);
  });
  test("job response", () => {
    expect(validateJobResponse({ jobId: "j", state: "QUEUED", version: 1 }).ok).toBe(true);
    expect(validateJobResponse({ jobId: "j", state: "QUEUED", version: 0 }).ok).toBe(false);
  });
  test("event", () => {
    const e = { schema_version: "1.0", event_id: "e", job_id: "j", attempt: 1, fencing_token: 0, sequence: 1, timestamp: "2026-11-18T20:00:00Z", type: "t", payload: {} };
    expect(validateEvent(e).ok).toBe(true);
    expect(validateEvent({ ...e, timestamp: "yesterday" }).ok).toBe(false);
  });
  test("review requires 40-hex sha and known verdict", () => {
    expect(validateReview({ reviewerRole: "code", candidateSha: sha, verdict: "pass", findings: [] }).ok).toBe(true);
    expect(validateReview({ reviewerRole: "code", candidateSha: "abc", verdict: "pass", findings: [] }).ok).toBe(false);
    expect(validateReview({ reviewerRole: "code", candidateSha: sha, verdict: "approved", findings: [] }).ok).toBe(false);
  });
  test("agent result has no payment mode other than subscription/local", () => {
    const r = { runId: "r", exitStatus: "succeeded", usageSource: "unavailable", inferenceBillingMode: "local_compute" };
    expect(validateAgentResult(r).ok).toBe(true);
    expect(validateAgentResult({ ...r, inferenceBillingMode: "api_metered" }).ok).toBe(false);
  });
  test("policy schema pins safe values and equals config/inference-policy.json", () => {
    const cfg = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/inference-policy.json"), "utf8"));
    expect(validatePolicy(cfg).ok).toBe(true);
    expect(validatePolicy({ ...cfg, modelApiBillingEnabled: true }).ok).toBe(false);
    expect(validatePolicy({ ...cfg, autoMergeHighRisk: true }).ok).toBe(false);
    expect(validatePolicy({ ...cfg, allowedInferenceModes: ["api_key"] }).ok).toBe(false);
  });
});
