# Versioned boundary contracts

- `job-create.schema.json`: POST /api/v1/jobs request.
- `job-response.schema.json`: accepted job envelope.
- `event.schema.json`: durable job/run event envelope.
- `agent-result.schema.json`: role run outcome; no payment mode.
- `review.schema.json`: independent review tied to candidate SHA.
- `policy.schema.json`: model-source and merge restrictions.
- `openapi.yaml`: initial public API surface, expanded by API-001.

These are version 1 canonical seed contracts. Make additions backwards compatible or publish a versioned migration and contract tests. OpenAPI is an initial scaffold, not a full generated server implementation.
