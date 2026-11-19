# ACT-03 — Live GitHub verification (v2.1)

**Status: `blocked`.** No GitHub App, installation, webhook secret or disposable repository was provided. All GitHub behaviour so far is verified against a local fake GitHub over real HTTP (`SCM-001`, `MRJ-001`, `ACCEPTED_MOCK_ONLY`/`ACCEPTED_MOCK_GITHUB`); that is not live verification and must not be reported as such.

## Needed
App id, private key, installation id, webhook secret for a **dedicated test repository** with branch protection and required checks; a public HTTPS webhook URL.

## To verify live (none done)
Installation-token minting and expiry; draft PR creation from a trusted-side candidate; webhook signature + redelivery; stale-head and base-moved refusal at merge; branch-protection refusal; merge-queue behaviour; rate-limit handling.
