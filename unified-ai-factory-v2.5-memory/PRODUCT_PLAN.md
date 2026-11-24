# Product Plan — Adaptive Factory Memory

## Product problem
Repeated model invocations reload large conversations, specifications, decisions, repository descriptions and task history. This wastes context, may increase latency and resource consumption, and makes long-running PM/engineering work inconsistent. Existing structured PostgreSQL data is a foundation, but it is not automatically an effective retrieval-and-learning system.

## Outcome statement
The factory remembers **what matters**, **why it was believed**, **when it changed**, and **where it applies**. A subsequent project question or engineering task receives a small, citation-backed context pack instead of blindly replaying history. Memory is inspectable and correctable in the browser.

## User journeys
1. **PM continuity:** A project meeting produces proposed requirements. The system stores each with `proposed` status; later PRD drafting retrieves them but does not describe them as approved until the approved decision artifact exists.
2. **Engineering reuse:** A test failure with a verified fix becomes a project-scoped procedural memory. A similar future error surfaces the verified fix with repository/commit and compatibility details.
3. **Change of mind:** An approved requirement is replaced by a newer decision. The old record remains traceable but loses authority in current context retrieval.
4. **Privacy control:** The user opens Memory in Settings, searches records, reviews source/provenance, corrects or deletes records and chooses what projects can contribute memory. Deletion propagates to search/vector indexes, caches and generated context packs under the deletion policy.
5. **Cost transparency:** A project view shows retrieved memory, source citations, input tokens and accuracy/utility comparisons, with explicit uncertainty when provider token accounting is unavailable.
6. **Improvement loop:** SAI-11 identifies memory selection failures, proposes a retrieval-rule/skill change, runs baseline tests, then requests separate human approval before activation.

## Memory taxonomy
- **Working:** per-job short-lived conversation state and current task focus (existing job/session state; TTL).
- **Episodic:** factual event history such as decisions, agent runs, failures and results.
- **Semantic:** stable concepts, facts, product requirements, architecture contracts and named relationships.
- **Procedural:** validated approaches, runbooks, skill outcomes and workflows (version/compatibility scoped).
- **Preferences:** user/project conventions where explicitly approved or appropriately sourced.

**Do not create five disconnected databases.** Use one canonical typed record model with indexes and separate retention/authorization rules.

## User-facing UX (v2.4 integration)
- Project → **Memory & Evidence**: browsable timeline; filters type, status, source, date; linked decisions and contradictions.
- Work / Job → **Why this context?**: list included memories, citations, confidence/verification, tokens used and omissions due to budget.
- Settings → **Memory**: workspace opt-in defaults, source inclusion controls, retention, export, correction, suppression and deletion.
- Product dashboards → show source lineage on charts and decisions; do not convert estimates into facts.
- Standard status vocabulary: `verified`, `approved`, `proposed`, `disputed`, `superseded`, `expired`, `deleted`.
- Advanced diagnostics show retrieval candidates, ranking reason, confidence, scope, token estimate and model version; hide from normal task flow.

## Measurable outcomes (targets—not verified results)
- >= 30% reduction in **median task input tokens** in eligible recurring project workflows compared with pinned full-history baseline, with lower 95% confidence bound > 0; measure all retrieval/summary/embedding costs too.
- No statistically material decrease in task acceptance or groundedness; block release on defined critical regressions regardless of average score.
- Source citation precision >= 98% on curated evaluable memory-backed statements.
- Zero cross-project unauthorized disclosure, zero stale-approved-decision substitution in critical test set.
- >= 95% of deliberate memory deletions removed from all live retrieval surfaces within documented SLA (security-critical deletion tests require 100%).
- User can inspect why a memory was included and correct/suppress it through browser without editing SQL.

## Cost definition
Track **input, output, cache read/write, embeddings, summarization, retrieval CPU, storage and latency** separately. Subscription models may not expose money-per-token; report observed tokens/latency/quotas and avoid fabricated euro savings. Savings are only accepted if workload quality is non-inferior and measured total operating costs do not increase unjustifiably.

## Explicit exclusions
No unbounded autobiographical agent that can rewrite itself; no training/fine-tuning of model weights; no using memory to bypass permissions or inference policy; no automatic policy or skill activation.
