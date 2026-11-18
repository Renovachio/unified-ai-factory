# FND-001 evidence report

- **Status:** READY_FOR_REVIEW (not ACCEPTED — requires reviewer/operator sign-off)
- **Date:** 2026-11-18
- **Dependencies:** none
- **Candidate SHA:** cce82efb8eb9ca530a78a090cee2e05c29314460 (branch dev/fnd-001, pushed to origin; GitHub CI not yet confirmed)

## Files added
`package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.base.json`, `eslint.config.mjs`, `.github/workflows/ci.yml`,
`apps/web/{package.json,tsconfig.json,next.config.mjs,app/layout.tsx,app/page.tsx}`,
`packages/domain/{package.json,tsconfig.json,src/index.ts,src/index.test.ts}`.

## Commands (clean `node_modules`, Bun 1.4.4)
| Command | Exit |
|---|---|
| `bun install --frozen-lockfile` | 0 |
| `python3 scripts/validate_package.py` | 0 |
| `bun run lint` (eslint, typescript-eslint strict) | 0 |
| `bun run typecheck` (tsc strict, both workspaces) | 0 |
| `bun test` (2 pass, 0 fail) | 0 |
| `bun run build` (next build + tsc) | 0 |
| `bun run ci` (all of the above) | 0 |

Artifact hashes (sha256): bun.lock `fe87f94f…aa4112`, package.json `62f77b47…a345`.

## Notes / decisions
- All dependency versions pinned exactly. TypeScript pinned to 6.0.3 because typescript-eslint 8.73.0 rejects TS 7.0 (first lint run failed; fixed by pin, not by skipping lint).
- Bun was not installed on host; verified using a project-external Bun 1.4.4 from npm. CI uses `oven-sh/setup-bun` at 1.4.4. CI workflow itself has NOT been run (no remote).
- Rule `@next/next/no-html-link-for-pages` disabled (app router, no `pages/`).
- `packages/domain` holds only the allowed-inference-modes / forbidden-env constants with tests; no agent execution implemented.

## Security checks
No API keys, no inference SDKs, no network inference. Dependencies are dev/build tooling and Next/React only. Next.js telemetry is on by default; consider `NEXT_TELEMETRY_DISABLED=1` in CI.

## Remaining risks
CI unverified on GitHub; no candidate SHA; npm install scripts for deps not reviewed (LIC-001 covers license/provenance).

## Reviewer / sign-off
Pending. **Next task:** LIC-001 (after FND-001 accepted).
