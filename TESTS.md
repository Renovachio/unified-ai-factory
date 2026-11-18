# Factory verification matrix

## Package
`python3 scripts/validate_package.py` validates task graph, schemas, prohibited billing strings in executable configuration, and essential files. It **does not** validate a built application.

## Engineering gates
For each work order: frozen install, lint, strict typecheck, unit tests, package build, contract suite, changed-module integration suite and scan. Preserve exit codes and hashes in evidence. CI owns authoritative commands after FND-001.

## Required negative scenarios
- Model API credentials present in runtime environment or config → refuse run, no network call.
- Subscription quota exhausted → pause or approved local fallback, never API billing.
- Subscription terms uncertain → disable adapter, never extract tokens.
- Local model offline → structured pause, never use paid hosted endpoint.
- Prompt injection in issue/README → cannot override policy.
- Malicious repo test → no host filesystem, secret or network escape.
- Expired worker lease or fencing token → cannot report or commit state.
- Changed head/base/policy/checks → prior approval invalidated.
- Unsigned GitHub webhook → rejected; replay deduplicated.
- Concurrent duplicate create request → one job.
- Review fails or schema invalid → merge blocked.
- HIGH/CRITICAL change → human approval forever.
- Cloud worker requests login token → reject and quarantine.
- Crash at each orchestration stage → durable replay with no untracked side effects.

## E2E pilot before autonomy
At least 30 representative tasks across 3 repositories, 10 seeded faults and 5 high-risk negative controls. Manual merge policy during pilot. Produce a sign-off report and rollback plan. Never claim product readiness merely because mock tests pass.
