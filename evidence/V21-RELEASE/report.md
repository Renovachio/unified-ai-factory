# v2.1 release checklist — **NOT READY**

Recorded honestly per the plan ("Record NOT READY if gates fail"). Auto-merge remains disabled (kill switch engaged, no repository opted in).

| Gate | Status | Evidence | Owner / what is needed |
|---|---|---|---|
| ACT-01 runtime activation | `blocked` | `evidence/ACT-01/report.md` | Operator: provider-terms decision, or a role-qualified local model |
| ACT-02 E2E coding pilot | `blocked` | `evidence/ACT-02/report.md` | Operator: qualified builder, disposable repo, reviewer |
| ACT-03 live GitHub | `blocked` | `evidence/ACT-03/report.md` | Operator: GitHub App + test repo |
| ACT-04 dashboard auth | `in_progress` | `evidence/ACT-04/report.md` | Operator: real OIDC IdP; browser E2E |
| ACT-05 security hardening | `in_progress` | `evidence/ACT-05/report.md` | Operator: per-component LOGIN roles; Linux/cloud enforcement evidence |
| ACT-06 model qualification | `blocked` | `evidence/ACT-06/report.md` | Dataset owner: >= 30 samples/role + holdout; run candidates; operator approval |
| ACT-07 reliability | `in_progress` | `evidence/ACT-07/report.md` | Engineering: dead-letter, diagnostics, fault injection, CI watcher |

## What is genuinely verified (locally, CI-green: 1136 tests)
Sandbox confinement (Seatbelt on macOS; bwrap in CI), egress denial, secret isolation, redaction hardening, DB privilege separation proven by a real runner role, OIDC code+PKCE against a **fake** issuer, tool loop against a real local model for a trivial task, evaluator leakage fix, and the v2.2 registry/approval/supervisor controls.

## Residual gaps
No qualified model; no approved provider terms; no live GitHub; no real IdP or browser test; eval datasets too small; reliability gaps listed in ACT-07; operator ratification of proposed dependency approvals and the LGPL exception outstanding; "Accepted by" in PROGRESS.md means the operator said continue, not independent review.

**Decision: NOT READY for any real use.** Re-evaluate when ACT-01..03 unblock.
