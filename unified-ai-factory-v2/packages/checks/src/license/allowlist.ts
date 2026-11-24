import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const approval = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedOn: z.string().min(1),
  allowedModes: z.array(z.enum(["runtime", "dev", "build"])).min(1),
  attribution: z.string().optional(),
});

export const AllowlistSchema = z.object({
  schemaVersion: z.literal(1),
  allowedLicenses: z.array(z.string().min(1)).min(1),
  forbiddenPackages: z.array(z.string().min(1)),
  scanExclude: z.array(z.string()).default([]),
  packages: z.array(approval),
  exceptions: z
    .array(
      z.object({
        name: z.string().min(1),
        license: z.string().min(1),
        reason: z.string().min(1),
        approvedBy: z.string().min(1),
      }),
    )
    .default([]),
});
export type Allowlist = z.infer<typeof AllowlistSchema>;

export function loadAllowlist(path: string): Allowlist {
  return AllowlistSchema.parse(parse(readFileSync(path, "utf8")));
}

export const UpstreamApprovalsSchema = z.object({
  schemaVersion: z.literal(1),
  approvals: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      upstream: z.string(),
      upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
      license: z.string(),
      approvedBy: z.string(),
    }),
  ),
});
export type UpstreamApprovals = z.infer<typeof UpstreamApprovalsSchema>;
