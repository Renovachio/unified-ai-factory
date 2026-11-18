# Third-party provenance register

This factory is an **original implementation**. No source, prompts, scripts, UI assets or fixtures are copied from upstream projects.

| Upstream | Status | Basis |
|---|---|---|
| Marshal Factory (github.com/ski043/marshal-factory) | EXCLUDED | No identifiable license seen; treated as all-rights-reserved until verified. |
| Zazen v1 (software-factory-claude-code) | EXCLUDED | Documented as originally unlicensed; no permissions inferred. |
| Zazen v2 (software-factory-claude-code-v2) | EXCLUDED | GPLv3 / commercial; requires legal review before any incorporation. |

Incorporation requires an entry in `licenses/upstream-approvals.yaml` (path, content sha256, pinned upstream commit, license, approver). CI (`bun run license`) fails on unapproved references.

Third-party packages: see `licenses/allowlist.yaml` (exact versions, license, approver). An SBOM (CycloneDX) is produced by `bun run license -- --sbom <path>`.

Legal status: not legal advice; counsel review of GPLv3 obligations and provider subscription terms remains an operator action (see ADR 0001).
