# v2.2 Security, Approvals and Inference Controls

## Threat model
Adversaries can author internet skill repositories, malicious SKILL.md instructions, shell scripts, symlinks, meeting transcripts, research snippets, prompt content, uploaded archives, dependency manifests, forged tool outputs, and manipulated evaluation examples. Agent outputs and external search results are untrusted. Attacker goals include exfiltration, installing persistent capabilities, bypassing approvals, creating metered inference traffic, data contamination, or granting a new agent production access.

## Approval governance (mandatory)
- No external skill import is directly executable. Catalog search is metadata-only; downloads become quarantined immutable snapshots with hash and provenance.
- No new or updated skill/agent may become active without human approval bound to exact SHA-256 digest and declared permission manifest.
- Require **separate approval** for permissions beyond existing read-only access, new external connectors, subprocess execution, network egress, changes to integration write scopes, and new data classification exposure.
- Creating candidates, running restricted evaluations and collecting de-identified metrics may happen automatically if configured, but never activate.
- Agent prompting, scripts and benchmarks cannot write approval/activation tables. The supervisor cannot approve its own change, select approver, or edit policy.
- Expired approvals/evidence, a modified candidate, new dependency or elevated permissions invalidate approval. Import/update operations are auditable and rollbackable.

## Installation and supply chain
- Pinned source commits and SHA-256 digests; verify licenses and attribution before reuse. If license absent/ambiguous, metadata may be indexed, but source reuse/installation must be blocked pending review.
- Parse archives safely: reject absolute paths, `../`, NTFS alternate data streams, symlink escape, archive bombs, decompression quotas, executable substitution, deeply nested paths and duplicate normalized names.
- Static checks: malformed SKILL.md, dangerous instructions masquerading as policy, embedded secrets, shell injection, broad file operations, hidden model API usage, network endpoints, unpinned dependencies and startup hooks.
- Behavioral tests in sandbox with no secrets or network by default. A SKILL.md can supply instructions but never override system/security policy.
- Keep source trust tier and reviewer identity; trust of a catalog does not transfer automatically to every skill inside it.

## Runtime boundaries
- Existing orchestration remains sole job state authority; all executor requests are scoped by worker lease and version digest.
- Worktrees are not sandboxes. Use verified OS/container/VM confinement, workspace allowlist, restricted UID, process and network caps, no privileged sockets, no cloud metadata access, no production credential mounts.
- No model-provider credentials in skill artifact, prompt log, tool output, UI analytics or execution artifacts.
- A capability manifest enumerates allowed tools, subprocesses, outbound destinations, data scope, time/CPU/memory and artifact-writes. The effective permission set is the intersection of user grant, tenant policy, agent manifest, skill manifest and sandbox capabilities.
- Read-only research is not permission to publish, email, alter GitHub issues, write to Jira/Linear, or approve roadmaps. Separate explicit approval per external write batch.

## AI inference restriction (must be enforced at runner/network boundary)
Allowed: provider-approved official subscription-backed CLI execution for the specific intended automation; qualified local or self-hosted inference. Disallowed: billed AI APIs, token-metered SDK inference, implicit fallback to paid providers, API-key injection for model calls, unauthorized routing of subscription cookies/tokens, any metered AI inference service regardless of hostname. Block common model API variables and endpoints **and** use egress restrictions; list checks alone do not prove enforcement. Cloud VM/compute expense is distinct from model inference expense and needs separate disclosure.

## Evaluation and self-improvement integrity
- Benchmark fixtures immutable with hashes; holdout suites not exposed to candidate-generation agent. Evaluate baseline and candidate on same fixtures and environmental settings; record noise/uncertainty and failure cases.
- Candidate cannot rewrite evaluator, grading rubric, test harness, benchmark set, telemetry, provenance, or approval metadata.
- Do not allow self-reported scores as independent verification.
- Privacy: opt-in telemetry per project, redact sensitive meeting/research data, store minimally necessary error summaries, tenant-isolate dashboards, set retention/deletion policies.
- Rollback cannot introduce an unapproved version. Emergency deterministic disable allowed by a predefined policy; reactivation always requires normal approval checks.

## Required attack cases
Prompt-injection policy override; malicious tool invocation; SKILL.md trying to request API keys; hidden `curl`/fetch destination; symlink/zip traversal; dependency swap; time-of-check/time-of-use digest change; stale approval; self-approval; cross-tenant reads; benchmark overfitting; fabricated evaluation report; supervisor attempts registry write; rollback race; cancellation during activation; quarantine runner process escape; unauthorized external backlog modification. See `TESTS.md`.
