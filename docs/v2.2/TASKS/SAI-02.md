# SAI-02 — Skill Discovery and Catalog Sources

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** SAI-01, SAI-07 static validator
**Target modules:** `packages/skills/discovery; config/skill-sources.json; apps/web search`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Implement adapters for approved Agent Skills standard registries, official vendor catalogs, GitHub repository metadata and user-entered repository URLs.
2. Use read-only indexed metadata and verified snapshots; pin upstream commit/content SHA and record license, update time, trust tier and review status.
3. Display exact capability match rationale, dependency requirements and install restrictions; no unattended downloads that execute scripts.
4. Mark catalog entries unverified until fetched, scanned and license-reviewed; absence of a license prohibits code reuse.

## Deliverables
- Source implementation in `packages/skills/discovery; config/skill-sources.json; apps/web search` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] Search finds candidate skills without activating them.
- [ ] All displayed sources and versions have canonical URI and provenance.
- [ ] Unlicensed/unsafe or unreachable source remains blocked, never silently replaced.

## Required tests
- `T-02`
- `T-03`
- `T-04`

## Stop conditions
- Missing provider authorization, failed sandbox proof, invalid license, prohibited model API usage, unverified evaluation, or unavailable independent approval => **BLOCKED**, not completed.
- Do not weaken tests/policies, auto-activate candidates, or report mock tests as real integration.

## Completion evidence template
- Implementation commit / diff:
- Test commands and passing output:
- Security / inference routing proof:
- Approval and artifact digests (if applicable):
- Remaining limitations and next dependency:
