# Threat model (baseline, M0)

| Threat | Control | Task |
|---|---|---|
| Malicious issue / README prompt injection | Untrusted input quoted as data; policy from factory config only | INT-001 |
| Malicious dependency / package script | Exact pins, license+forbidden-package gate, sandboxed execution | LIC-001, RUN-001 |
| Compromised worker / stale worker | Leases + monotonic fencing tokens | SCH-001 |
| Stolen / over-scoped GitHub token | Installation-scoped tokens; merge credential separate from runner | SCM-001, MRJ-001 |
| Stale approval / TOCTOU | Approval bound to head/base/policy/check digests; re-fetch before merge | POL-001, MRJ-001 |
| Event / webhook replay | `(provider, delivery_id)` unique; HMAC verification | SCM-001, EVT-001 |
| Paid inference / credential extraction | Forbidden env keys, SDK denylist, auth-mode allowlist | LIC-001, AGT-* |
| Model hallucination / reviewer collusion | Schema-validated outputs; deterministic gates; reviewers bound to SHA | REV-001 |
| Cloud sandbox escape | Opt-in, parity tests, egress allowlist | CLD-001 |
