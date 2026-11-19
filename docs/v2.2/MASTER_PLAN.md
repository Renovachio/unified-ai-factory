# v2.2 Master Implementation Plan

## Purpose
Extend the existing software factory into a **Product & Software Factory** with a **Skill & Agent Intelligence System** (SAI-01–SAI-11). The factory supports PM/PO discovery, meetings, research, strategy, PRDs, backlog, analytics, launch, and engineering handoff. It must detect capability gaps, discover alternatives, safely develop candidate capabilities, run evaluations, and propose improvements over time **without ever self-approving activation**.

## Baseline and assumptions
- Existing TypeScript/Bun monorepo uses `apps/{api,web,runner}` and `packages/{domain,db,orchestrator,scheduler,agents,runtimes,sandboxes,checks,scm,telemetry,...}`; verify exact checkout rather than assuming paths.
- v2.1 is a prerequisite for real execution: an authorized model runtime, isolation, human approvals, durable evidence, and stable GitHub integration. Documentation can proceed before runtime qualification; activation cannot.
- User-provided Claude skills are not currently inventoried. Discovery supports opt-in import from official installation directories; never assume folders or permissions exist.
- This package is a proposed implementation specification, not a statement that repository changes have been made or tested.

## Non-negotiable invariants
1. Approved skill and agent versions are immutable and content-addressed (SHA-256); executions pin those versions.
2. Discovery, candidate generation, sandbox evaluation and evaluation-report creation may run without approval **only inside restricted environments**. Installation/activation/replacement requires explicit user approval bound to exact digest, scope and capability set.
3. New tools/commands, network destinations, credentials, file writes outside candidate sandbox, and changes to policy require distinct explicit grants; no inferred authority.
4. No agent or skill can approve its own release, modify its approval records, edit risk policies, create merge credentials, or access production deployment secrets.
5. Inference: `subscription_cli` (only if provider terms explicitly permit intended orchestration) or `local_model` (qualified) only. Never paid model APIs, metered inference SDKs, unauthorized subscription-token forwarding, or automatic paid fallbacks. Cloud **infrastructure** costs must be separately disclosed.
6. PM evidence is attributable; outputs distinguish observations, decisions, assumptions and recommendations. No automatic conversion of meeting speculation into approved backlog work.
7. Failed evaluation, insufficient sample, unavailable independent reviewer, missing legal grant, or untrusted source => reject/hold; never fabricate success.
8. Improvement supervisor cannot change production skills/agents/code; all promotions go through approval + registry CAS/policy check.
9. Block duplicate/outdated approvals; rescind when digest, permission manifest, source or relevant evaluation/policy changes.
10. Preserve existing factory paths, API/database contracts and migration integrity; add modules rather than rewrite.

## New components & ownership
| Component | Planned integration | Responsibility |
|---|---|---|
| Skill inventory SAI-01 | `packages/skills/inventory` | Enumerate installed/project skills with opt-in roots, provenance and scope |
| Skill discovery SAI-02 | `packages/skills/discovery` | Search approved source adapters, cache metadata, pin content digests |
| Capability matcher SAI-03 | `packages/capabilities/matcher` | Identify skill/agent requirements, rank qualified candidates, explain routing |
| Gap analyzer SAI-04 | `packages/capabilities/gaps` | Detect missing/insufficient capabilities from failure evidence |
| Skill creator SAI-05 | `packages/skills/creator` | Scaffold new candidate SKILL.md, supporting files and tests in quarantine |
| Agent designer SAI-06 | `packages/agents/designer` | Propose agent manifests, role boundaries and skills/tools |
| Validator SAI-07 | `packages/skills/validator` | Schema, licensing, secrets, script/network and behavioral checks |
| Registry SAI-08 | `packages/skills/registry` + `packages/db` | Immutable versions, approval state machine, pins and rollback |
| Quality evaluator SAI-09 | `packages/evals` extension | Role-specific held-out benchmarks; baseline vs candidate paired results |
| Improvement engine SAI-10 | `packages/improvements/engine` | Generate improvement hypotheses and candidate diffs based on evidence |
| Improvement supervisor SAI-11 | `packages/improvements/supervisor` | Observe, dedupe, prioritize, orchestrate proposals, request approvals, track outcomes |
| PM workspace | `apps/web`, `apps/api`, `packages/product` | Meeting/research/PRD/story/backlog/analytics objects with provenance |

Paths are target suggestions, not claimed existing paths. Follow repo conventions where different.

## Release train and dependencies
**Phase 0: Preconditions (v2.1)** — Required security, provider and sandbox gates are proven; any blocked gate is explicitly documented.

**Phase 1: Safe inventory (no execution)** — SAI-01, SAI-02 (metadata-only, pinned sources), SAI-07 (static), SAI-08 registry + approval transitions. Demonstrate malicious import rejection and digest-bound approvals.

