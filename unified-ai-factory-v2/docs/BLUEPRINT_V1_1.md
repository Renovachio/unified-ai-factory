# Unified AI Software Factory — Implementation-Ready Engineering Blueprint

**Version:** 1.1  
**Date:** 2026-11-18  
**Status:** Proposed architecture; not an implementation  
**Decisions:** Marshal-inspired foundation; multi-model/harness runtime; hybrid local-first execution; risk-based merging; **subscription-backed CLI or local models only, with no paid model API billing or fallback.**

## 0. Source provenance and licensing decisions

**References reviewed (public documentation, not a source-level audit):**
- Marshal Factory: https://github.com/ski043/marshal-factory — README describes Next.js/Vercel panel, Neon PostgreSQL/realtime, Bun/launchd Mac runner, Linear/GitHub/Slack, T3 Code + PStack, optional Modal workers, live reporting, and gated PR merge.
- Zazen v1: https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code — seven agents, specs, independent review rounds, worktrees, local dashboard.
- Zazen v2: https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code-v2 — eight agent roles including intake; job/gate/route deterministic scripts; risk-routed parallel reviews; GitHub issue queue; PR merging; persistent local job artifacts.
- Zazen v2 design: https://github.com/zazencodes/zazencodes-season-3/blob/main/src/software-factory-claude-code-v2/DESIGN.md
- Marshal README: https://github.com/ski043/marshal-factory/blob/main/README.md

**Licensing decisions (must be revalidated against pinned upstream commits):**
1. Marshal's public repository root did not show an identifiable license in the review. Treat **all Marshal code as all-rights-reserved until verified**. A `private: true` package.json does not establish a code license. Do not copy, fork for integration, modify, import, or redistribute its source without confirming appropriate rights. Even internal use does not substitute for authorization to reproduce code.
2. Zazen v2 documentation identifies GPLv3 with commercial licensing offered. GPLv3 may permit use and modification, including private use, subject to its terms; obligations on conveying/distribution and compatibility need legal review. Do not assume GPLv3 code can be merged into a proprietary distributed application without corresponding obligations or a separate license. Zazen v1 documentation says v1 was originally unlicensed; do not infer its permissions from v2. Check exact file-specific licenses and commits.
3. **Safe baseline:** create an original implementation from functional requirements, public behavior, and common architectural patterns; do not import code, scripts, prose prompts, UI assets, test fixtures, or nontrivial translations from either project until cleared.
4. Maintain `docs/third-party/PROVENANCE.md` and SPDX/license manifest for every adopted component. In the event rights are later cleared, approve incorporation per path and pinned SHA, not blanket repository permission.
5. Keep review of external projects as factual requirements and interoperability notes; implementation team should write original algorithms, prompts, and tests. Legal counsel determines whether a particular proposed use is permissible; this blueprint is not legal advice.
6. Dependencies (including T3, PStack, Modal, Vercel, Neon, agent CLIs) need independent license, terms-of-service, data-processing, and commercial-use checks. For subscription-authenticated model CLIs specifically, verify that the provider authorizes the intended automation and third-party orchestration; having a subscription is not sufficient evidence of such permission. Do not interpret an upstream example as permission to sublicense their technologies.

### Executable go/no-go gate LIC-001
- `licenses/allowlist.yaml` tracks package, version/commit, license, approval, allowed modes, and attribution obligations.
- CI rejects source copied from either repository without an approval record; checks detect suspicious upstream file paths/names and fingerprint matches where practical, supplemented by human review.
- No upstream git submodules, vendored code, or copied agent prompts until legal approval.
- Architecture and independently authored code may advance under the original implementation path.

## 1. Goals and boundaries

### Outcomes
- Turn GitHub/Linear/API feature and bug requests into well-scoped PRs, with inspectable specs, tests, reviews and immutable evidence.
- Run different coding harnesses under one scheduler and one persistent state machine.
- Support local macOS development and remote container/sandbox execution with equivalent policy semantics.
- Survive process crashes, API outages, restart, expired credentials, and duplicate webhooks without double merges or lost work.
- Permit gradual autonomy after empirical validation; start with manual human approval for every merge.

### Non-goals for v1
- Arbitrary production deployment, infrastructure provisioning or database migrations under autonomous agent authority.
- Fully autonomous software product management with unconstrained scope or recursive agents.
- Guaranteed correct code based on LLM review or confidence scores.
- Automatic use of all available local/cloud credentials inside arbitrary source repositories.
- Any paid model inference API, pay-as-you-go model endpoint, token-priced inference, API credential exchange, or automatic switch from subscriptions/local models to paid inference.
- Integrating upstream source by copying repositories.

### Hard invariants
1. Only an authenticated, authorized actor may enqueue work; a user-controlled `factory` label alone is not a sufficient trust boundary.
2. Orchestrator/DB transaction is the sole writer of workflow state; agents can only return schema-validated artifacts and proposed decisions.
3. No merge without exact-head deterministic checks, mandatory reviewers, branch-protection compliance, and merge policy authorization.
4. Any commit, base-branch movement, review policy change or gate configuration change invalidates the associated stale approvals/evidence.
5. Untrusted repository text, issues, tool output and web content are data, never policy-authoritative instructions.
6. Untrusted agent runtime lacks privileged merge, credential-management, policy-edit and production-deploy permissions.
7. Each execution has a lease, fencing token and auditable agent/harness identity; late events cannot mutate newer attempts.
8. Cancellation is idempotent and revokes execution capabilities before final cleanup.
9. Jobs do not share writable directories, shell sessions or unrestricted host resources.
10. All irreversible or high-impact operations require explicit, narrowly scoped human approval.
11. Model inference sources are restricted to **allowed subscription-backed official CLI sessions** or **self-hosted local models**; model API keys, paid inference endpoints and usage-based inference billing are forbidden. Any disallowed or unavailable runtime causes a block, never a paid fallback.
12. Subscription CLI automation must be independently permitted by the provider terms for the exact use case; if uncertain or prohibited, block that adapter and use a local model or require operator action. Do not automate login, extract cookies or tokens, or proxy a subscription credential into an unofficial API.

## 2. Technology and repository layout

### Target stack
- TypeScript 5.x, Bun (pinned compatible release), monorepo with workspaces; strict TS validation.
- Next.js (pinned compatible release) + React frontend, server-side session checks.
- PostgreSQL 16+ with Drizzle and transactionally enforced state transitions.
- Redis not required for initial delivery; Postgres transactional outbox, `FOR UPDATE SKIP LOCKED` claim queue, advisory locks or row leases suffice initially.
- GitHub App for installation-scoped code access; Linear OAuth/webhook integration optional; Slack notifications optional.
- OpenTelemetry traces/metrics; structured JSON logs; S3-compatible encrypted artifact store (local filesystem adapter for development).
- Native sandbox abstraction: local job runner via macOS-controlled subprocess and isolated macOS account or container VM; optional cloud adapter (Modal or equivalent) only after security parity testing.
- Runtime adapters: `ClaudeCodeSubscriptionCliAdapter` (only where authorized by provider terms), `CodexSubscriptionCliAdapter` (only where authorized), `LocalModelAdapter`, and `MockAdapter`. `T3Adapter` is optional only if it enforces the same subscription/local-only policy; it must never create a provider API billing path.

