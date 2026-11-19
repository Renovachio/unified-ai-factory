# LIC-001 evidence report

- **Status:** ACCEPTED
- **Date:** 2026-11-18
- **Candidate SHA:** f38a701b2863fd80f2f0f3a6c76b2a8f1e5a4deb (branch dev/lic-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44421135275
- **Test totals:** 
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
- `.github/workflows/ci.yml`
- `PROGRESS.md`
- `apps/web/tsconfig.tsbuildinfo`
- `bun.lock`
- `docs/adr/0001-original-implementation-and-inference-policy.md`
- `docs/security/threat-model.md`
- `docs/third-party/PROVENANCE.md`
- `licenses/allowlist.yaml`
- `licenses/upstream-approvals.yaml`
- `package.json`
- `packages/checks/package.json`
- `packages/checks/src/index.ts`
- `packages/checks/src/license/allowlist.ts`
- `packages/checks/src/license/check.ts`
- `packages/checks/src/license/index.ts`
- `packages/checks/src/license/spdx.ts`
- `packages/checks/tests/license.test.ts`
- `packages/checks/tsconfig.json`
- `scripts/license-check.ts`

## Notes
- Gate: `bun run license` (packages/checks/src/license). Fail-closed on: unapproved/unpinned/forbidden direct deps, non-allowlisted licenses of any installed package, missing install, upstream markers/vendoring/submodules without hash-bound approval, direct inference-SDK imports, missing provenance.
- Negative tests (packages/checks/tests/license.test.ts) prove an unapproved dependency and an upstream source import fail the gate.
- SBOM (CycloneDX 1.5) generated at evidence/LIC-001/sbom.cdx.json in CI and locally.
- M0 docs delivered: docs/adr/0001, docs/third-party/PROVENANCE.md, licenses/allowlist.yaml, docs/security/threat-model.md.
- **Operator decision recorded:** exception for `@img/sharp-libvips-*` (LGPL-3.0-or-later, optional Next.js dependency). Legal review of LGPL obligations remains pending.
- Dependency approvals in allowlist.yaml are labelled "PROPOSED by agent - operator ratification pending"; the ratification is an open operator action.
- Remaining risk: provider-terms approval for subscription CLIs (AGT-002/003) and legal review are not done.
- Next: DOM-001.
