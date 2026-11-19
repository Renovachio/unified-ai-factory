# ADR 0001 — Original implementation; subscription-CLI / local-model inference only

Status: accepted (2026-11-18)

## Decisions
1. Implement from requirements; do not import upstream (Marshal Factory, Zazen) code or prompts (see `docs/third-party/PROVENANCE.md`).
2. Model inference only via (a) subscription CLIs where provider terms affirmatively permit this orchestration, or (b) local/self-hosted models. No API keys, metered endpoints, or silent fallback.
3. Subscription CLI adapters stay **disabled** until an operator records a provider-terms approval (see AGT-002/AGT-003).
4. Pilot: every merge is manual; HIGH/CRITICAL are always manual.

## Consequences
Fail-closed CI gate (LIC-001); policy constants in `@factory/domain`; open operator actions tracked in `PROGRESS.md`.