### Repo structure
```text
factory/
  apps/
    web/                    # dashboard, auth, inbox, job/PR views
    api/                    # HTTP endpoints, webhooks, event stream
    runner/                 # local/remote worker daemon
  packages/
    contracts/              # zod schemas, OpenAPI types, event definitions
    domain/                 # state machine, policies, risk/routing rules
    db/                     # schema, migrations, transactions, outbox
    scheduler/              # fair claims, leases, retry budgets
    agents/                 # role definitions, prompt templates, parsers
    runtimes/               # Claude, Codex, mock, optional T3 adapters
    sandboxes/              # workspace, cloud, local isolation adapters
    checks/                 # gate runner + immutable evidence
    scm/                    # GitHub App, PR, status, merge coordinator
    intake/                 # GitHub/Linear/manual adapters
    secrets/                # broker, ephemeral credentials
    telemetry/              # event redaction, metrics, audit
    ui/                     # shared design system
  config/
    default.yaml
    risk-policy.yaml
    model-routing.yaml
    checks.schema.json
  migrations/
  prompts/
    intake.md spec.md architect.md builder.md test.md code-review.md
    security-review.md ux-review.md ui-review.md approver.md
  tests/
    contract/ unit/ integration/ e2e/ adversarial/ fault/
  docs/
    adr/ runbooks/ security/ api/ third-party/ operator/
  .github/workflows/
  README.md
```

**Configuration ownership:** policy/model routing/check definitions are committed and versioned in *factory control repository*, not writable by coding agents in target repositories. Target project can publish a checks manifest, but the factory pins and allowlists commands and protects the manifest from agent changes.

## 3. Component contracts and responsibility boundaries

| Component | Responsibilities | Allowed state writes | Trust boundary |
|---|---|---|---|
| Dashboard | job creation, status, reviews, approvals, budget controls | HTTP APIs only | user session/OIDC; RBAC |
| API | authentication, authorization, validation, idempotency | transactional domain services | untrusted clients/webhooks |
| Intake connector | pull issues, comments; deduplicate events | ingress journal only | provider signatures and installation scope |
| Orchestrator | durable workflow, transitions, retry counts, scheduling | jobs, transitions, decisions via DB | only privileged state authority |
| Scheduler | fair queue, leases, worker assignments, concurrency | task lease records | worker-to-server auth |
| Agent dispatcher | role prompts, context scopes, harness calls | artifacts, proposed results only | source text and model output untrusted |
| Runner | checkout, spawn isolated harness, execute authorized commands | signed execution events only | confined workspace, no merge token |
| Gate engine | deterministic checks, independent evidence | immutable verification artifacts | locked checks configuration |
| Review engine | reviewer routing, parallel reviews, aggregation | findings and review outcomes | no self-approval by builder |
| Policy engine | risk classification, merge eligibility | policy decisions | policy file signed/pinned |
| SCM/Merge service | PR creation, exact-head merge decision, post-merge health | PR/merge ledger | standalone GitHub App permissions |
| Artifact store | immutable logs, specs, test reports, manifests | content-addressed artifacts | encrypt, redact, limit retention |
| Secret broker | issue short-lived scoped credentials | access audit | never pass secrets through prompts |

**Separation of duties:** the runner's GitHub credential can push only a constrained factory branch (via GitHub App permissions and server mediation when feasible); it must not possess a merge privilege. The merge service uses a separate installation-scoped credential. GitHub permission granularity may not enforce branch-prefix writes by token alone; use branch rulesets, limited installations, server mediation and repository protections, not just a textual branch name convention.

## 4. Agent roles and artifacts

Each role receives a pinned context manifest, scope, subscription-usage or local compute limit, timeout, allowed tools, strict schema and expected artifact location. Agent results are **proposals**, parsed and checked by the orchestrator. All prompts and policies are versioned and hashed per run.

| Role | Inputs | Output artifact | Tools | Gate/exit |
|---|---|---|---|---|
| Intake | trusted request metadata + untrusted issue text | `intake.json`: accept/needs_info/reject, risk hints, uncertainties | read-only metadata, no shell | authorized issue and bounded scope |
| Analyst | accepted request, repository snapshot | `requirements.md` + traceable AC IDs | read-only repo | each AC observable and testable |
| Architect | requirements, repo map, constraints | `design.md`, files affected, threat notes | read-only repo, optional documentation | no prohibited scope or architecture changes |
| Spec writer | requirements + design | `spec.md`, `tasks.json`, test strategy | read-only | completeness checklist; human question if blocked |
| Builder | spec, isolated worktree, feedback | changes, commits, `build.json` | bounded shell + repo write | only allowed paths, commit on job branch |
| Test engineer | spec, diff, test surfaces | test additions, `test-plan.json` | scoped repo write in a separate stage | tests trace to AC IDs; no weakening guards |
| Code reviewer | immutable candidate SHA + spec + diff | `review-code.json` | read-only source/diff | structured findings, PASS/CHANGES |
| Security reviewer | trust/data/security surfaces | `review-security.json` | read-only, scanners | no unmitigated high/critical findings |
| UX reviewer | user journeys, screenshots, interaction tests | `review-ux.json` | browser read-only sandbox | relevant UX checks pass |
| UI reviewer | screenshots, design tokens, visual diffs | `review-ui.json` | read-only browser/artifacts | visual and a11y checks pass |
| Performance reviewer | profiling evidence + budget | `review-performance.json` | read-only metrics | required when impact warrants |
| Approver adviser | signed validation matrix, risk, findings | `recommendation.json` | read-only | recommendation is NOT authorization |
| Release observer | merged SHA + CI outcomes | `postmerge.json` | read-only GitHub | detects failure; escalates remediation |

**Agent isolation:** reviewer runtimes should use a different agent session, preferably different credential and no writable access to builder worktree. Independent reviewer model families can be evaluated for additional coverage, but independence is primarily achieved through access boundaries and uneditable evidence.

**Artifact schema example:**
```json
{
  "schema_version": "1.0",
  "job_id": "job_01JABC",
  "role": "code_reviewer",
  "attempt": 2,
  "candidate_sha": "40-char-git-oid",
  "verdict": "CHANGES",
  "findings": [{
    "id": "F-001", "severity": "high", "file": "src/api.ts",
    "line": 22, "rule": "input-validation", "explanation": "...",
    "required_action": "Validate user input before persistence"
  }],
  "artifact_digest": "sha256:..."
}
```
The digest is computed by the trusted ingestion service from the saved payload; any agent-supplied digest is untrusted.

## 5. Workflow state machine

