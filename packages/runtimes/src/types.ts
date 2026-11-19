import { z } from "zod";

export const AGENT_ROLES = [
  "intake", "analyst", "architect", "spec", "builder", "tester",
  "review_code", "review_security", "review_ux", "review_ui", "review_performance", "approver_adviser",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const REVIEW_ROLES = ["review_code", "review_security", "review_ux", "review_ui", "review_performance"] as const;
export const isReviewRole = (r: AgentRole): boolean => (REVIEW_ROLES as readonly string[]).includes(r);

export const AuthMode = z.enum(["subscription_cli", "local_model"]);
export type AuthMode = z.infer<typeof AuthMode>;

/** Strict (unknown keys rejected): there is no field through which an API key, base URL or billing mode can be smuggled in. */
export const AgentRunRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  jobId: z.string().min(1).max(200),
  attempt: z.number().int().min(1),
  role: z.enum(AGENT_ROLES),
  modelId: z.string().min(1).max(200),
  promptVersion: z.string().min(1).max(100),
  immutableContextManifestUri: z.string().min(1).max(2000),
  workspaceUri: z.string().max(2000).optional(),
  allowedTools: z.array(z.string().min(1).max(100)).max(64),
  maxWallTimeSec: z.number().int().min(1).max(6 * 3600),
  maxOutputBytes: z.number().int().min(1).max(50_000_000),
  maxComputeSeconds: z.number().positive().optional(),
  maxEstimatedTokens: z.number().int().positive().optional(),
  subscriptionUsageGuard: z.strictObject({ maxJobsPerPeriod: z.number().int().positive().optional(), stopWhenRateLimited: z.literal(true) }).optional(),
  outputSchemaUri: z.string().min(1).max(2000),
  /** Expected candidate SHA for review roles; review output must be bound to it. */
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export interface RuntimeCapabilities {
  structuredOutput: boolean;
  shell: boolean;
  toolAllowlist: boolean;
  resume: boolean;
  tokenTelemetry: boolean;
  authMode: AuthMode;
  sandboxModes: Array<"local" | "cloud">;
}

export type ProbeResult =
  | { available: true; adapterId: string; version?: string; capabilities: RuntimeCapabilities }
  | { available: false; adapterId: string; reason: ProbeFailure; detail: string };

export type ProbeFailure =
  | "not-installed" | "version-unsupported" | "not-authenticated" | "terms-not-approved"
  | "policy-violation" | "rate-limited" | "offline" | "disabled";

export const EVENT_TYPES = ["agent.started", "agent.progress", "agent.artifact", "agent.rate_limited", "agent.completed", "agent.failed", "agent.cancelled", "agent.timed_out"] as const;
export type AgentEventType = (typeof EVENT_TYPES)[number];
export type TerminalType = "agent.completed" | "agent.failed" | "agent.cancelled" | "agent.timed_out";
export const TERMINAL_EVENTS: readonly AgentEventType[] = ["agent.completed", "agent.failed", "agent.cancelled", "agent.timed_out"];

export const AgentEventSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  run_id: z.string().min(1),
  job_id: z.string().min(1),
  attempt: z.number().int().min(1),
  sequence: z.number().int().min(1),
  timestamp: z.iso.datetime(),
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export type ExitStatus = "succeeded" | "failed" | "timed_out" | "cancelled";
export interface AgentRunResult {
  runId: string;
  exitStatus: ExitStatus;
  artifactUri?: string;
  candidateSha?: string;
  usage?: { inputTokens?: number; outputTokens?: number; computeSeconds?: number };
  usageSource: "cli_reported" | "local_runtime" | "estimated" | "unavailable";
  inferenceBillingMode: "subscription_included" | "local_compute";
  /** Structured, schema-validated role output (never the raw model text). */
  output?: unknown;
  failureCode?: string;
}

/** The subset persisted/exchanged under CONTRACTS/agent-result.schema.json (additionalProperties: false). */
export function toWireResult(r: AgentRunResult): Record<string, unknown> {
  return {
    runId: r.runId, exitStatus: r.exitStatus, usageSource: r.usageSource, inferenceBillingMode: r.inferenceBillingMode,
    ...(r.artifactUri !== undefined ? { artifactUri: r.artifactUri } : {}),
    ...(r.candidateSha !== undefined ? { candidateSha: r.candidateSha } : {}),
    ...(r.usage !== undefined ? { usage: r.usage } : {}),
  };
}

export type EventSink = (event: AgentEvent) => Promise<void> | void;

export interface AgentRuntimeAdapter {
  readonly id: string;
  probe(): Promise<ProbeResult>;
  /** Starts a run (idempotent on requestId) and returns its runId immediately. */
  start(request: AgentRunRequest, events: EventSink): Promise<string>;
  status(runId: string): Promise<AgentRunResult | { exitStatus: "running" }>;
  /** Idempotent. Resolves once the run is no longer executing. Unknown runs are a no-op. */
  cancel(runId: string): Promise<void>;
  resume?(runId: string, checkpointUri: string): Promise<string>;
}

/** Emits events with a gap-free, monotonic per-run sequence and validates every envelope. */
export class EventSequencer {
  private seq = 0;
  private closed = false;
  constructor(private readonly base: { runId: string; jobId: string; attempt: number }, private readonly sink: EventSink, private readonly now: () => Date = () => new Date()) {}
  get terminal(): boolean { return this.closed; }
  async emit(type: AgentEventType, payload: Record<string, unknown> = {}): Promise<void> {
    if (this.closed) return; // nothing may follow a terminal event
    const event: AgentEvent = AgentEventSchema.parse({
      schema_version: "1.0", run_id: this.base.runId, job_id: this.base.jobId, attempt: this.base.attempt,
      sequence: ++this.seq, timestamp: this.now().toISOString(), type, payload,
    });
    if ((TERMINAL_EVENTS as readonly string[]).includes(type)) this.closed = true;
    await this.sink(event);
  }
}
