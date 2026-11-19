# CLD-001 evidence report

- **Status:** ACCEPTED_SIMULATED_PROVIDER_OPT_IN_OFF
- **Date:** 2026-11-19
- **Candidate SHA:** a9231ecc16cd0ecc48837b30b45a105cc2ac0c71 (branch dev/cld-001)
- **GitHub CI on candidate SHA:** completed success https://github.com/Renovachio/unified-ai-factory/actions/runs/44446677845
- **Test totals:**  880 pass  0 fail 
- **Accepted by:** operator, via instruction to continue following the plan to completion (2026-11-18); no separate human code review has occurred.

## Local commands (clean frozen install)
| Command | Exit |
|---|---|
| `bun install --frozen-lockfile` | 0 |
| `python3 scripts/validate_package.py` | 0 |
| `bun run license` | 0 |
| `bun run lint` | 0 |
| `bun run typecheck` | 0 |
| `bun test` | 0 |
| `bun run build` | 0 |

## Files changed in this task
- `bun.lock`
- `config/cloud.json`
- `packages/sandboxes/package.json`
- `packages/sandboxes/src/cloud/attestation.ts`
- `packages/sandboxes/src/cloud/config.ts`
- `packages/sandboxes/src/cloud/egress.ts`
- `packages/sandboxes/src/cloud/index.ts`
- `packages/sandboxes/src/cloud/placement.ts`
- `packages/sandboxes/src/cloud/provider.ts`
- `packages/sandboxes/src/cloud/quota.ts`
- `packages/sandboxes/src/index.ts`
- `packages/sandboxes/tests/cloud.test.ts`
- `packages/secrets/package.json`
- `packages/secrets/src/index.ts`
- `packages/secrets/tests/broker.test.ts`
- `packages/secrets/tsconfig.json`

## Notes
- **Cloud is OPT-IN and OFF**: `config/cloud.json` ships `enabled: false`. `assertCloudInvariants` refuses an enabled config without `operatorEnablement` (who/when/host-infrastructure-limit acknowledged), pinned image digests, an attestation public key, a wildcard-free egress allowlist and the mandatory deny ranges (loopback, 169.254/16, RFC1918...). `CloudSandboxController.run` throws `disabled` and creates nothing when off.
- **Attestation** (`signAttestation`/`verifyAttestation`, Ed25519): bound to a fresh per-sandbox NONCE and sandbox id, allowlisted image digest, max age, `rootless`, no host mounts, no open network. The controller refuses to run ANYTHING unless the provider's attestation verifies; tested: missing, wrong key, unknown image, replayed nonce, other sandbox, stale, not rootless, docker-socket mount, open network, tampering — in each provider-misbehaviour case the marker command never ran and the sandbox was destroyed.
- **Egress/SSRF** (`EgressPolicy`): https only, no URL credentials, allowlisted HOSTS only, metadata hostnames/IPs, loopback, RFC1918, CGNAT, link-local, IPv6 ULA/link-local, IPv4-mapped IPv6 (both notations) and numeric-host encodings denied; DNS-rebinding defence (an allowlisted host resolving to a private address is denied). 26 denial cases + allow cases tested; the secret broker / host services / metadata are unreachable through the proxy.
- **Quota** (`QuotaLedger`, infrastructure — NOT model — limits): concurrency, wall time, memory, CPU, disk, daily sandbox-seconds; release refunds unused time; leaked reservations expire after the TTL. A refused reservation creates nothing.
- **Teardown**: the sandbox is destroyed on success, failure, timeout AND cancellation; the controller then verifies it is gone from the provider listing (and the simulated provider's disk) and releases quota; destroy failures surface and leaked sandboxes are removed by `sweepOrphans` after the TTL; destroy is idempotent.
- **Denied credential transfer**: any credential-like env/secret name (API keys, tokens, SSH agent, AWS...) is refused BEFORE any sandbox exists. New `@factory/secrets` package: workers (local or cloud) are NEVER issued credentials; `SecretBroker.requestForWorker` denies, audits (redacted), and QUARANTINES the worker (status, immediate lease expiry so it is fenced out, `security.quarantined` event on its jobs) when it asks for a model/login/session credential, SSH or cloud-provider token, or when ANY request comes from a cloud worker; the broker never stores or issues model credentials; `assertPayloadClean` refuses secret-like content or credential-like field names bound for a worker/sandbox.
- **Placement** (`decidePlacement`): LOCAL by default; CLOUD only when enabled + repository approved for remote processing + a self-hosted model + quota; subscription CLIs never go remote (credentials may not leave the operator machine); otherwise BLOCK/queue with reasons.
- **Isolation parity**: the adversarial scenarios (host file read, write outside, network to loopback listener and metadata IP, env secrets, traversal) pass identically when run through the cloud controller.
- **Verified only against a SIMULATED provider** (`SimulatedCloudProvider`: local confinement + signing). NO real cloud provider (Modal or other) was integrated or run: that needs an operator account, an image pipeline with pinned digests, a provider-specific `RemoteSandboxProvider` implementation and a re-run of this parity suite against it. Network egress control in the simulated provider is a policy function, not a real proxy; real enforcement must be done by the provider's network layer.
- Next: EVAL-001, AUTO-001.
