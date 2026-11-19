# SAI-01 — Skill Inventory and User Imports

**Status:** NOT IMPLEMENTED / proposed work order
**Dependencies:** v2.1 auth, sandbox and RBAC
**Target modules:** `packages/skills/inventory; apps/api skills imports; apps/web inventory`
**Default governance:** candidates may be evaluated in quarantine; activation requires independent human approval.

## Implementation steps
1. Enumerate explicitly approved local roots, repository .claude/skills trees and user-uploaded archives; never read hidden private roots without consent.
2. Parse SKILL.md frontmatter and references into a normalized metadata manifest with source URI, path, scope, file list and SHA-256 digest.
3. Copy source to read-only quarantine after bounds checks; classify untrusted scripts/hooks and redact filesystem locations from other users.
4. Implement preview/import flows, duplicate detection, origin tracking and revocation of an inventory source.

## Deliverables
- Source implementation in `packages/skills/inventory; apps/api skills imports; apps/web inventory` (adapt paths to actual repository conventions).
- Typed interfaces and JSON Schema contracts; additive migration only where persistent state is needed.
- Unit, integration, adversarial, and end-to-end evidence appropriate to this component.
- Updated operator documentation, failure modes, audit events and PROGRESS.md.

## Acceptance criteria
- [ ] User selects an existing Claude skill folder and sees its name and dependencies without anything running.
- [ ] Unapproved directories and archive traversal cannot be read.
- [ ] A duplicate digest does not overwrite approved versions.

## Required tests
- `T-01`
- `T-04`
- `T-05`
- `T-28`

## Stop conditions
- Missing provider authorization, failed sandbox proof, invalid license, prohibited model API usage, unverified evaluation, or unavailable independent approval => **BLOCKED**, not completed.
- Do not weaken tests/policies, auto-activate candidates, or report mock tests as real integration.

## Completion evidence template
- Implementation commit / diff:
- Test commands and passing output:
- Security / inference routing proof:
- Approval and artifact digests (if applicable):
- Remaining limitations and next dependency:
