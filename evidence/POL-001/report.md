# POL-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-19
- **Candidate SHA:** b120c57a7ddd88d16db15532c053b44a36da2dfa (branch dev/pol-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44437751587
- **Test totals:**  735 pass  0 fail 
- **Accepted by:** operator, via instruction to continue following the plan to completion (2026-11-18); no separate human code review has occurred.

## Local commands (clean frozen install)
| Command | Exit |
|---|---|
| `bun install --frozen-lockfile` | 0 |
| `python3 scripts/validate_package.py` | 0 |
| `bun run license` | 0 |
| `bun run lint` | 0 |
| `bun run typecheck` | 0 |
| `bun test` | 0 |
| `bun run build` | 0 |

## Files changed in this task
- `bun.lock`
- `config/risk-policy.json`
- `packages/agents/src/index.ts`
- `packages/agents/src/policy-port.ts`
- `packages/agents/tests/policy.test.ts`
- `packages/domain/package.json`
- `packages/domain/src/index.ts`
- `packages/domain/src/policy.test.ts`
- `packages/domain/src/policy.ts`
- `packages/orchestrator/src/orchestrator.ts`

## Notes
- Policy engine (`@factory/domain` `policy.ts`, pure, no I/O) + factory-owned `config/risk-policy.json` (strict schema; digest = approval-binding input). `assertPolicyInvariants` REFUSES at load time any config that would allow unattended HIGH/CRITICAL merges (allowlist containing them, humans not required for them, two-person outside the human set, auto-merge enabled during the pilot).
- Minimum-risk overrides: `classifyPaths` (strictest matching rule wins; unmatched paths default to MEDIUM, never LOW by omission). `evaluatePolicy` takes floors from paths, intake text, spec, the job's ratcheted risk and a model proposal, and returns max(...): a model can only RAISE. Unknown everything => CRITICAL. **Uncertain classification escalates**: signals (diff unavailable/truncated/too many files, binary, mode change, symlink, submodule, rename across boundary, intake unclassified) force at least HIGH with the reason recorded.
- Merge eligibility (`autoMergeEligible`) requires ALL of: auto-merge enabled, pilot off, risk in the allowlist and not HIGH/CRITICAL, classification certain, gate passed and bound to the exact head, all required reviews passed, calibration. Tested exhaustively: 2 configs x 5^4 floor combinations x 3 signal sets x 4 file sets (30,000 evaluations) — HIGH/CRITICAL are never eligible and always need a human, uncertainty implies >= HIGH, risk >= every floor, a model proposal never lowers risk, the shipped pilot policy never auto-merges; plus 10 single-condition flips each remove eligibility with a stated blocker.
- `assessMerge` (for MRJ-001): server-side check with FRESH facts: open, non-draft PR; policy digest unchanged; approvals must be `approve`, non-stale under the 8-field evidence binding, and younger than `approvalMaxAgeMinutes`; any rejection of this exact candidate blocks; CRITICAL needs two DISTINCT approvers, neither the requester; a decision that WRONGLY claims auto-eligibility for HIGH/CRITICAL still cannot merge without a human approval.
- Orchestrator integration: `createPolicyPort` derives every input from DURABLE evidence (candidate descriptors/patches, traceability, intake decision, gate rows, review rows). Risk is now re-assessed from the ACTUAL candidate at GATING -> REVIEWING (before reviewers are routed) and again at PREMERGE; `ratchetRisk` only raises (the DB trigger from 0005 enforces it). Tests: docs-only LOW still ineligible (pilot) with code reviewer only; package.json => HIGH => security reviewer added BEFORE review; workflows => CRITICAL => code+security+performance; a symlink in a docs path => HIGH via uncertainty; intake hint CRITICAL raises, intake hint LOW cannot lower a HIGH path; a hypothetical permissive policy still yields ineligible HIGH and the DB CHECK rejects an eligible HIGH/CRITICAL decision.
- Design note surfaced by a test: an intake agent that omits `risk_hint` yields a MEDIUM floor (`effectiveRisk` treats a missing proposal as unknown), so a LOW outcome needs an explicit LOW hint plus LOW deterministic signals.
- Next: MRJ-001.
