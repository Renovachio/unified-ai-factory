# DSP-07 — Dashboard redesign and conversational workspace

**Status: in_progress (pages render and work against the real API in the packaged install; no real-browser or screen-reader pass).**
Code: `apps/web/app/{page,projects,approvals,models,diagnostics,logs,help}`, `apps/web/lib/{dispatch-view.tsx,command-route.ts}`, job page controls. Tests: `apps/web/tests/dispatch.test.tsx` (13 new, 24 total in `apps/web`).

- Home: plain-language health sentence, counts, "Needs your attention", jobs, projects, and a command box. Project workspace, approvals inbox (capability approvals show exact digests; job decisions link to the existing exact-SHA review), models page (available / qualified / authorized as three separate facts; unreadable policy shown as an alert, never as ready), diagnostics, logs (redacted events), help.
- The command box **navigates only**: slash commands and the fixed phrases route to pages; mutating, destructive, unknown and URL-looking input produce a notice and never execute or redirect off-site.
- Controls on the job page: pause/resume, and cancel behind a typed id prefix, bound to the revision shown. Capability approval uses the exact digests rendered.
- Accessibility (checked structurally in tests): skip link, landmarks, table captions and scoped headers, labelled inputs, `role=status/alert`, focus styles, responsive CSS. Untrusted titles escaped and labelled.
- Real run: after authenticating with a one-time code, `/ /projects /approvals /models /diagnostics /logs /help /jobs /skills` returned 200 with expected content from the packaged install; `next build` passes.

**Not verified:** no browser-driven E2E, no screen-reader or contrast measurement, no live auto-refresh in the browser (pages are server-rendered; reload to refresh; the shared sync engine is not yet embedded in the browser). Dashboard job creation is absent (needs repository linking).
