import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import agentResult from "../../../CONTRACTS/agent-result.schema.json" with { type: "json" };
import event from "../../../CONTRACTS/event.schema.json" with { type: "json" };
import jobCreate from "../../../CONTRACTS/job-create.schema.json" with { type: "json" };
import jobResponse from "../../../CONTRACTS/job-response.schema.json" with { type: "json" };
import policy from "../../../CONTRACTS/policy.schema.json" with { type: "json" };
import review from "../../../CONTRACTS/review.schema.json" with { type: "json" };

export const schemas = { agentResult, event, jobCreate, jobResponse, policy, review } as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

export interface Validated<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

function make<T>(schema: object) {
  const v = ajv.compile(schema);
  return (input: unknown): Validated<T> => {
    if (v(input)) return { ok: true, value: input as T, errors: [] };
    return { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`) };
  };
}

export interface CreateJobRequest {
  repositoryId: string;
  request: { type: "feature" | "bug" | "maintenance" | "research"; title: string; description: string; sourceId?: string };
  priority?: "low" | "normal" | "high";
}
export interface CreateJobResponse { jobId: string; state: string; version: number }
export interface FactoryEvent {
  schema_version: "1.0";
  event_id: string;
  job_id: string;
  attempt: number;
  fencing_token: number;
  sequence: number;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}
export interface ReviewerResult {
  reviewerRole: "code" | "security" | "ux" | "ui" | "performance";
  candidateSha: string;
  verdict: "pass" | "changes_requested" | "blocked";
  findings: Array<{ severity: "low" | "medium" | "high" | "critical"; summary: string; location?: string; remediation?: string }>;
}
export interface AgentRunResultContract {
  runId: string;
  exitStatus: "succeeded" | "failed" | "timed_out" | "cancelled";
  candidateSha?: string;
  artifactUri?: string;
  usage?: { inputTokens?: number; outputTokens?: number; computeSeconds?: number };
  usageSource: "cli_reported" | "local_runtime" | "estimated" | "unavailable";
  inferenceBillingMode: "subscription_included" | "local_compute";
}

export const validateCreateJob = make<CreateJobRequest>(jobCreate);
export const validateJobResponse = make<CreateJobResponse>(jobResponse);
export const validateEvent = make<FactoryEvent>(event);
export const validateReview = make<ReviewerResult>(review);
export const validateAgentResult = make<AgentRunResultContract>(agentResult);
export const validatePolicy = make<Record<string, unknown>>(policy);
