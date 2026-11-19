# v2.2 Architecture and Data Contracts

## 1. Integration architecture

```text
apps/web PM + Skills + Improvements UI
       | authenticated API (RBAC, CSRF, audit)
apps/api ──> packages/product (meetings, PRDs, stories, analytics)
       ├──> packages/capabilities (matcher, gap analyst)
       ├──> packages/skills (inventory, discovery, generator, validation, registry)
       ├──> packages/improvements (evidence -> hypotheses -> supervised candidates)
       └──> packages/db (transactional activation + outbox)
                     |
           existing orchestrator/scheduler
                     |
              sandboxed runner
                     |
          approved skills/agents pinned by digest
                     |
       existing checks/review/GitHub draft PR
```

All agent-authored content, repository text, search results, uploaded skills and meeting transcripts are **untrusted** until screened. The supervisor produces proposals only. A separate authenticated API policy service and database transaction activate versions. Skill execution requires an approved immutable manifest plus a least-privilege runtime lease.

## 2. Logical services and API ownership
- `SkillCatalogService`: read-only inventory, source scanning, metadata and provenance; no execution capability.
- `CandidateService`: quarantined import/generation; creates snapshots, manifests, validation requests; cannot activate.
- `ValidationService`: static and isolated behavioral tests; writes signed evidence bound to digest.
- `RegistryService`: store immutable artifacts, versions, dependency pinning, compatibility results, revocation.
- `ApprovalService`: authenticated approval policy, author separation, expiring exact-digest approvals.
- `ActivationService`: single authoritative transactional promotion, revocation, rollback; no LLM involvement.
- `CapabilityRouter`: choose approved, qualified, permission-compatible agent+skill sets; explain rejection.
- `ProductWorkspaceService`: versioned meetings, evidence records, documents, backlog drafts, analytics snapshots.
- `ImprovementSupervisor`: telemetry intake, dedupe, prioritization, candidate requests, user-facing recommendations, monitoring; **no deployment/merge credentials and no write access to registry activation state**.

## 3. Proposed Postgres entities
Use additive migrations to match existing `packages/db` conventions. All rows tenant/project scoped and subject to RBAC. UUID primary keys, UTC timestamp, optimistic `row_version` where mutated.

| Table | Required columns and rules |
|---|---|
| `capability_sources` | `id, tenant_id, source_type, canonical_uri, trust_tier, enabled, metadata_only, owner_id, updated_at`; unique `(tenant_id, canonical_uri)` |
| `skill_packages` | `id, tenant_id, slug, description, origin, created_at`; unique `(tenant_id, slug)` |
| `skill_versions` | `id, package_id, semantic_version, sha256_digest, storage_uri, manifest_json, declared_license, provenance_json, created_by, created_at, state`; unique digest; immutable content, soft-revoke only |
| `agent_definitions` | `id, tenant_id, name, purpose, tool_scope_json, max_privilege, created_at` |
| `agent_versions` | `id, agent_id, sha256_digest, manifest_json, prompt_storage_uri, state, created_at`; immutable |
| `capability_dependencies` | `id, source_version_id, target_kind, target_version_id, pin_digest`; cannot point to mutable latest |
| `validation_runs` | `id, candidate_kind, candidate_version_id, candidate_digest, policy_digest, runner_attestation, result, report_uri, created_at, expires_at` |
| `evaluation_runs` | `id, candidate_version_id, baseline_version_id, benchmark_digest, config_digest, outcome_json, report_uri, status, created_at` |
| `approval_requests` | `id, tenant_id, target_kind, target_version_id, target_digest, permission_digest, policy_digest, evidence_digest, operation, state, expires_at, requested_by, decided_by, decided_at` |
| `activation_bindings` | `id, tenant_id, workspace_id, capability_slug, active_version_id, digest, activated_by, rollback_version_id, revision`; unique `(tenant_id,workspace_id,capability_slug)`, CAS revision |
| `improvement_signals` | `id, tenant_id, source_event_id, capability_version_id, category, severity, evidence_uri, event_time`; unique source event id |
| `improvement_proposals` | `id, tenant_id, target_version_id, problem, expected_change, risk, priority, state, evidence_digest, created_at` |
| `improvement_experiments` | `id, proposal_id, candidate_version_id, baseline_version_id, benchmark_digest, result_digest, approved_at, observed_outcome_json` |
| `product_artifacts` | `id, tenant_id, workspace_id, kind, title, state, body_uri, version, created_by, approved_by, provenance_digest` |
| `product_links` | `id, tenant_id, from_artifact_id, to_artifact_id, relation, created_at`; traceability for decisions, requirements, stories and engineering jobs |
| `audit_events` | reuse existing durable audit/outbox; add relevant event types, never bypass existing signature/redaction controls |

All state-changing actions must use existing transaction/outbox and idempotency patterns. Do not create second authoritative orchestrator or independent ACL system. Separate organization tenant data at query layer and test cross-tenant denial.