**Phase 2: Capability reasoning** — SAI-03/04; create PM domain manifests; show transparent routing and unsupported-capability responses.

**Phase 3: Candidate factory** — SAI-05/06; generate staged skill/agent definitions, no auto-activation; qualification by SAI-07/09.

**Phase 4: PM domain workflows** — Meeting intelligence, research, strategy/PRD, backlog, analytics and approved engineering handoff. Build artifacts with sources and separation of draft vs approved states.

**Phase 5: Learning loop** — SAI-10 produces evidence-backed candidate experiments; SAI-11 monitors and prioritizes proposals, evaluates candidate vs active baseline, requests human approval, tracks post-promotion results.

**Phase 6: Final end-to-end pilot** — Import one real user-supplied Claude skill with permission, find/create one missing capability, create draft PM artifacts, get explicit approval, release an approved epic to the existing software factory, deliver a draft PR, roll back a deliberately bad skill candidate.

## SAI work orders
| ID | Deliverable | Dependencies | Key exit |
|---|---|---|---|
| SAI-01 | Inventory & opt-in import | v2.1 auth | Existing skills indexed without executing code |
| SAI-02 | Search/catalog adapters | SAI-01, SAI-07 | Candidate sources pinned with provenance |
| SAI-03 | Capability matching | SAI-08, SAI-09 metadata | Matching is explainable and permission-aware |
| SAI-04 | Gap analysis | SAI-03 | Missing capabilities identified without speculative installs |
| SAI-05 | Candidate skill generation | SAI-04, SAI-07 | Valid staged skill never auto-activated |
| SAI-06 | Candidate agent design | SAI-04, SAI-07 | Distinct agent rationale, scope and resource limits |
| SAI-07 | Security & quality validation | v2.1 sandbox | Unsafe artifacts fail closed |
| SAI-08 | Registry + approvals | v2.1 auth/db | Digest-bound approval and atomic activation |
| SAI-09 | Evaluation harness | SAI-07/08 | Candidate and baseline compared fairly |
| SAI-10 | Improvement engine | SAI-04/09 | Evidence-supported candidate proposals |
| SAI-11 | Continuous Improvement Supervisor | SAI-08/09/10 | No privileged action; approval workflow, monitoring and rollback |

## PM/PO capability tracks
| Track | Inputs | Artifacts | Required gate |
|---|---|---|---|
| Meetings | Transcript/notes, participants, permissions | Minutes, decision log, action proposals | Human confirms decisions/owners before external writes |
| Research | Questions, market scope, approved sources | Evidence ledger, competitor matrix, assumptions, synthesis | Citation and freshness check; no invented facts |
| Strategy | Objectives, research, constraints | Opportunity statements, OKRs, RICE/ICE scenarios, roadmap candidates | Human product-priority decision |
| Documentation | Product idea, outcomes, constraints | PRD, use cases, NFRs, Gherkin acceptance criteria | Human approves baseline version |
| Backlog | PRD, team capacity, existing items | Epics, stories, dependencies, estimates as uncertain | Explicit permission and review before writes to tracker |
| Analytics | Approved datasets + metric definitions | KPI analysis, anomaly hypotheses, experiment report | Dataset provenance, permissions, reproducible computations |
| Delivery | Approved epic, handoff contract | Engineering intake linked to product decisions | Explicit authorized handoff; existing software release gates apply |

## Detailed milestone gates
- **G0 Provider & isolation:** subscription use documented permitted or qualified local model; no unapproved model API; sandbox tested.
- **G1 Trust registry:** inventory and catalog discovery cannot run fetched scripts; immutable manifests, approvals, revocation and rollback work.
- **G2 Candidate lifecycle:** every candidate passes static and behavioral evaluation; failed candidate cannot activate.
- **G3 PM correctness:** PM results cite inputs, flag unknowns, preserve owner/date uncertainty, request approval before backlog changes.
- **G4 Learning loop:** failed outcome can create proposal, run baseline-vs-candidate eval and request approval, while supervisor has zero promotion rights.
- **G5 Operations:** all state transitions durable and auditable; retry idempotent; revoke/rollback restores last good version.
- **G6 End-to-end:** one successful and one adversarial scenario with recorded real evidence; no deployment claim from mocks.

## Required final implementation evidence
For each task: implementation commit, changed paths, test commands/results, static scan, approval proof where appropriate, model routing proof, migration proof, screenshots or API traces of key user operations, known gaps. Do not record fabricated benchmark improvements. Record schema/contract version and pinned skill/agent digest for each run.

## Explicit scope exclusions
No automated policy changes; no autonomous subscriptions billing or paid model inference; no unreviewed internet skill installation; no guarantee that Claude skills are executable in Codex/local models without compatibility qualification; no automatic publication of private meeting notes or analytics.
