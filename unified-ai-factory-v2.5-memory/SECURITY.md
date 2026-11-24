# Memory Security, Privacy, Permissions and Threat Model

## Threats
Cross-project exfiltration; prompt injection via remembered content; poisoning through fake sources or approvals; inference of confidential facts from vector queries; stale authorization; embedding/cache leakage; accidental ingestion of secrets; irreversible deletion inconsistencies; search query abuse; poisoning of SAI-11 feedback; unauthorized extension of context across projects.

## Required controls
1. Each retrieval begins with authenticated actor and known tenant/project/purpose. Source permissions are checked on **every** candidate at read time, including after cross-document rerank. No security reliance on vector similarity alone.
2. Source metadata and provenance accompany every asserted memory. Tool output, imported documents and memories are untrusted data. No memory may override system/developer policy or directly issue tool instructions.
3. Memory scope opt-in defaults: within the current project; cross-project sharing disabled. Private meeting/transcript ingestion requires applicable user permission and source policy.
4. Never extract passwords, tokens, cookies, signing material or unfiltered credentials into memory or embeddings. Redact before indexing and audit prompt injection/secret scanning results.
5. Status transitions from `proposed` to `approved` require authoritative authenticated domain events; LLM output is not an approval artifact.
6. Keep deletions and revocations authoritative even if background index is temporarily unavailable: read path checks tombstones and source ACL before exposing content.
7. Encryption at rest/transit per existing threat model; do not introduce a new remote vector service by default. Audit data exports, bulk reads and memory permission changes.
8. Context/embedding caches partition by tenant, project, actor authorization and data version. TTL does not substitute for active invalidation after revocation.
9. Memory quality tests must include canary cross-tenant corpora, malicious injection strings, contradictory claims, revoked approvals, and deleted sensitive entries.
10. Improvement supervisor cannot approve its own evaluation, modify policy, permissions, security checks or skill activation.
11. Same v2.4 inference policy: only explicitly authorized subscription CLI automation or qualified local/self-hosted models; no usage-billed model APIs.

## Browser controls
Memory views reuse v2.4 session auth, CSRF, Origin/Host and loopback network requirements. Returned snippets are safely encoded and authorized; downloadable exports require separate access and logging. Do not expose source or embedding database through raw browser SQL/search endpoints.

## Privacy and consent
Provide review, export, suppress, correct, forget and retention controls. Default memory capture should be transparent and configurable per workspace. Honor source deletion and downstream index cleanup. Define explicit limits for telemetry retention and prevent raw personal source content from being stored in observability traces.
