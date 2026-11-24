# Test Plan and Acceptance Matrix

All critical security tests must pass before release, including adversarial multi-project cases. Use synthetic fixtures for security testing and separately record authorized live E2E results.

| ID | Scenario | Pass condition |
|---|---|---|
| T01 | Fresh DB migrations | Existing data intact, new schema migrates idempotently |
| T02 | Source extraction | Every verified claim points to exact source span and digest |
| T03 | Proposed meeting statement | Remains proposed, cannot become approved via LLM |
| T04 | Decision supersession | Current retrieval excludes old authority, historical view available |
| T05 | Hybrid retrieval | Relevant target returned under measured top-k |
| T06 | Index unavailable | Safe lexical fallback or explicit block, no ACL bypass |
| T07 | Embedding model unavailable | Queued indexing and no paid fallback |
| T08 | Budget exhaustion | Explicit budget fallback and omission manifest |
| T09 | Conflict | Both claims represented, not silently merged |
| T10 | Consolidation | All source lineage retained and reversibility test passes |
| T11 | Cross-tenant canary | Zero unauthorized source, metadata or vector disclosure |
| T12 | Cross-project default | No access without explicit grant |
| T13 | Source revocation | Previous memory immediately denied despite stale index |
| T14 | Deletion | Canonical/live indexes/caches/packs invalidated; backup policy documented |
| T15 | Injection payload in memory | Treated only as data, no unexpected tool action |
| T16 | Secret text source | Redacted before memory/embed/log |
| T17 | Duplicate writes | Idempotent content/version behavior |
| T18 | Concurrency | No orphaned records or inconsistent supersession |
| T19 | Crash/restart | Outbox replay/index rebuild and jobs survive |
| T20 | Context manifest | Pinned source digests, token counts, reasons and scope |
| T21 | PM citations | Claim/source agreement in curated labeled suite |
| T22 | Coding workflow | Reusable fix improves or matches baseline tests |
| T23 | Holdout A/B | Quality noninferiority and token analysis published |
| T24 | No metered inference | Runtime policy enforcer detects forbidden routes |
| T25 | SAI-11 proposal | Cannot self-approve or activate |
| T26 | User corrections | Historical lineage preserved, current answer corrected |
| T27 | Browser UX | Inspect/edit/suppress/delete accessible and authorized |
| T28 | Export | Scoped data, audit and provenance present |
| T29 | Context stale after policy change | Authorization rechecked before model call |
| T30 | No-data/hallucination | Missing evidence leads to explicit uncertainty |

## Validation policy
Implement deterministic unit and DB integration tests first. Security/adversarial suites use malicious documents, vector-collision/poison samples, revoked access and multi-tenant fixtures. Tests must also exercise actual existing API authorization and the v2.4 browser frontend. A mock evaluation is not evidence that an actual qualified runtime works.
