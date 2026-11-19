# DSP-08 — Models, skills, agents, approvals and job controls

**Status: in_progress (read views and controls verified against real API/DB; no real model, skill import, or activation flow exercised end to end).**
API: `GET /api/v2/dispatch/{projects,approvals,capabilities?category=skills|agents|models}`; controls use the existing `POST /api/v1/jobs/:id/{pause,resume,cancel}` and `POST /api/v2/approvals/:id/decision` unchanged.

- `/models` distinguishes available / qualified / authorized from `config/runtime-allowlist.json`, `model-qualification.json`, `provider-terms.json`, `inference-policy.json`; with this repository's config all three are 0 and metered billing is disabled. Unreadable config → "could not be read", nothing shown ready (tested).
- `/skills` `/agents`: only active versions are listed as approved; everything else is labelled a proposal "cannot run until approved". Dispatch cannot activate anything: approving a capability records the decision for the exact digests; activation remains the separate revision-checked `POST /api/v2/activations`, which Dispatch does not call.
- Pause/resume/cancel go through the existing operator/cancel endpoints and state machine with `expectedVersion` (stale → clear refusal). Verified with DB assertions (paused_at set/cleared; state CANCELLED; the other job untouched).
- Job-merge approvals are not decided from the terminal (exact head SHA/base/policy binding lives in the dashboard).

**Not verified:** a capability-approval decision through the terminal/dashboard was not run end to end (no skill candidate was seeded); the underlying registry behaviour is covered by the v2.2 test suite. Activation is not offered.