### States
`QUEUED`, `INTAKE`, `NEEDS_INFO`, `SPECIFYING`, `READY`, `PROVISIONING`, `BUILDING`, `GATING`, `REVIEWING`, `REWORK`, `PREMERGE`, `AWAITING_HUMAN`, `MERGING`, `MERGED`, `POSTMERGE_MONITOR`, `DONE`, `REJECTED`, `CANCELLED`, `FAILED`, `QUARANTINED`.

`PAUSED` is not an independent terminal state: use `paused_at` and `pause_reason`, with no active lease, and preserve the underlying resumable state. `FAILED` and `QUARANTINED` require explicit recovery actions; neither can auto-merge.

### Legal transitions
```text
QUEUED           -> INTAKE, CANCELLED
INTAKE           -> NEEDS_INFO, SPECIFYING, REJECTED, FAILED, CANCELLED
NEEDS_INFO       -> INTAKE, CANCELLED, REJECTED
SPECIFYING       -> READY, NEEDS_INFO, FAILED, CANCELLED
READY            -> PROVISIONING, CANCELLED
PROVISIONING     -> BUILDING, FAILED, QUARANTINED, CANCELLED
BUILDING         -> GATING, REWORK, FAILED, QUARANTINED, CANCELLED
GATING           -> REVIEWING, REWORK, FAILED, QUARANTINED, CANCELLED
REVIEWING        -> PREMERGE, REWORK, FAILED, QUARANTINED, CANCELLED
REWORK           -> BUILDING, AWAITING_HUMAN, FAILED, CANCELLED
PREMERGE         -> AWAITING_HUMAN, MERGING, REWORK, FAILED, QUARANTINED, CANCELLED
AWAITING_HUMAN   -> PREMERGE, REWORK, REJECTED, CANCELLED
MERGING          -> MERGED, PREMERGE, FAILED, QUARANTINED
MERGED           -> POSTMERGE_MONITOR
POSTMERGE_MONITOR -> DONE, FAILED
FAILED           -> QUEUED, REWORK, CANCELLED (authorized recovery only)
QUARANTINED      -> CANCELLED, FAILED (security officer/operator only)
```

### Transition transaction pseudocode
```ts
async function transition(jobId: string, expectedVersion: number, next: JobState, actor: Actor, evidence: EvidenceRef[]) {
  return db.transaction(async (tx) => {
    const job = await tx.jobs.lockForUpdate(jobId);
    if (job.version !== expectedVersion) throw new ConflictError();
    authorize(actor, job, next);
    assertAllowedTransition(job.state, next);
    assertGuards(job, next, evidence);
    await tx.jobs.update(jobId, { state: next, version: expectedVersion + 1 });
    await tx.events.insert({ jobId, type: "job.transitioned", actor, from: job.state, to: next, evidence });
    await tx.outbox.insert({ dedupeKey: `${jobId}:${expectedVersion + 1}:${next}`, type: "job.transitioned", jobId });
  });
}
```

### Exactly-once effects where possible; at-least-once transport
- Webhooks/events are at-least-once; use `provider + delivery_id` unique constraint.
- Job creation uses caller `Idempotency-Key` scoped to actor and route.
- Task claim uses row lease (`lease_owner`, `expires_at`, `fencing_token`) with compare-and-swap; heartbeat every 10 s; lease TTL 45 s initially.
- A task attempt carries a monotonic fencing token; events from older attempts are rejected/quarantined.
- PR creation uses `repo + issue + job` unique mapping and looks up prior branches/PRs before retry.
- Merge idempotency uses merge-intent ledger keyed by `repo_id/pr_number/head_sha`; after timeout, fetch GitHub authoritative PR and commit status rather than issuing a second merge blindly.
- Worker crash: reclaim expired lease, inspect workspace/remote branch, verify artifact digests and candidate SHA, then restart the last safe stage.
- Rework budget initially max 3 cycles, max 2 automated fixes per gate failure class, else escalate.
- Cancellation stops new lease claims, revokes scoped capability, kills process group, destroys ephemeral sandbox and marks canceled only after cleanup status is recorded.

### Evidence/approval invalidation
Approval cache key:
`repo_id + head_sha + base_sha + gate_config_digest + policy_digest + reviewer_set_digest + artifact_digest + policy_version`.
Any change invalidates prior review/approval. A head SHA update always returns to `GATING`; a base movement triggers policy-specific sync/rebase + new gate + reviewers for affected surfaces. Mandatory CI must report against exact head or merge-queue candidate. Do not infer a green result from branch name alone.

## 6. Risk engine and model routing

### Risk factors (structured, not an LLM confidence number)
- `LOW`: documentation/test-only or isolated non-sensitive functionality; no protected files.
- `MEDIUM`: application behavior, UI, moderately scoped code changes.
- `HIGH`: auth, payments, storage, external integrations, infra, concurrency, migrations, security, privacy, dependency upgrades.
- `CRITICAL`: production secrets, branch protection, access control, destructive migrations, security policy, regulated/game math, deployment control or material user-impacting changes.

**Escalation override:** protected paths or sensitive domains always increase risk. LLM classification can propose risk; deterministic path and capability classifiers set the minimum. Default to higher risk on disagreement or unknown data.

| Risk | Reviewers | Deterministic gates | Merge policy |
|---|---|---|---|
| LOW | code | lint, typecheck, unit, build as applicable | human initially; conditional auto after calibration |
| MEDIUM | code + relevant UX/UI or security | + integration, affected contract checks | human initially; later auto only by explicit allowlist |
| HIGH | code + security + other relevant reviewers | + e2e, SAST, secret/dependency scans, targeted regressions | human approval mandatory |
| CRITICAL | code + security + domain expert(s) | + restricted premerge checks and change-control | human approval, two-person review where configured; may be prohibited |

### Harness routing
- Config offers eligible **subscription-backed CLI models or locally hosted models only**, according to provider terms and measured capabilities.
- Default builders use the highest-quality **permitted and available** runtime; locally hosted models are eligible for a role only after demonstrating appropriate quality, without treating low cost as sufficient justification.
- Harness choice requires eval score on representative tasks, supported tool permissions, context-size fit, latency limits, reliability and provider terms.
- If preferred harness unavailable, choose approved equivalent or `AWAITING_HUMAN`; never silently downgrade a high-risk builder or reviewer.
- Emit `routing_decision` artifact including policy version, model, fallbacks and justification.

**Model evaluation gate:** on a fixed 30+ task benchmark, measure acceptance-criteria completion, correct tests, independently verified defects, security false negatives, review usefulness, p50/p95 runtime, subscription-limit pressure and local hardware utilization. Reject any candidate that materially worsens the agreed quality metric. Hold a pilot and regression baseline before changing default model routes.

### Mandatory inference sourcing and no-billing policy

