import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORBIDDEN_ENV_KEYS } from "@factory/domain";
import { validatePolicy } from "@factory/contracts";
import { forbiddenEnvNames, PolicyViolation } from "@factory/sandboxes";
import { z } from "zod";
import type { AuthMode } from "./types";

const TermsSchema = z.strictObject({
  version: z.string(),
  note: z.string().optional(),
  approvals: z.array(z.strictObject({
    adapterId: z.string().min(1),
    provider: z.string().min(1),
    termsUrl: z.url(),
    termsReviewedOn: z.string().min(1),
    approvedBy: z.string().min(1),
    scope: z.string().min(1).describe("the exact automation pattern approved"),
    expiresOn: z.string().optional(),
  })),
});
const AllowlistSchema = z.strictObject({
  version: z.string(),
  note: z.string().optional(),
  executables: z.array(z.strictObject({ adapterId: z.string(), path: z.string().startsWith("/"), versionPattern: z.string() })),
  allowedEndpointHosts: z.array(z.string()),
  deniedEndpointHosts: z.array(z.string()),
});
export type ProviderTerms = z.infer<typeof TermsSchema>;
export type RuntimeAllowlist = z.infer<typeof AllowlistSchema>;

export interface InferencePolicyConfig {
  allowedInferenceModes: readonly AuthMode[];
  terms: ProviderTerms;
  allowlist: RuntimeAllowlist;
}

export function loadPolicyConfig(configDir: string): InferencePolicyConfig {
  const raw = JSON.parse(readFileSync(join(configDir, "inference-policy.json"), "utf8")) as unknown;
  const v = validatePolicy(raw);
  if (!v.ok) throw new PolicyViolation("bad-policy", `config/inference-policy.json violates policy.schema.json: ${v.errors.join("; ")}`);
  const modes = (raw as { allowedInferenceModes: AuthMode[] }).allowedInferenceModes;
  return {
    allowedInferenceModes: modes,
    terms: TermsSchema.parse(JSON.parse(readFileSync(join(configDir, "provider-terms.json"), "utf8"))),
    allowlist: AllowlistSchema.parse(JSON.parse(readFileSync(join(configDir, "runtime-allowlist.json"), "utf8"))),
  };
}

export interface PolicyCheckInput {
  adapterId: string;
  authMode: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Network endpoints the adapter intends to contact (local model server etc.). */
  endpoints?: string[];
  /** Executable the adapter intends to launch and its reported version. */
  executable?: { path: string; version: string };
  now?: Date;
}

/**
 * Central, deny-by-default InferenceSourcePolicy (SECURITY.md / blueprint §6). Checked at worker registration and before EVERY run.
 * Throws PolicyViolation (never falls back to another inference source).
 */
export class InferenceSourcePolicy {
  constructor(private readonly cfg: InferencePolicyConfig) {}

  check(i: PolicyCheckInput): void {
    // 1. No model credentials, billing switches or base-URL overrides anywhere in the environment.
    const bad = forbiddenEnvNames(i.env);
    if (bad.length) throw new PolicyViolation("forbidden-env", `credential-like environment present (${bad.join(", ")}); ${FORBIDDEN_ENV_KEYS.join("/")} and similar are prohibited`);
    // 2. Auth mode must be one of the two allowed sources.
    if (!(this.cfg.allowedInferenceModes as readonly string[]).includes(i.authMode)) throw new PolicyViolation("auth-mode-not-allowed", `auth mode "${i.authMode}" is not permitted (allowed: ${this.cfg.allowedInferenceModes.join(", ")})`);
    // 3. Subscription CLIs require an unexpired, recorded provider-terms approval for exactly this adapter.
    if (i.authMode === "subscription_cli") {
      const now = i.now ?? new Date();
      const ok = this.cfg.terms.approvals.some((a) => a.adapterId === i.adapterId && (!a.expiresOn || Date.parse(a.expiresOn) > now.getTime()));
      if (!ok) throw new PolicyViolation("terms-not-approved", `no provider-terms approval recorded for adapter ${i.adapterId}; subscription automation is blocked (config/provider-terms.json)`);
    }
    // 4. Endpoints: loopback/allowlisted only; known metered inference hosts are always denied.
    for (const ep of i.endpoints ?? []) {
      let host: string;
      try { host = new URL(ep).hostname.replace(/^\[|\]$/g, ""); } catch { throw new PolicyViolation("endpoint-invalid", `unparseable endpoint ${ep}`); }
      if (this.cfg.allowlist.deniedEndpointHosts.some((d) => host === d || host.endsWith("." + d))) throw new PolicyViolation("endpoint-denied", `endpoint host ${host} is a metered inference service`);
      if (!this.cfg.allowlist.allowedEndpointHosts.includes(host)) throw new PolicyViolation("endpoint-not-allowlisted", `endpoint host ${host} is not allowlisted`);
    }
    // 5. Executable identity: exact path and version pattern from the operator allowlist.
    if (i.executable) {
      const e = this.cfg.allowlist.executables.find((x) => x.adapterId === i.adapterId && x.path === i.executable?.path);
      if (!e) throw new PolicyViolation("executable-not-allowlisted", `${i.executable.path} is not an allowlisted executable for ${i.adapterId}`);
      if (!new RegExp(e.versionPattern).test(i.executable.version)) throw new PolicyViolation("version-unsupported", `${i.executable.path} version ${i.executable.version} does not match ${e.versionPattern}`);
    }
  }
}
