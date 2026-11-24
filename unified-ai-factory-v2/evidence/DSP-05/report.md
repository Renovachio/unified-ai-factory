# DSP-05 — Shared typed client and event synchronisation

**Status: in_progress. Client, sync engine and API feed implemented and tested against the real HTTP API + Postgres. Not yet wired into the REPL or the dashboard (DSP-03/07).**

## What exists
- `packages/dispatch-client` (`@factory/dispatch-client`): `DispatchClient` (typed GET/mutations, SSE stream), `SseParser`, `SyncEngine`.
- API: `GET /api/v2/dispatch/{snapshot,events,events/stream,summary}`; organisation-scoped (join through repositories), `job:read` required, cursor validated.
- Mutations get their idempotency key at creation; `send` of the same `PendingMutation` reuses it. Network failure/timeout/5xx -> `OutcomeUnknown` (retry with the same key); 4xx definitive; stale revision -> `StaleRevision`. `expectedRevision` is sent in the body.
- Sync: events are hints; state comes only from snapshots/authoritative job reads and a stale revision can never overwrite a newer one. Dedupe by event id (bounded), per-job sequence gap -> snapshot reconcile, reconnect from the cursor with capped jittered exponential backoff (snapshot first), 401/403 stops the engine. Feed re-reads a 100-event window behind the cursor because global_seq is assigned at insert and cross-job commits may become visible out of order; clients dedupe.

## Tests (`bun test packages/dispatch-client`: 17 pass)
- Unit (11): dedupe, no regression on older revisions, gap/reorder repair, unseen job -> reconcile, reconnect+backoff cap, auth failure stops, bounded memory, SSE parsing (partial/CRLF/comments), idempotent retry reuses key, 5xx unknown vs 4xx definitive, StaleRevision, auth + key on every mutation.
- Integration against a real `Bun.serve` + Postgres (6): terminal (bearer) and browser (cookie) clients see the same state; dropped streams reconnect without losing/duplicating; a retried create yields exactly one job; other-tenant feed empty and unauthenticated stream refused; bad cursors 400; snapshot cursor precedes rows.

## Limits
- Tenant isolation of the feed is verified by a direct `readFeed` call as a second organisation plus an unknown-credential 401; a second authenticated tenant over HTTP is not possible in local single-owner mode.
- Events do not carry per-project filtering yet (organisation-wide); project/job filtering is applied client-side.
- Browser `EventSource` is not used; the dashboard path is untested here.