## 4. Lifecycle state machines
**Candidate version:** `DISCOVERED -> QUARANTINED -> VALIDATING -> (REJECTED | EVALUATING) -> (REJECTED | AWAITING_APPROVAL) -> APPROVED -> ACTIVE -> (SUPERSEDED | REVOKED)`.
- `APPROVED` is a capability approval, not a runtime grant to arbitrary tools.
- `ACTIVE` requires current validation and evaluation evidence; approval must cover exactly the digest, permission set, policy and target workspace.
- Changed manifest/digest, raised permissions or expired evidence forces a new request.

**Improvement proposal:** `OBSERVED -> TRIAGED -> PLANNED -> CANDIDATE_READY -> EVALUATING -> (REJECTED | AWAITING_APPROVAL) -> (APPROVED | REJECTED) -> MONITORING -> (ACCEPTED | ROLLED_BACK)`.
- Any failure leads to `BLOCKED` with reason and preserved evidence.
- Supervisor may only create/transition its own triage/recommendation states. `APPROVED`, `ACTIVE`, `ROLLED_BACK` are policy-service actions requiring authenticated operator/authorized automation safety rule; supervisor holds no authorization for these.
- Auto rollback may be applied by a **preapproved deterministic policy** on precise failure thresholds and current activation revision; it never activates an unapproved replacement.

## 5. Minimal API contract (v1 `/api/v2` additive endpoints)
| Method | Path | Authorization | Semantics |
|---|---|---|---|
| GET | `/skills` | viewer | Paged active+visible catalog; filter by origin/status |
| POST | `/skills/imports` | operator | Create quarantined import from user-selected root/upload/allowlisted URL; returns candidate id |
| GET | `/skills/{id}/versions` | viewer | Immutable versions and provenance; redact private paths |
| POST | `/skills/candidates/{id}/validate` | operator | Asynchronous isolated validation request |
| POST | `/skills/candidates/{id}/evaluate` | operator | Async benchmark against pinned baseline |
| POST | `/approvals` | operator | Create approval request for digest+permissions+policy+evidence |
| POST | `/approvals/{id}/decision` | approver | Approve/reject with exact current digest, no self-approval |
| POST | `/activations` | authorized admin | Atomic activation with approval id, expected revision, idempotency key |
| POST | `/activations/{id}/rollback` | authorized admin | Revert to previously approved version, or deterministic preauthorized kill-switch path |
| POST | `/capabilities/match` | operator | Explain candidate ranking and qualification checks |
| GET | `/improvements` | viewer | List signals/proposals with status |
| POST | `/improvements/{id}/experiment` | operator | Stage candidate eval, no promotion |
| GET | `/improvements/{id}/comparison` | viewer | Baseline/candidate evidence & uncertainty |
| POST | `/product/workspaces/{id}/artifacts` | editor | Create versioned draft PM artifact |
| POST | `/product/artifacts/{id}/approve` | approver | Approve exact artifact version with owner attribution |
| POST | `/product/artifacts/{id}/handoff` | operator+approver policy | Create engineering job linked to approved epic |

Every mutation requires `Idempotency-Key`, correlation id, CSRF protection where cookie-authenticated, authorization and audit. Return `409` on stale expected revision; `412` on digest or policy mismatch; `403` unauthorized; `422` invalid; `423` policy-blocked; `429` budget/quota; `503` no approved runtime. Long-running processes return `202 Accepted` with status URL; SSE uses existing event gateway. API request/response sketches are in `CONTRACTS/openapi.yaml` and JSON Schema files.

## 6. Approval semantics
For an activation: authenticate independent human approver, prohibit requester self-approval for executable/network permissions, present diff + source + license + risk + tools + test evidence; issue an expiring decision bound to `(tenant, workspace, candidate SHA-256, permission digest, validation evidence digest, policy digest, operation)`; recheck all fields transactionally on use and ensure idempotency. Revocations invalidate active execution leases and prevent new runs. Logs must show old/new hash and actor; never expose source secrets.

## 7. PM workflow contracts
- Meeting record `input source -> attributed extracted claims -> proposed decisions/actions -> human-reviewed decisions -> optional backlog draft`.
- Research `question -> source register (URL/date/access) -> evidence claims -> reliability / limitations -> synthesized finding -> citations`.
- PRD `objective -> problem -> alternatives -> constraints -> success metrics -> scope -> acceptance -> reviewed version`.
- Backlog `approved requirements -> epics/stories -> Gherkin acceptance -> dependency graph -> pending external tracker write approval`.
- Analytics `dataset manifest/hash -> reproducible transform -> KPI calculation -> sensitivity/limitations -> approved recommendation`.
- Handoff includes immutable product artifact version and approver; normal engineering tests/reviews/PR merge gates remain in force.

## 8. Compatibilty strategy
Normalize `SKILL.md` frontmatter and referenced files into internal `SkillManifest`, without rewriting external source. Claude Code native path only where authorized; Codex or local runs require skill compatibility probes and verified tool mappings, never assumed compatibility. For scripts, use strict capabilities with no default network and no host executable access. A model needs specific qualifications for a PM domain or engineering role.
