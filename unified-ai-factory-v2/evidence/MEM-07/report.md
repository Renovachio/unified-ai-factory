# MEM-07: browser memory controls (slice 1: review, notes, overlap approval, consent)

Status: implemented_partial, local checks only. Committed locally and on PR #7 (draft). One independent adversarial review done (see addendum); no pilot.
Built by a delegated Opus agent; the coordinating session re-verified files, the API memory + web tests (42 pass) and lint. The browser run and the full-suite figure below are the agent's own reports, not re-run by the coordinator.

## Dependency audit (reuse vs gap)
- The spec depends on a "v2.4 browser UI". No v2.4 UI exists in this branch. What exists is the v2.3 Dispatch dashboard (`apps/web`, Next 16, server components + server actions, DSP-07). MEM-07 is built on it; nothing parallel was added. No migration, no new persistence.
- Backend reused: the MEM-06 addendum 8 routes in `apps/api/src/memory.ts` and the memory package.
- Gaps closed (additive, read-only routes):
  - `GET /api/v2/dispatch/memory/:id/conflicts?projectId=`: approved memories a proposed memory overlaps (`job:decide` only, so the agent identity gets 403; project and organization scoped).
  - `GET /api/v2/dispatch/memory/consent?projectId=`: current consent (`job:read`; unknown project is 404).
  - List items now also carry `revokedSources`, `supersededBy`, `validTo`.

## What a human can do in the browser
Page `/projects/<id>/memory` (linked from the project page):
- See proposed and approved memory separately (approved shows whether Claude is shown it), plus a collapsed history; erased text shows "text erased".
- Add a note (becomes PROPOSED memory).
- Approve or reject. When a proposed memory overlaps approved memory, the overlap is shown first and each overlapping item must be ticked to approve and erase it; the API still enforces the exact overlap set. A failed overlap check is announced, never shown as "no overlap".
- Preview what Claude would receive for a task (framed as data).
- See and toggle telemetry consent with a required reason.

## Privilege
- The browser never handles a token; server actions forward only the viewer's own session cookie with CSRF and an idempotency key. Browser sessions are minted only for the local owner token. Notes, approval and consent still require `job:decide` in the API and the approver role in the memory package and database.
- Form input is validated before the API call (`apps/web/lib/memory-form.ts`); the API is the real boundary.
- Memory text is rendered escaped and labelled as data (tested).

## Side effect on other pages
`apps/web/app/globals.css`: `main a` now uses the accent colour (links were dark blue on the dark background). This affects every dashboard page, not only memory. The pre-existing `pre.untrusted` left border (flagged by the design hook, attribution unknown) was left unchanged.

## Tests and commands
- `bun test apps/api/tests/memory.test.ts apps/web/tests`: 42 pass, 0 fail (coordinator re-run). Agent reported 7 API memory tests (3 new) and 35 web tests (11 new).
- `bun run lint` clean (coordinator re-run). Agent reported typecheck clean and `next build` succeeding.
- Agent reported full `bun test` 1550 pass / 0 fail in one run. Full-suite runs earlier in this session failed intermittently in unrelated database-heavy files, so one clean run is not proof of stability.

## Live browser check (agent report, synthetic data)
Isolated local stack (temporary Postgres, API in local mode, `next start`), entered with a one-time browser code and driven in Chrome: note proposed and approved; overlapping note showed its overlap; approving without ticking was blocked; after ticking, approval erased one item; consent turned on. Screenshot: `evidence/MEM-07/overlap-review.jpg`. Stack and cluster removed afterwards.
Not checked: screen reader or keyboard-only use, light colour scheme, narrow viewport (no automated accessibility tool in the repo).

## Not built (spec items still open)
- Correct, delete and export now exist as API routes and `dispatch memory revise|erase|export` (follow-up commit, tested in `apps/api/tests/memory.test.ts`); they are NOT in the browser page yet. Suppress (source revocation) has no route. Erasing an APPROVED memory directly is refused by design (steward path is an open decision).
- Retention and deletion propagation end-to-end test; the retention sweep is still not scheduled.
- Restart test of the browser flow.
- Multi-user (OIDC) mode: memory routes are local-mode only.
- Each preview records a context pack, like a real run.
- Overlap is checked for the first 50 proposed items only (stated on the page).
- No pilot, no independent review.

## Addendum: independent review (read-only, Opus) and what was done
Verified by the reviewer with probes against the real API, then fixed here: (1) the agent token could list proposed/rejected memory text via `GET /memory`: now `job:decide` only (test added); (2) the idempotency key is required but results are not replayed, so a repeated note created a duplicate proposal: identical note text in a project now reuses the existing event (test added; feedback/decision/consent still have no replay); CLI: status is URL-encoded, and an approval refused for overlap now points to the dashboard.
Stated corrections: MEM-06 addendum 8 said "reject: tested 403 for the agent"; that test did not exist until now (added). The MEM-06 claim that the agent can only read *approved* memory was wrong for the listing route until this fix.
Left as designed or open (not fixed):
- **Authorship:** notes are proposed under the dispatch agent identity so the human can approve alone; `created_by` and the ingest audit row therefore name the agent for text a human wrote (the human is in `consent.grantedBy` and the event actor). Any holder of `job:decide` can write and approve their own note. This is a policy decision for the operator, not a defect fixed here.
- Feedback has no per-memory dedupe and accepts any status; with consent on, an agent can emit one signal per call.
- Every context read, including the web preview (a GET with `?task=`), writes a pack, audit row and retrieval event; only the global rate limiter applies.
- `?error=`/`?notice=` text is reflected (escaped, not XSS) on the memory page, as on other pages.
- CSS: `main a` and global `fieldset/legend/textarea` rules affect other pages.
- CLI: `byPrefix` searches only the first 200 items; approve-with-erasure exists only in the browser.
- No CSRF cookie-session test for memory routes; pack-erasure propagation not tested through the API; the runbook should state that the sweep's `DISPATCH_ARTIFACT_ROOT` must be `<DISPATCH_HOME>/memory-packs`.
- Could not verify: whether a Claude session or its subagents can read the token files and call the API directly.
