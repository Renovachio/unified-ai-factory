# Copy/Paste Prompt for Coding Agent

Implement the attached Unified AI Factory v2.5 Adaptive Memory package **additively** in the currently checked-out repository.

First audit the real codebase and existing v2.1/v2.2/v2.4 implementation against `README.md`, `PRODUCT_PLAN.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `SECURITY.md`, `EVALUATION.md`, `AGENTS.md` and all `TASKS/MEM-xx.md`. Create a truthful gap/reuse matrix; do not duplicate functionality or assume that previous engineering specifications have already been implemented.

Proceed by implementing MEM-01 through MEM-08, respecting dependencies and blocking security gates. Use existing PostgreSQL, ORM/migrations, orchestrator, API auth, event bus, artifact store and browser UI. Build source-linked, permission-scoped canonical memory; conservative extraction; hybrid retrieval; bounded context packs; traceable consolidation; feedback/SAI-11 proposals; visible correction/delete controls; and measured quality/token evaluation. Implement deterministic and adversarial tests. Preserve v2.4 localhost/browser security and subscription-or-qualified-local-only inference restrictions. Do not introduce metered AI APIs.

For each task report exact files, commits, test commands/output, baseline comparison, security evidence, known gaps. Never claim a workflow completed unless it was validated with a real permitted runtime and source-grounded evidence. Do not self-approve agent/skill improvements or merge high-impact changes.

The product must demonstrate fewer repeated context tokens **without worse factual or task quality**; if the evaluation does not demonstrate that, block activation and report why.