- **Permitted:** officially supported subscription-backed interactive/CLI usage **only when the provider's current terms explicitly permit the factory's intended orchestration**; fully local/self-hosted model weights or inference servers with no usage-billed external inference calls.
- **Forbidden:** Anthropic/OpenAI/third-party inference API keys, pay-as-you-go billing, metered inference endpoints, credit balances, token-purchase flows, subscription-token extraction, credential forwarding, and automatic fallback to a paid model service. This includes model API usage hidden inside SDKs, proxy gateways or cloud inference platforms.
- **Separate category:** the factory's own REST API and GitHub/Linear APIs remain allowed for job management and version-control operations; these are not model inference APIs. Cloud infrastructure hosting may incur normal compute charges, so remote execution requires separate explicit operator enablement and a host-infrastructure limit, but **never paid model inference**.
- **Auth enforcement:** reject `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and equivalent model provider API credentials in worker execution environments and configuration. Confirm the runtime is operating in its intended subscription or local mode; uncertain mode = block. Never attempt to evade subscription restrictions or spoof client identity.
- **Placement:** subscription CLI sessions execute only where that official CLI and provider terms permit their use, normally operator-controlled local machines; remote workers require explicit terms approval and cannot receive copied subscription credentials. Cloud jobs default to approved local/self-hosted models deployed on the cloud worker (subject to model licenses, provider terms and infrastructure cost limits), or stay queued.
- **Fallback:** allowed subscription model → another separately approved subscription CLI or validated local model, only where quality gates allow; otherwise `AWAITING_HUMAN`. No API escape hatch, even after quota exhaustion or outages.
- **Policy enforcement:** a centralized `InferenceSourcePolicy` validates `authMode`, adapter provenance, environment variables, executable identity, destination allowlist and user authorization at worker registration and before every model run. Configuration is immutable to agents, audited, and deny-by-default.
- **Observability:** show subscription rate-limit/usage alerts, model runtime availability, elapsed time and local resource utilization. No invoiced-token fields or estimated dollar-per-token charts.

## 7. Harness adapter interface

```ts
type AgentRole = "intake" | "analyst" | "architect" | "spec" | "builder" | "tester" |
  "review_code" | "review_security" | "review_ux" | "review_ui" | "review_performance" | "approver_adviser";

interface RuntimeCapabilities {
  structuredOutput: boolean;
  shell: boolean;
  toolAllowlist: boolean;
  resume: boolean;
  tokenTelemetry: boolean;
  authMode: "subscription_cli" | "local_model";
  sandboxModes: Array<"local" | "cloud">;
}
interface AgentRunRequest {
  requestId: string;
  jobId: string;
  attempt: number;
  role: AgentRole;
  modelId: string;
  promptVersion: string;
  immutableContextManifestUri: string;
  workspaceUri?: string;
  allowedTools: string[];
  maxWallTimeSec: number;
  maxOutputBytes: number;
  maxComputeSeconds?: number;
  maxEstimatedTokens?: number;
  subscriptionUsageGuard?: { maxJobsPerPeriod?: number; stopWhenRateLimited: true };
  outputSchemaUri: string;
}
interface AgentRunResult {
  runId: string;
  exitStatus: "succeeded" | "failed" | "timed_out" | "cancelled";
  artifactUri?: string;
  candidateSha?: string;
  usage?: { inputTokens?: number; outputTokens?: number; computeSeconds?: number };
  usageSource: "cli_reported" | "local_runtime" | "estimated" | "unavailable";
  inferenceBillingMode: "subscription_included" | "local_compute";
}
interface AgentRuntimeAdapter {
  id: string;
  probe(): Promise<RuntimeCapabilities>;
  start(request: AgentRunRequest, events: (event: AgentEvent) => Promise<void>): Promise<string>;
  status(runId: string): Promise<AgentRunResult | { exitStatus: "running" }>;
  cancel(runId: string): Promise<void>;
  resume?(runId: string, checkpointUri: string): Promise<string>;
}
```

Implement `MockAdapter` first, then `LocalModelAdapter`, then permitted `ClaudeCodeSubscriptionCliAdapter` and `CodexSubscriptionCliAdapter`. Probe installed versions, supported login modes, provider terms and capabilities. Enforce tool allowlists at the sandbox broker boundary, parse structured output with schema validation, and redact streams. Token telemetry is optional and for capacity analysis only; do not calculate or display per-token invoice estimates. Reject environment-supplied model API keys and any setting that switches a CLI into usage-billed mode. Avoid brittle parsing of undocumented transcripts.

Agent event envelope:
```json
{
  "event_id": "evt_...", "job_id": "job_...", "attempt": 1,
  "fencing_token": 3, "run_id": "run_...", "sequence": 19,
  "timestamp": "2026-11-18T20:00:00Z", "type": "agent.progress",
  "payload": {"message": "Unit tests running"},
  "schema_version": "1.0"
}
```

## 8. Execution, sandboxing and trust boundaries

### Trust tiers
- T0: privileged control plane and secret broker (no untrusted shell execution).
- T1: merge coordinator and privileged GitHub App (isolated service, no agent tools).
- T2: gate runners with immutable gate configuration and limited read rights; may run untrusted repository tests **inside** a sandbox.
- T3: coding agents in isolated per-job environments; outbound access restricted.
- T4: untrusted issue text, repository content, README/AGENTS.md, web/MCP responses, artifacts from external tools.

**Local execution:** A Git worktree alone is NOT a security boundary. On macOS use a dedicated restricted OS account plus a sandboxed VM/container environment where feasible; use an isolated disposable workspace with no home-folder access, host SSH agent, keychain, developer credentials, mounted private directories or Docker socket. If this isolation is unavailable, mark local mode as `trusted_repository_only` and prohibit autonomous execution of unknown code. Read-only checkouts do not protect from malicious build scripts; run builds inside the same confinement strategy.

**Cloud execution:** short-lived workers, minimal images, pinned digests, private network, time-limited credentials, resource limits, workspace teardown, egress allowlist, encryption at rest, and no production secret material. Cloud workspace should hold only authorized repository content; respect repository confidentiality and provider data agreements.

**Branch protection:** all agent changes land on `factory/<job-id>`; protected `main`, policies, workflow definitions, deployment scripts, secrets and factory configuration may trigger critical/manual review. GitHub rulesets enforce required CI, signed/verified commits if configured, reviews and merge queue.

**Prompt injection defense:** content from issue bodies, comments, repository files and tool output is quoted/scoped data; runtime policy is injected from factory-controlled config. Never trust instructions in a repo telling the agent to disable tests, exfiltrate credentials or modify role boundaries. Intercept tools to prohibit high-risk commands; deny outbound connections except allowlisted destinations; aggressively redact secret-looking strings from progress logs. Model-only instruction hierarchy does not replace sandbox enforcement.

**Secrets:** prefer ephemeral GitHub App installation tokens; restrict by installation/repository and permission. Separate read, branch-write, and merge duties operationally. **Model API keys are not supported and must not be stored in the broker.** Subscription-backed official CLI authentication remains provider-managed, must not be extracted or copied into remote workers, and is available only in allowed execution environments. Local model inference requires no provider credentials. Never include credentials in agent prompts or context manifests.

**Supply chain:** lock dependency versions; isolate package-manager lifecycle scripts; pin runners/images by digest; scan license, secrets and dependencies; produce SBOM and signed manifest per shipped factory release. Require operator authorization before giving a task cloud network access.

## 9. Data model (PostgreSQL)

All tables include timestamps and soft-delete/retention policies where appropriate. IDs are UUIDv7/ULID; externally sourced IDs are separately indexed.

```text
organizations(id, name, settings_version)
users(id, organization_id, auth_subject, role, disabled_at)
repositories(id, organization_id, provider, external_id, owner, name, base_branch, policy_id, installation_id)
integrations(id, organization_id, provider, external_id, credentials_ref, config)
requests(id, repository_id, source, source_external_id, payload_digest, state, requester_id)
jobs(id, request_id, repository_id, state, version, risk, policy_digest, spec_digest,
     base_sha, head_sha, pr_number, current_round, max_rounds, paused_at, pause_reason,
     created_by, last_error_code)
