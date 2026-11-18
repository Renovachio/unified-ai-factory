import { bigint, boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  settingsVersion: integer("settings_version").notNull().default(1),
  createdAt: created(),
});

export const users = pgTable("users", {
  id: id(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  authSubject: text("auth_subject").notNull(),
  role: text("role").notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: created(),
});

export const repositories = pgTable("repositories", {
  id: id(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  baseBranch: text("base_branch").notNull().default("main"),
  policyId: text("policy_id"),
  installationId: text("installation_id"),
  createdAt: created(),
});

export const integrations = pgTable("integrations", {
  id: id(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  credentialsRef: text("credentials_ref"),
  config: jsonb("config").notNull().default({}),
  createdAt: created(),
});

export const requests = pgTable("requests", {
  id: id(),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  source: text("source").notNull(),
  sourceExternalId: text("source_external_id"),
  payloadDigest: text("payload_digest").notNull(),
  state: text("state").notNull().default("RECEIVED"),
  requesterId: uuid("requester_id").references(() => users.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  createdAt: created(),
});

export const jobs = pgTable("jobs", {
  id: id(),
  requestId: uuid("request_id").notNull().unique().references(() => requests.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  state: text("state").notNull().default("QUEUED"),
  version: integer("version").notNull().default(1),
  risk: text("risk").notNull().default("CRITICAL"),
  priority: text("priority").notNull().default("normal"),
  policyDigest: text("policy_digest"),
  specDigest: text("spec_digest"),
  baseSha: text("base_sha"),
  headSha: text("head_sha"),
  prNumber: integer("pr_number"),
  currentRound: integer("current_round").notNull().default(0),
  maxRounds: integer("max_rounds").notNull().default(3),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  pauseReason: text("pause_reason"),
  createdBy: uuid("created_by").references(() => users.id),
  lastErrorCode: text("last_error_code"),
  eventSeq: bigint("event_seq", { mode: "number" }).notNull().default(0),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const allowedTransitions = pgTable("allowed_transitions", {
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
});

export const jobTransitions = pgTable("job_transitions", {
  id: id(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  version: integer("version").notNull(),
  actorId: text("actor_id").notNull(),
  evidenceDigest: text("evidence_digest"),
  createdAt: created(),
});

export const workers = pgTable("workers", {
  id: id(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  mode: text("mode").notNull(),
  capabilityJson: jsonb("capability_json").notNull().default({}),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  status: text("status").notNull().default("active"),
  attestation: jsonb("attestation"),
  createdAt: created(),
});

export const tasks = pgTable("tasks", {
  id: id(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  stage: text("stage").notNull(),
  role: text("role").notNull(),
  status: text("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(1),
  leaseOwner: uuid("lease_owner").references(() => workers.id),
  leaseExpiry: timestamp("lease_expiry", { withTimezone: true }),
  fencingToken: bigint("fencing_token", { mode: "number" }).notNull().default(0),
  assignedWorkerId: uuid("assigned_worker_id").references(() => workers.id),
  worktreeRef: text("worktree_ref"),
  runtimeId: text("runtime_id"),
  modelId: text("model_id"),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull().defaultNow(),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentRuns = pgTable("agent_runs", {
  id: id(),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  runtimeId: text("runtime_id").notNull(),
  modelId: text("model_id").notNull(),
  promptDigest: text("prompt_digest").notNull(),
  contextDigest: text("context_digest").notNull(),
  status: text("status").notNull(),
  authMode: text("auth_mode").notNull(),
  inferenceBillingMode: text("inference_billing_mode").notNull(),
  tokenInput: bigint("token_input", { mode: "number" }),
  tokenOutput: bigint("token_output", { mode: "number" }),
  computeSeconds: doublePrecision("compute_seconds"),
  usageSource: text("usage_source").notNull(),
  createdAt: created(),
});

export const artifacts = pgTable("artifacts", {
  id: id(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  runId: uuid("run_id").references(() => agentRuns.id),
  kind: text("kind").notNull(),
  digest: text("digest").notNull(),
  storageUri: text("storage_uri").notNull(),
  byteLength: bigint("byte_length", { mode: "number" }).notNull(),
  redactionStatus: text("redaction_status").notNull().default("pending"),
  createdAt: created(),
});

export const gateResults = pgTable("gate_results", {
  id: id(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  headSha: text("head_sha").notNull(),
  baseSha: text("base_sha").notNull(),
  gateConfigDigest: text("gate_config_digest").notNull(),
  verdict: text("verdict").notNull(),
  resultsDigest: text("results_digest").notNull(),
  createdAt: created(),
});

export const reviewResults = pgTable("review_results", {
  id: id(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  headSha: text("head_sha").notNull(),
  reviewerRole: text("reviewer_role").notNull(),
  reviewerRunId: uuid("reviewer_run_id").references(() => agentRuns.id),
  verdict: text("verdict").notNull(),
  findingsDigest: text("findings_digest").notNull(),
  createdAt: created(),
});

export const policyDecisions = pgTable("policy_decisions", {
  id: id(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  headSha: text("head_sha").notNull(),
  policyDigest: text("policy_digest").notNull(),
  risk: text("risk").notNull(),
  eligible: boolean("eligible").notNull(),
  reasons: jsonb("reasons").notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: created(),
});

export const approvals = pgTable("approvals", {
  id: id(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  headSha: text("head_sha").notNull(),
  baseSha: text("base_sha").notNull(),
  policyDigest: text("policy_digest").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  decision: text("decision").notNull(),
  reason: text("reason"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: created(),
});

export const mergeIntents = pgTable("merge_intents", {
  id: id(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  prNumber: integer("pr_number").notNull(),
  headSha: text("head_sha").notNull(),
  status: text("status").notNull().default("pending"),
  githubMergeSha: text("github_merge_sha"),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable("events", {
  id: id(),
  globalSeq: bigint("global_seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  type: text("type").notNull(),
  source: text("source").notNull(),
  actorId: text("actor_id"),
  payloadRedacted: jsonb("payload_redacted").notNull().default({}),
  digest: text("digest").notNull(),
  createdAt: created(),
});

export const outbox = pgTable("outbox", {
  id: id(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  destination: text("destination").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  createdAt: created(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: id(),
  provider: text("provider").notNull(),
  deliveryId: text("delivery_id").notNull(),
  signatureValid: boolean("signature_valid").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export const auditEntries = pgTable("audit_entries", {
  id: id(),
  organizationId: uuid("organization_id").references(() => organizations.id),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  result: text("result").notNull(),
  reason: text("reason"),
  digest: text("digest").notNull(),
  createdAt: created(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: id(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  route: text("route").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  jobId: uuid("job_id").references(() => jobs.id),
  createdAt: created(),
});
