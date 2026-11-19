# v2.2 Test Strategy and Release Acceptance

## Test layers
1. **Unit:** parsing, hashing, manifest validation, matching, gap deduplication, scoring, schema guards, state transitions.
2. **Contract:** JSON Schema/OpenAPI inputs, API status semantics, `Idempotency-Key`, digest mismatch and optimistic revision errors.
3. **Integration:** migrations, transaction/outbox, registry CAS activation, approval invalidation, job version pinning, store access boundaries.
4. **Adversarial:** malicious archives and scripts, injection, path/network escapes, credential access, stale proof, model API egress, cross-tenant data.
5. **Evaluation:** paired baseline/candidate fixture suites, hidden holdout, role-specific PM/engineering rubrics, manual sampled review and uncertainty.
6. **E2E:** real imported skill (with explicit permission), missing capability, candidate generation, evaluation, human approval, PM workflow, approved engineering handoff and reviewed draft PR. Separate fake-service tests from real ones.
7. **Fault injection:** worker death, duplicate callbacks, approval race, disconnect during activation, DB restart, stale worker lease, registry revocation mid-run.

## Acceptance test identifiers
| ID | Scenario | Pass condition |
|---|---|---|
| T-01 | User opt-in inventory | Only selected directories indexed; scripts never run |
| T-02 | External metadata discovery | Pinned metadata, source URI, digest and license state recorded |
| T-03 | Unknown license | Install/activation blocked pending review |
| T-04 | Malicious ZIP | Traversal/symlink/bomb rejected, zero workspace escape |
| T-05 | Skill duplicate | Hash equality merges references, never mutates active version |
| T-06 | Candidate validation | Bad manifest/scripts rejected, exact reasons surfaced |
| T-07 | Approval mismatch | Different hash/permissions/policy causes 412 or equivalent block |
| T-08 | Self-approval | Requester/agent cannot approve own executable promotion |
| T-09 | Revocation during run | New runs blocked; active leases revoked per policy |
| T-10 | No paid inference | Attempt Anthropic/OpenAI/other billed endpoint blocked at egress and policy |
| T-11 | Subscription blocked | Missing provider evidence fails closed; no API fallback |
| T-12 | Compatibility | Claude-specific skill rejected for noncompatible runtime unless adapted/tested |
| T-13 | Match explanations | Unqualified model and unapproved skill never appear as executable routes |
| T-14 | Gap detection | Repeated missing capability deduped; no automatic install |
| T-15 | New skill creation | Candidate in quarantine, tested, cannot activate without approval |
| T-16 | New agent creation | Agent has bounded tools and role rationale; no extra privileges |
| T-17 | PM evidence | Meeting decisions and research claims cite inputs, uncertainties flagged |
| T-18 | Backlog writes | Only approved artifacts and explicit tracker write grants mutate tracker |
| T-19 | Analytics provenance | Dataset digest and computation version reproducible, raw data scoped |
| T-20 | Paired eval | Identical benchmark/environment, report records confidence and regressions |
| T-21 | Benchmark gaming | Candidate cannot access holdout/modify grader; low confidence blocks promotion |
| T-22 | Supervisor unauthorized write | Supervisor cannot modify activation, approval, policy or benchmark records |
| T-23 | Improvement proposal | Weak output generates hypothesis, candidate, evidence and approval request only |
| T-24 | Failed candidate | Rejected candidate leaves active version unchanged |
| T-25 | Approved promotion | Exact SHA activated atomically; pinned existing executions unchanged |
| T-26 | Regression rollback | Preapproved kill switch disables faulty version or rolls back to approved last good; complete audit |
| T-27 | Recovery | Duplicate queued job and crash lead to one authoritative outcome |
| T-28 | Tenant isolation | Neither skills, telemetry nor meeting artifacts cross tenant scope |
| T-29 | E2E skill lifecycle | Discover/import -> validate -> evaluate -> approve -> activate -> execute -> audit |
| T-30 | E2E PM-to-code | Meeting/research -> PRD -> approved epic -> isolated code -> reviewed draft PR |

## Qualification gates
- New skill/agent **must** pass schema, static security and permission checks; license and provenance review complete.
- Role-specific quality thresholds are established on representative datasets and compared to an existing approved baseline. No aggregate score may mask critical safety regressions.
- Require statistically meaningful samples or report uncertainty and block activation for insufficient evidence. Track false positives, false negatives and task completion, not just subjective LLM grading.
- Active skill/agent versions are pinned. Evaluation reports include code version, model/harness version, fixture hash, dates, test commands and artifact digest.
- No claim of live readiness without authorized live provider, authentic GitHub test and PM dataset permissions.

## Release go/no-go
All T-01–T-30 must pass at their appropriate test layer, with **T-10, T-11, T-22, T-24, T-25, T-26 and T-30** demonstrated independently of mocks. External credentials or legal reviews not available => record explicit blocker and do not declare production-ready. No unattended changes to active capabilities. Human approval enforced throughout v2.2.
