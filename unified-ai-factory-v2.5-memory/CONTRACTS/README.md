# Contracts

The JSON Schemas here are **proposed reference contracts**, not claims of production API support. Map to the repo's existing Zod/OpenAPI patterns during implementation; preserve compatibility and version fields. Validate request input on server and client; authorization is additional to schema validation.

- `memory-record.schema.json` — canonical candidate/record representation with provenance.
- `retrieval-request.schema.json` — task-restricted query and budget.
- `context-pack.schema.json` — immutable selection manifest.
- `memory-feedback.schema.json` — evidence-backed user/agent feedback.

## API concepts (adapt to verified routes)
- `GET /api/projects/{id}/memories` — list with provenance/status, authorized.
- `POST /api/projects/{id}/memory-search` — bounded scoped retrieval.
- `GET /api/jobs/{id}/context` — selected source manifest and budget.
- `POST /api/memories/{id}/corrections` — versioned correction proposal with actor audit.
- `POST /api/memories/{id}/suppress` — prevent future retrieval subject to policy.
- `DELETE /api/memories/{id}` — authorization and purge workflow receipt.
- `GET /api/memory/diagnostics` — local authorized, redacted aggregated metrics.
All mutations require CSRF/session protection, idempotency, RBAC and current revision checks.
