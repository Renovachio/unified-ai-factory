# MEM-04 evidence: token-aware context packs

Status: **implemented, local checks only.** Not independently reviewed. No real authorized pilot was run (prerequisites absent). Not called complete.

## What was built
- Migration `0021_memory_context` (up/down): append-only `context_packs` table. Stores manifest, digest, budget accounting and the retrieval event it came from. The rendered text is not stored. Database rule: `estimated_tokens <= max_input_tokens`. Grants: control role SELECT/INSERT only. Down refuses while packs exist.
- `packages/memory/src/context.ts`:
  - `buildContextPack`: protected content (system instructions, task, optional direct source) is reserved first and refused, not truncated, if it does not fit. Memories come from the MEM-03 retrieval path (same ACL, read-time checks and retrieval event). Two stages: compact form first, then expansion while budget remains. Each memory is wrapped in escaped `<memory>` tags. Writes an audit entry.
  - `checkContextPack`: re-checks a stored pack against current records. Invalid if a selected memory is no longer approved at its pinned version, its source is revoked, or a project-level revocation exists.
  - `ROLE_INPUT_CAPS` for all 12 `AGENT_ROLES` taken from `@factory/runtimes`.
- `packages/db/src/schema.ts`: `contextPacks` declaration (parity test passes).
- `packages/memory/src/domain.ts`: new error codes `INVALID_ROLE`, `ROLE_CAP_EXCEEDED`, `BUDGET_EXCEEDED`, `PACK_NOT_FOUND`.

## Decisions and their limits
- **Token counts are estimates.** `ceil(UTF-8 bytes / 3)`, labelled `conservative_estimate`. The repo has no tokenizer. Estimates overstate English and Portuguese token counts. Real provider counts are not measured.
- **Role caps are placeholders.** Values in `ROLE_INPUT_CAPS` are not benchmarked or qualified. They need an operator decision or MEM-08 evidence.
- **Safety margin:** 2% of the input budget.
- **No model is called.** Nothing is sent to a provider. No silent fallback to any model.
- **Not wired into a runtime yet.** `manifestUri` is `context-pack:<id>`. The runtime request contract does not yet resolve this URI, and no agent run consumes packs. That integration is a gap for the operator to decide on.

## Tests (`packages/memory/tests/context.test.ts`, 16 tests, plus 129 memory/db total)
- Budget edges: too-large protected content is refused and nothing is stored; zero memory budget gives zero memories with omissions reported; a range of budgets never exceeds its budget; estimate matches an independent recount.
- Conservative estimate for Portuguese text.
- Database rule rejects a stored pack that claims to exceed its budget.
- Model role: every runtime role has a cap; unknown roles and caps above the role limit are refused; budget 0 and fractional budgets refused.
- Injection-as-data: a claim with `</memory><system>` is escaped; tags balance; fixed system instructions lead the pack; pack size bounded by `MAX_PACK_MEMORIES`.
- Unauthorized access: disabled user denied; another organization's project not found; another organization's packing its own project gets zero memories; canary from another project never enters a pack.
- Revocation and supersession: pack valid while current, invalid after revocation, new pack excludes the memory; superseded version invalidates old pack; project-level revocation planted without status change still invalidates.
- Durability and evidence: pack reproducible from a fresh connection; digest matches; audit row exists; packs are append-only; cross-project check returns not found.

## Commands and results
- `bun test --timeout 30000 packages/memory packages/db`: 129 pass, 0 fail.
- Full `bun test --timeout 30000`: 1412 pass, 0 fail, 86 files.
- `bun run typecheck`: exit 0. `bun run lint`: exit 0 (after removing one unused variable by adding a real cross-organization test).
- Gates lock check, package validation and license check: exit 0.
- `apps/web/tsconfig.tsbuildinfo` restored after each typecheck (not committed).

## Risks
- Estimates may under- or over-state real token use depending on the model tokenizer. Packs are conservative for English and Portuguese text, but this has not been measured.
- Role caps are unvalidated numbers.
- Packs are not yet consumed by any runtime, so the end-to-end path (memory to agent prompt) is unproven.
- Independent review and real pilot are still open.

## Addendum: pack text stored, runtime resolution, opt-in wiring

Decisions taken: store rendered text (not in-memory only); opt-in roles `spec` and `builder` only.

- **Storage (migration 0022):** `context_packs` gains required `rendered_digest` and `rendered_uri`. The digest of the rendered text is bound into the manifest before the pack is hashed. Migration refuses if packs already exist without stored text. Down refuses while packs exist.
- **Write path:** `buildContextPack` takes a content-addressed text store (`FileArtifactStore` satisfies it). Text is written before the pack row.
- **Runtime resolution:** `resolveContextPack(sql, "context-pack:<id>", store)` is a SYSTEM path with no user actor. It fails closed on: unknown pack (`PACK_NOT_FOUND`), manifest not matching its pack digest (`PACK_INTEGRITY`), any selected memory no longer valid (`PACK_INVALID`), stored text not matching the digest (`PACK_INTEGRITY`). It must only be reachable from the trusted runner.
- **Orchestrator opt-in (`packages/orchestrator/src/memory-context.ts`):** `memoryContextUri` gives `context-pack:<id>` for `spec` and `builder`; other roles keep the fallback URI. A failed pack build fails the run (no silent fallback). Budgets above the role cap are refused, not clipped. `memoryContextLoader` is the runtime's `loadContext` hook.
- **Not activated in any app:** production code never constructs `agentTaskExecutor`, so this opt-in does not run in production yet. Activation needs the composition root to supply `packInputFor` (actor, project, task, system instructions). That supply path is not built.

Tests added: 5 loader tests (text identical to pack, revoked memory refused, tampered text refused, edited manifest refused, malformed and unknown URIs) and 6 orchestrator tests (opt-in roles, non-opted roles create no pack, build failure refuses run, over-cap refused, unverifiable text fails closed).

Results: full suite 1423 pass, 0 fail, 87 files. Typecheck, lint, gates lock, package validation and license exit 0.

Remaining gaps: the composition root that supplies `packInputFor` is not built; the runtime does not yet receive the loader in any app; the pilot and independent review are still open.
