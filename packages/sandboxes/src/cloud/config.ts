import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const CloudConfigSchema = z.strictObject({
  version: z.string(),
  note: z.string().optional(),
  enabled: z.boolean(),
  operatorEnablement: z.strictObject({ enabledBy: z.string().min(1), enabledOn: z.string().min(1), hostInfrastructureLimitAcknowledged: z.literal(true) }).nullable(),
  images: z.strictObject({ allowedDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)) }),
  attestation: z.strictObject({ maxAgeSeconds: z.number().int().min(10).max(3600), providerPublicKeyPem: z.string().nullable() }),
  limits: z.strictObject({
    maxConcurrentSandboxes: z.number().int().min(1).max(50), maxSandboxSecondsPerDay: z.number().int().min(1), maxWallSecondsPerSandbox: z.number().int().min(1).max(86_400),
    maxMemoryMb: z.number().int().min(64), maxCpuCores: z.number().min(0.1), maxDiskMb: z.number().int().min(16), sandboxTtlSeconds: z.number().int().min(30),
  }),
  egress: z.strictObject({ allowedHosts: z.array(z.string()), deniedCidrs: z.array(z.string()), deniedHostnames: z.array(z.string()) }),
});
export type CloudConfig = z.infer<typeof CloudConfigSchema>;

export class CloudConfigInvalid extends Error {
  constructor(message: string) { super(message); this.name = "CloudConfigInvalid"; }
}

/** Cloud stays off unless an operator explicitly enabled it WITH pinned images, an attestation key and acknowledged infrastructure limits. */
export function assertCloudInvariants(c: CloudConfig): void {
  if (!c.enabled) return;
  if (!c.operatorEnablement) throw new CloudConfigInvalid("cloud enabled without operatorEnablement (who enabled it, when, and that the host-infrastructure limit was acknowledged)");
  if (c.images.allowedDigests.length === 0) throw new CloudConfigInvalid("cloud enabled without pinned image digests");
  if (!c.attestation.providerPublicKeyPem) throw new CloudConfigInvalid("cloud enabled without an attestation public key");
  for (const h of c.egress.allowedHosts) if (/^\*|\*$/.test(h) || h === "") throw new CloudConfigInvalid(`egress allowlist may not contain wildcards or empty hosts (${h})`);
  for (const must of ["127.0.0.0/8", "169.254.0.0/16", "10.0.0.0/8"]) if (!c.egress.deniedCidrs.includes(must)) throw new CloudConfigInvalid(`deniedCidrs must include ${must}`);
}

export function loadCloudConfig(configDir: string): CloudConfig {
  const c = CloudConfigSchema.parse(JSON.parse(readFileSync(join(configDir, "cloud.json"), "utf8")));
  assertCloudInvariants(c);
  return c;
}
