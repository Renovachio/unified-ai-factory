# DSP-04 — Typed intent router and policy gate

**Status: in_progress (router, validator, confirmations, fail-closed NL path verified; no qualified model interpreter exists, so the model path is exercised only with scripted interpreters).**
Code: `packages/dispatch-core/src/intent/{schema,commands,confirm,interpreter}.ts`. Tests: `packages/dispatch-core/tests/intent.test.ts` (10), `apps/dispatch-cli/tests/security.test.ts` (9).

- Strict validator for every `Intent` in `CONTRACTS/dispatch.schema.json`: unknown types/fields rejected, identifiers restricted to a safe alphabet (injection payloads, traversal, spaces, `__proto__` rejected), text length-bounded.
- Deterministic phrases never reach a model (spy interpreter called 0 times across all read-only commands). "Stop everything" forces clarification.
- NL fallback: only through an injected `NlInterpreter` (none is configured); its output is untrusted, schema-validated, `clarification.required` becomes a question; prose, extra fields, throws, `null`, shell payloads → refused, zero mutating requests.
- Confirmations: single-use, 120 s, bound to actor + action + target + project + session + revision; any change → mismatch; a mismatch does not burn the token. A model-proposed valid `job.cancel` still stops at the typed human confirmation and only proceeds when the human supplies it.
- Policy: destructive intents (`job.cancel`) require confirmation; job-merge decisions are routed to the dashboard.

**Not verified:** behaviour of a real local or subscription model as interpreter (none authorized/qualified). Intent states (Received→…→Completed) are represented by outcomes (`completed | blocked | needs-input | failed`), not persisted as a state log; there is no `dispatch_actions` audit table (the underlying API calls keep their normal audit entries). `project.create` is BLOCKED (`project-not-linked`).