job_transitions(id, job_id, from_state, to_state, version, actor_id, evidence_digest, timestamp)
tasks(id, job_id, stage, role, status, attempt, lease_owner, lease_expiry,
      fencing_token, assigned_worker_id, worktree_ref, runtime_id, model_id)
workers(id, org_id, mode, capability_json, heartbeat_at, status, attestation)
agent_runs(id, task_id, runtime_id, model_id, prompt_digest, context_digest, status,
           auth_mode, inference_billing_mode, token_input, token_output, compute_seconds, usage_source)
artifacts(id, job_id, run_id, kind, digest, storage_uri, byte_length, redaction_status)
gate_results(id, job_id, head_sha, base_sha, gate_config_digest, verdict, results_digest)
review_results(id, job_id, head_sha, reviewer_role, reviewer_run_id, verdict, findings_digest)
policy_decisions(id, job_id, head_sha, policy_digest, risk, eligible, reasons, expires_at)
approvals(id, job_id, head_sha, base_sha, policy_digest, actor_id, decision, timestamp)
merge_intents(id, job_id, repository_id, pr_number, head_sha, status, github_merge_sha)
events(id, job_id, sequence, type, source, actor_id, payload_redacted, digest, timestamp)
outbox(id, event_id, destination, dedupe_key, status, attempts, retry_after)
webhook_deliveries(id, provider, delivery_id, signature_valid, received_at, processed_at)
audit_entries(id, organization_id, actor, action, resource, result, reason, timestamp, digest)
```

Required uniqueness:
- `requests(repository_id, source, source_external_id)` for connectors.
- `webhook_deliveries(provider, delivery_id)`.
- `tasks(job_id, stage, attempt, role)` where applicable.
- `jobs(request_id)` initially one active job per request; rework stays in same job.
- `merge_intents(repository_id, pr_number, head_sha)`.
- `events(job_id, sequence)`.

Indexes: `jobs(state, created_at)`, `tasks(status, lease_expiry)`, `events(job_id, sequence)`, `audit_entries(organization_id, timestamp)`; partition heavy telemetry later.

## 10. HTTP API contracts

Base `/api/v1`; TLS required except localhost development. Auth: OIDC session for dashboard, service JWT/mTLS for workers, verified HMAC signatures for webhooks. Every mutating API validates actor role and resource scope. All errors follow Problem Details (`application/problem+json`). `Idempotency-Key` required for job creation, approvals and cancellation. Pagination uses cursor + limit <=100.

| Method/path | Body | Success | Auth |
|---|---|---|---|
| `POST /jobs` | `{repositoryId, request:{type,title,description,sourceId?}, priority?}` | `202 {jobId,state,version}` | editor/operator |
| `GET /jobs` | query filters, cursor | `200 {items,nextCursor}` | viewer+ |
| `GET /jobs/:id` | none | `200 JobDetail` with `ETag` version | viewer+ |
| `POST /jobs/:id/cancel` | `{reason,expectedVersion}` | `202 {state,version}` | operator |
| `POST /jobs/:id/resume` | `{expectedVersion,reason}` | `202` | operator |
| `POST /jobs/:id/feedback` | `{message,expectedVersion}` | `202` | editor/operator |
| `POST /jobs/:id/decisions` | `{decision:"approve"|"reject"|"rework",headSha,baseSha,policyDigest,expectedVersion,reason?}` | `202 {decisionId}` | approver |
| `GET /jobs/:id/events` | `afterSequence` | `200 {events,nextSequence}` | viewer+ |
| `GET /jobs/:id/events/stream` | `Last-Event-ID` SSE | event stream | viewer+ |
| `GET /jobs/:id/artifacts` | kind, cursor | `200 {items,nextCursor}` | viewer+ |
| `GET /jobs/:id/policy` | none | `200 {risk,gates,reviewers,mergeEligibility}` | viewer+ |
| `GET /workers` | none | `200 {items}` | operator |
| `POST /workers/claim` | `{workerId,capabilities}` | `200 {task,leaseToken,expiresAt}` or `204` | worker |
| `POST /workers/:id/heartbeat` | `{taskId,leaseToken}` | `200 {expiresAt}` | worker |
| `POST /runs/:id/events` | event envelope | `202` | scoped worker |
| `POST /integrations/github/webhook` | raw signed body | `202` | signature-verified |
| `POST /integrations/linear/webhook` | raw signed body | `202` | signature-verified |
| `GET /health/live` | none | `200` | internal |
| `GET /health/ready` | none | `200/503` | internal |

**Approval security:** `POST /decisions` persists a bounded human authorization, NOT immediate unconditional merge. Merge coordinator freshly fetches repository, PR, base/head, rules, status checks, reviews, policy and approval. If any detail changed, approval is stale and merge is blocked. `If-Match` or expectedVersion prevents racing operators.

### Job creation example
```http
POST /api/v1/jobs
Authorization: Bearer <redacted>
Idempotency-Key: 81ca3b54-example
Content-Type: application/json

{"repositoryId":"repo_123","request":{"type":"feature","title":"Add search filters","description":"Support filters for status and owner"}}
```
```json
{"jobId":"job_01JXYZ","state":"QUEUED","version":1}
```

### Event types
`request.received`, `job.accepted`, `job.transitioned`, `job.blocked`, `job.paused`, `task.claimed`, `task.heartbeat`, `task.expired`, `agent.started`, `agent.progress`, `agent.completed`, `gate.started`, `gate.passed`, `gate.failed`, `review.started`, `review.completed`, `review.changes_requested`, `pr.created`, `approval.requested`, `approval.recorded`, `merge.blocked`, `merge.completed`, `postmerge.failed`, `job.completed`, `job.cancelled`, `security.quarantined`.

**Delivery semantics:** event stream is best-effort realtime; DB-backed event history is authoritative and clients reconnect using last sequence. Status projections must be rebuildable from authoritative rows/events.

## 11. Deterministic gates and merge safety

### Gate manifest example
```yaml
schemaVersion: 1
profile: typescript-web
locked: true
steps:
  - id: dependencies
    command: ["bun", "install", "--frozen-lockfile"]
    timeoutSeconds: 240
  - id: lint
    command: ["bun", "run", "lint"]
    timeoutSeconds: 180
  - id: typecheck
    command: ["bun", "run", "typecheck"]
    timeoutSeconds: 180
  - id: unit
    command: ["bun", "run", "test:unit"]
    timeoutSeconds: 300
  - id: build
    command: ["bun", "run", "build"]
    timeoutSeconds: 600
