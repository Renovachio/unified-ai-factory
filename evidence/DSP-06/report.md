# DSP-06 — Scoped session and conversation context

**Status: in_progress (terminal scope verified; the dashboard has no persisted conversational context).**
Code: `apps/dispatch-cli/src/repl/session.ts`, executor re-validation. Tests in `repl.test.ts`.

- `/project use <id|prefix|owner/name>` selects only projects the API returns for this actor; an unknown id and another organisation's project id give the identical "No visible project" answer and never appear in output (tested with a second organisation).
- The active project is re-validated on every use: if it is no longer visible the context is cleared with a message (stale-permission test).
- `/context` shows project, session id, expiry and remembered references; `/context clear` drops scope but not project data. Session file: `<home>/sessions/*.json`, 0600, bound to the actor, expires after 8 h, corrupt/foreign/expired files start clean.
- Ambiguous job references list candidates and do nothing; confirmations are bound to the revision seen.

**Not verified / missing:** no server-side `dispatch_sessions` table (the scope is a local file, not shared with the dashboard); cross-tenant behaviour tested via a second organisation in the same database, not two logged-in users.
