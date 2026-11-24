# Rollout and Migration Strategy

## Stage M0 — Baseline
Audit actual current repo; inventory state and existing project/knowledge tables; capture current prompt size, task accuracy, storage use and integration status. Validate v2.1 live runtime and v2.4 browser trust gates; no hidden new inference capability.

## Stage M1 — Memory substrate (MEM-01/02)
Add schema, source-linked write pipeline and deterministic extraction. Enable writes only in an explicitly selected test project, no retrieval injection. Test migrations, scoping, deletion and recovery.

## Stage M2 — Read-only shadow retrieval (MEM-03/04)
Build candidate retrieval and context packs, but continue giving model baseline context. Log hypothetical token savings, retrieval precision and stale/confidential candidates. Verify no PII or authorization leakage in logs. Shadow traffic cannot spend on an unapproved model.

## Stage M3 — Controlled evaluation (MEM-05/06/08)
Enable retrieved packs in isolated evaluation jobs and selected opt-in pilot projects. Compare with baseline. Require independent approval before expanding. Keep quick switch to baseline when benchmark degrades.

## Stage M4 — User-facing control (MEM-07)
Ship browser Memory & Evidence views, corrections, explicit sharing controls, retention/deletion. Verify screenreader/keyboard and all relevant v2.4 browser security controls.

## Stage M5 — Supervised improvement
Connect evidence to SAI-11 proposal queue. Candidate improvements require new evaluation and human promotion. Do not autowrite production registry.

## Rollback
Toggle off retrieval/context injection and use prior authoritative direct context path while preserving canonical memory data. Invalidate a bad index/config by version. Never roll back destructive SQL migrations by dropping user data. Suspended memory writer/reindexer must not affect orchestrator job state or render PM dashboards untruthful.