protectedPaths:
  - ".github/workflows/**"
  - "factory-policy/**"
  - "migrations/**"
  - "security/**"
```

Runner may only execute administrator-approved checked commands, but package scripts themselves may be untrusted: all execution stays inside the restricted sandbox. Gate evidence includes exact repo, head SHA, base SHA, gate manifest digest, executable versions, image digest, commands, exit codes, timestamps, logs digest, and CI run URLs.

### Premerge algorithm (server-owned)
1. Fetch PR and confirm it maps to the intended job and repository and source branch; check closed/merged status.
2. Fetch GitHub authoritative head SHA and target base SHA; verify expected candidate and invalidate stale artifacts.
3. Re-evaluate risk from current full diff (including renamed files, submodules and symlinks), protected paths and repo policy.
4. Check review set and findings for the exact candidate; unresolved required findings block.
5. Confirm required deterministic checks and GitHub protected-branch/merge-queue gates for exact SHA (or exact merge-queue ref).
6. Confirm merge policy and required human approval for current head/base/policy; no auto-merge of HIGH/CRITICAL by default.
7. Use GitHub API with expected head SHA where supported; if branch advanced, abort and revalidate. Prefer GitHub merge queue where configured.
8. Persist merge result and authoritative merge SHA; monitor main's CI.
9. On postmerge regression, alert and create revert PR or operator-approved revert path. **Do not silently force-push or automatically revert high-impact code**; auto-revert requires a narrowly enabled per-repository policy and deterministic safety conditions.

## 12. Hybrid execution scheduler

### Placement decision
- `LOCAL`: trusted repository, low data-sensitivity concerns, host configured with strong isolation, resource request fits capacity.
- `CLOUD`: approved organization/repo, image and data location compliant, cloud sandbox ready, local resources constrained or user explicitly requests remote.
- `BLOCK`: neither environment satisfies required isolation, permissions, cost or data-residency policy.

Scheduler policy scores latency, capability compatibility, resource availability, source confidentiality, approved network access and environment attestation. Price is a tie-breaker after quality, security and reliability.

### Starting capacity
- Local max running jobs: 1, maximum 2 concurrent review agents inside it.
- Cloud default: disabled until security parity; later maximum 2 running jobs.
- One active builder per job; reviewers may parallelize read-only. Global budgets and per-repository concurrency caps apply.
- Dynamic concurrency depends on RAM, CPU saturation, tool/provider quotas and observed gate durations.

### Worker health
- Worker register: supported runtimes/models, sandbox implementation, OS/image, free capacity, network policy, attestation.
- Regular heartbeat; worker lost after missed heartbeats; leases expire and are fenced.
- Worker dispatch supports `cancel`, `drain`, `quarantine` and `rotate credentials`.
- Local daemon runs as an unprivileged user; GUI launch agent optional but not relied on for security.

## 13. Dashboard and operator UX

Pages: **Overview**, **Jobs**, **Job Detail**, **Inbox**, **Repositories**, **Workers**, **Policies**, **Models & Evals**, **Usage & Capacity**, **Audit**.

Job detail minimum tabs: timeline, request/spec, plan, changed files, test gates, independent reviews, PR, usage, logs, recovery. Show job state, current stage, selected model/harness, subscription or local runtime, run time, capacity limits and reason for block. Render trust flags for incomplete telemetry. Display risk reasons rather than a single opaque confidence score.

Inbox actions: answer clarifying question, approve exact-head merge, request changes, reject, pause/cancel, escalate incident. Always show impact, affected repo/PR, target branch and immutable candidate SHA; confirmations for irreversible actions. Approvals require fresh authorization and expire when evidence changes.

Usage & Capacity dashboard: jobs, elapsed time, optional token telemetry, subscription throttling/quota signals where exposed by the official CLI, local RAM/CPU/GPU pressure, concurrent agents, retry waste and compute limits by job/stage/role/runtime. **No model API billing, token-cost estimates, API spend forecasts or pay-as-you-go budget controls.** Infrastructure hosting fees, if any, are a separate optional operations concern, not model billing.

## 14. Security and governance baseline

- SSO/OIDC, CSRF protections for browser writes, strict session expiry, rate limiting, per-org RBAC (viewer, editor, operator, approver, admin, security_officer).
- Separate environment credentials and database roles for API, worker, ingest and merge coordinator.
- Webhook HMAC verification on raw body; guard replay window when supported; dedupe delivery IDs.
- Audit trail of every approval, policy change, secret access, credential rotation, worker join and merge. Store append-only tamper-evident digests; replicate to independent log storage for high assurance.
- Encrypt secrets using managed KMS or OS-secure storage; rotate installation tokens, do not write them to artifacts.
- Restrict cloud providers and AI vendors according to repository classification; no sending proprietary code to a model without organizational approval.
- Enforce egress/DNS allowlists, reject localhost metadata URLs and SSRF, cap input/output sizes and timeouts.
- Signed artifact manifests and digest verification on handoff.
- Retention defaults proposal: debug logs 14 days; detailed artifacts 90 days; audit events 365 days, adjustable under applicable policy. Never silently delete evidence for an open investigation.
- Threat model before pilot: malicious issue, malicious dependency script, injected repo instructions, compromised worker, stolen GitHub token, stale approval, event replay, model hallucination, cloud sandbox escape, reviewer collusion, PR-target mismatch.

## 15. Implementation milestones and exact deliverables

**All milestones have blocking tests; advance only when exit criteria pass.** Effort estimates are indicative engineering planning bands, not promises.

### M0 — License, repo and threat-model foundation (3–5 engineer-days)
- Create original monorepo and CI; pin toolchain; add provenance register and legal approval checklist.
- Document architecture ADRs and threat model; run baseline static analysis and license scan.
- Deliver: `docs/adr/0001`, `PROVENANCE.md`, `licenses/allowlist.yaml`, `.github/workflows/ci.yml`, `docs/security/threat-model.md`.
- Exit: no copied upstream code; CI green; legal status clearly logged.

### M1 — Durable control plane and mock E2E (8–12 engineer-days)
- Contracts, database migrations, state machine, outbox, API auth, idempotency, mock agent runtime, mock git provider, minimal dashboard.
- Exit: mock request can proceed to simulated PR; invalid transitions fail; crash/restart resumes; duplicate API calls have one job.

### M2 — Local isolated execution + GitHub integration (10–15 engineer-days)
- Local runner, workspace safety, worktree manager, worker lease/fencing, GitHub App, PR lifecycle, immutable logs.
- Exit: real test repo, real PR, no changes to `main`; revoked/expired workers cannot publish late results; no privileged credentials in sandbox.

### M3 — Agent pipeline, gates and reviewer routing (12–18 engineer-days)
- Intake, analyst/spec, builder and tests; subscription-backed Claude/Codex CLI adapters and local model adapter; independent reviewer sessions; deterministic gates and risk routing; bounded rework.
- Exit: intentionally broken code cannot merge; independent reviewers all finish; agent output schema errors cause safe failure; 3 review rounds max.

### M4 — Human approval, merge coordinator and observability (8–12 engineer-days)
- Exact-head merge guards, protected branch support, approval UI, SSE, usage/capacity reporting, audit, notifications and postmerge monitoring.
- Exit: stale approval cannot merge; no branch-protection bypass; all actions auditable; postmerge break detected and escalated.

### M5 — Optional cloud and controlled autonomy (10–15 engineer-days)
- Cloud adapter and attestation, secret/data boundaries, remote logs, scheduler placement; pilot and benchmark; opt-in low-risk auto-merge.
- Exit: sandbox parity tests, cleanup verification, pilot metrics, human sign-off for eligible auto-merge repos. HIGH and CRITICAL remain manually reviewed.

**Suggested dependency order:** M0 → M1 → M2 → M3 → M4; M5 is optional and follows stable manual operation. Deliver functional vertical slices, not a large speculative framework with no PR demonstration.

## 16. Agent implementation work orders

Each work order should generate code, tests, migration notes, docs and evidence; work orders may be delegated to coding agents in order.

| ID | Work item | Depends on | Done when |
|---|---|---|---|
| FND-001 | Workspace, lint/test/build CI | — | clean checkout boots and CI green |
| LIC-001 | provenance/allowlist/license gate | FND-001 | new dependency blocked if unapproved |
| DOM-001 | domain entities + state transition matrix | FND-001 | exhaustive state transition tests |
| DB-001 | Postgres schema + migrations | DOM-001 | rollback/upgrade test and constraints pass |
| API-001 | auth, RBAC, job creation and idempotency | DB-001 | unauthorized/duplicate requests rejected |
| EVT-001 | event log/outbox/SSE | DB-001 | replay and resume work with no event holes |
| SCH-001 | lease/fencing scheduler | DB-001 | stale worker cannot overwrite next attempt |
| RUN-001 | local worker and workspace sandbox | SCH-001 | safe cleanup and forbidden host access tests |
| SCM-001 | GitHub App and PR creation | RUN-001 | test repo draft PR opened idempotently |
| AGT-001 | typed adapter contract + mock | DOM-001 | mock simulation passes |
| AGT-002 | Claude Code subscription CLI adapter | AGT-001,RUN-001 | supported subscription authentication, terms gate, smoke + timeout/cancel + no-API-billing tests |
| AGT-003 | Codex subscription CLI adapter | AGT-001,RUN-001 | supported subscription authentication, terms gate, no-API-billing and contract tests pass |
| AGT-004 | Local model adapter | AGT-001,RUN-001 | offline inference and same adapter contract suite pass |
| ORC-001 | orchestrator with stage persistence | EVT-001,SCH-001,AGT-001 | crash/restart and invalid transition tests |
| INT-001 | safe intake and acceptance criteria | ORC-001 | malicious issue cannot change policy |
| SPC-001 | analysis, architecture, specification | INT-001 | every AC mapped to task/tests |
| BLD-001 | build/rework and candidate SHA storage | SPC-001,SCM-001 | reproducible branch and bounded retries |
| GAT-001 | locked deterministic gate engine | BLD-001 | tampered checks cannot pass |
| REV-001 | risk-routed independent reviewers | GAT-001 | required reviewers all report for same SHA |
| POL-001 | risk and merge-policy engine | REV-001 | high/critical never auto-merge |
| MRJ-001 | exact-head approval and merge coordinator | POL-001,SCM-001 | stale SHA blocks; merge logged once |
| OBS-001 | dashboard, audit, subscription/local usage and tracing | ORC-001 | full job timeline reconstructible without model-price metrics |
| CLD-001 | cloud sandbox provider | MRJ-001,RUN-001 | isolation/parity/teardown tests |
| EVAL-001 | role/model quality benchmarking | AGT-002,AGT-003,AGT-004 | documented quality regression thresholds |
| AUTO-001 | opt-in low-risk merge policies | EVAL-001,MRJ-001 | policy pilot passes and manual override works |

## 17. Test plan and acceptance matrix

### Unit tests
- State transition allow/deny table; risk min-level override; deterministic review routing; agent schema validation; budget enforcement; candidate SHA invalidation; approval expiry; dedupe and rate limiting.

### Contract tests
- Each runtime adapter with supported/unsupported capabilities; all API request/response schemas; GitHub/Linear webhook signature verifier; artifact digest integrity; events monotonicity.

### Integration tests
- Postgres transactional job transition with concurrent workers; outbox retries; GitHub PR lifecycle in dedicated test repositories; actual CLI timeout/cancellation; cloud sandbox creation and cleanup.

### E2E fixtures
1. Normal UI feature: intake → spec → builder → lint/unit/build → UX+UI+code review → human approval → merged → done.
2. Simple test-only change: no unnecessary UI reviewer; audit shows routing reason.
3. Build failure: gate prevents review, builder reworks, new head gets new evidence.
4. High-risk auth change: security reviewer mandatory, manual approval mandatory even with green CI.
5. Code review requests changes: no approver until rework, gate and all reviews rerun.
6. Unanswerable request: `NEEDS_INFO`, explicit answer resumes without lost progress.
7. Concurrent duplicate webhook: exactly one job created.
8. Runner killed in middle of work: lease expires, next worker restores without corrupting branch.
9. Candidate SHA changes after approval: merge denied, new checks/approval required.
10. Base branch changes: stale checks invalidated, merge denied until sync/revalidation.
11. Prompt injection in README/issue: ignored for policy; no credential access.
12. Malicious test script attempts host access: denied and worker quarantined.
13. Cloud worker cannot contact secret broker/host services beyond approved scope.
14. GitHub API returns timeout after merge: reconcile authoritative PR before retry.
15. Postmerge CI failure: `POSTMERGE_MONITOR` records incident; operator notified.
16. Cancellation during build: process group terminated, token revoked, artifact/wrapper cleanup verified.
17. Budget exceeded: stop at safe boundary, request approval, prevent accidental auto-restart.
18. Reviewer exits without schema: cannot count as PASS; pipeline holds/retries.
19. Unavailable preferred model: approved alternative or human stop; no unapproved quality downgrade.
20. License policy rejects attempted import of prohibited upstream source.

### Security/adversarial suite
- Prompt injection, webhook forgery/replay, path traversal, symlink escapes, poisoned Git config/hooks, malicious package lifecycle scripts, secret exfiltration, SSRF to cloud metadata, cross-tenant requests, token misuse, stale fencing token, event flood, oversized artifact, reviewer bypass, mutable gate script and time-of-check/time-of-use race.

### Nonfunctional acceptance SLOs (initial targets, measured in staging)
- API read p95 < 500 ms under 20 concurrent dashboard clients (excluding external network calls).
- Event delivered to connected UI p95 < 3 s from persistence, with SSE fallback to replay.
- Scheduler recovers expired lease within 90 s after missed heartbeats.
- All state mutations record a durable audit/event trail atomically.
- Zero unauthorized merges, zero accepted stale approvals in adversarial suite.
- 99%+ successful event deduplication under injection of repeated webhook payloads (target should be 100% when delivery IDs are supplied).
- Restore operation documented and tested from database + artifact backup; recovery targets RPO 15 min and RTO 4 h for hosted deployment, adjustable before production.
- No production credentials reachable inside coding sandboxes; verified by integration tests.

### Quality calibration before automatic merge
- Test on at least 30 varied tasks across 3 representative repositories, with >=10 deliberately seeded defects and at least 5 high-risk negative controls.
- Zero auto-merge authorizations for HIGH/CRITICAL tasks.
- No bypass of deterministic checks or branch protections.
- Independently assess PR quality and escaped defects against manual baseline; do not enable unattended merge without a signed pilot report and clear rollback switch.

## 18. Migration strategy from the source designs

**Phase A: inventory and permission audit**
1. Freeze documented source snapshots/commits and create a component inventory.
2. Map public capabilities into original requirements; collect upstream licensing evidence per folder/file.
3. Decide for each component: original reimplementation, approved clean integration, or excluded.
4. Default all unverified Marshal and Zazen v1 source to `EXCLUDED`.

**Phase B: preserve conceptual strengths (not source code)**
- Reimplement Marshal-style dashboard, ingest, persistent runner, event reporting and supervised inbox with original code.
- Reimplement Zazen v2-style deterministic job/gate/route approach as typed domain services and original policies rather than copying scripts/prompts.
- Adopt model/runtime independence with adapters, not a hard dependency on T3 or PStack.

**Phase C: shadow operation**
- Route selected test issues to new factory; keep existing operational system unchanged.
- Compare task output, review quality, costs, human interventions, recovery events and GitHub outcomes.
- Manual approval and test repository only until comprehensive evidence passes.

**Phase D: staged cutover**
- Start with one repo, one worker, manual PR merges; then more repos and optional cloud; only then opt-in low-risk automation.
- Import historical jobs only as read-only audit records; do not interpret old file-state markers as authoritative new workflow state.
- Preserve rollback by turning off new intake/worker and reverting to manual GitHub workflow; never roll back database schema destructively.

## 19. Decisions already made and defaults requiring validation

| Area | Decision or default | Validation trigger |
|---|---|---|
| Foundation | Original reimplementation inspired by Marshal | if written license/authorization obtained |
| Runtime | Claude and Codex, plus mock | CLI/version probes and benchmark |
| Hosting | local-first, cloud opt-in | cloud security and data review |
| Merge | human every PR for pilot, later approved LOW only | evidence and operator sign-off |
| First issue provider | GitHub | integrate Linear after stable core |
| Worker concurrency | one job | resource/quality evidence |
| State persistence | PostgreSQL transactions/outbox | operational load review |
| Isolation | dedicated sandbox, not bare worktree | macOS platform and repo trust |
| Model selection | quality-first role routing | benchmark before changes |
| Model inference billing | strictly forbidden (subscription CLI or local inference only) | terms compliance and enforcement tests |
| Deployment | factory cannot deploy in v1 | separate future approval |

## 20. Operational runbooks

### Job stuck / worker lost
- Confirm last persisted stage, lease token and worker heartbeat.
- Do not mark job complete based on agent text. Wait for lease expiry or explicit fence; inspect remote Git status and artifact digests.
- Retry from prior safe stage; for a candidate SHA that changed, rerun gate/review.
- Escalate after bounded attempts or security anomaly.

### Stale PR approval
- Mark approval invalid when head/base/policy/check digests differ; return PREMERGE→REWORK or AWAITING_HUMAN with explicit reason.
- Never merge based on remembered approval or human chat message not bound to SHA.

### Suspected secret exposure
- Immediately quarantine job and worker; revoke affected tokens, disable provider connection if required, preserve forensic evidence, notify security operator. Rotate credentials; investigate artifact store and outbound logs. No automatic resumption.

### Model outage
- Respect allowed fallback models; pause jobs lacking equivalent models. Do not silently change prompts, reviewer count or policy.

### Main branch failure after merge
- Distinguish caused-by-change from unrelated CI noise using reproducible signals. Alert, open incident and optional revert PR. Human controls final remediation by default.

### No-paid-inference regression tests (mandatory)
1. Start a worker with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or another configured model API key: worker refuses the credential and will not run paid inference.
2. Exhaust subscription CLI quota: job pauses or routes to an eligible local model, never purchases credits or invokes provider inference APIs.
3. Configure a provider API base URL or token-priced gateway: schema validation rejects it and logs the policy violation.
4. Cloud worker without valid permission to use subscription authentication: worker rejects subscription execution; if an approved self-hosted model is absent, job queues.
5. Agent attempts to edit provider configuration or launch a direct paid-model SDK: sandbox network/secret policy blocks the call.
6. Inspect telemetry and database: no `billed_usd`, `estimate_usd`, invoice or paid-model-inference path exists.
7. Provider subscription terms become unclear or change: disable relevant adapter pending reapproval; keep local models available.

## 21. Definition of Done for the factory itself

The engineering program is ready for first production pilot when all of the following hold:
- A user can file a request and see a complete immutable job history in the dashboard.
- Two different coding harness adapters, including one local model adapter, pass the same contract test suite.
- Local isolation does not expose host secrets; malicious-code tests pass.
- The state machine recovers cleanly from killed workers and duplicate events.
- Every PR has an acceptance-criteria trace, reproducible gate evidence, independent reviews appropriate to risk and runtime-usage labels.
- Approvers see the exact SHA/diff and cannot approve stale code.
- A real test PR can merge only through the privileged coordinator with GitHub branch protection intact.
- Operators can pause/cancel/quarantine and audit every action.
- No upstream source code is incorporated without recorded permission/compliance analysis.
- An observed pilot demonstrates quality without unauthorized automatic merges.

---

**Implementation note:** This is a target specification. Source repositories were verified via public web documentation, but runtime compatibility, upstream licensing and source-level internals require separate pinned-commit verification. The local code-clone attempt in the authoring environment could not reach GitHub, so this document intentionally does not claim a source-level audit or a working implementation.
