import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_STEP_IDS } from "@factory/domain";
import { digestOf } from "@factory/telemetry";
import { z } from "zod";

/** Only these executables may appear as argv[0] in a gate manifest; they are mapped to absolute, pinned paths by the runner. */
export const GATE_EXECUTABLES = ["bun", "node"] as const;

export const GateManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.string().regex(/^[a-z0-9-]{1,40}$/),
  locked: z.literal(true),
  steps: z.array(z.strictObject({
    id: z.enum(GATE_STEP_IDS),
    command: z.array(z.string().min(1).max(200)).min(1).max(20).refine((c) => (GATE_EXECUTABLES as readonly string[]).includes(c[0] as string), "executable not allowlisted"),
    timeoutSeconds: z.number().int().min(1).max(3600),
  })).min(1).max(20),
  protectedPaths: z.array(z.string().max(200)).default([]),
});
export type GateManifest = z.infer<typeof GateManifestSchema>;

export class ManifestTampered extends Error {
  constructor(readonly profile: string, readonly expected: string | undefined, readonly actual: string) {
    super(`gate manifest "${profile}" does not match the pinned digest (expected ${expected ?? "<none pinned>"}, got ${actual})`);
    this.name = "ManifestTampered";
  }
}

export const manifestDigest = (m: GateManifest): string => digestOf(m);

/** Paths that DEFINE what "lint/test/build" mean for a target repo; changing them can weaken a gate from the inside. */
export const CHECK_DEFINING_PATHS: readonly RegExp[] = [
  /(^|\/)package\.json$/, /(^|\/)bun\.lockb?$/, /(^|\/)bunfig\.toml$/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)eslint\.config\.[cm]?[jt]s$/, /(^|\/)\.eslintrc[^/]*$/,
  /(^|\/)(vitest|jest|playwright)\.config\.[cm]?[jt]s$/, /(^|\/)\.github\/workflows\//, /(^|\/)Makefile$/, /(^|\/)scripts\//, /(^|\/)\.factory\//,
];
export const checkDefiningChanges = (paths: readonly string[], extraProtected: readonly string[] = []): string[] => {
  const extra = extraProtected.map((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "<<S>>").replace(/\*\*/g, "<<A>>").replace(/\*/g, "[^/]*").replace(/<<S>>/g, "(?:.*/)?").replace(/<<A>>/g, ".*") + "$"));
  return paths.filter((p) => CHECK_DEFINING_PATHS.some((r) => r.test(p)) || extra.some((r) => r.test(p)));
};

interface Lock { schemaVersion: 1; profiles: Record<string, string> }

/** Loads a manifest from the FACTORY control config and verifies it against the pinned digest in `gates.lock.json` (fail closed). */
export function loadLockedManifest(configDir: string, profile: string): { manifest: GateManifest; digest: string } {
  const manifest = GateManifestSchema.parse(JSON.parse(readFileSync(join(configDir, "gates", `${profile}.json`), "utf8")));
  const lock = JSON.parse(readFileSync(join(configDir, "gates.lock.json"), "utf8")) as Lock;
  const digest = manifestDigest(manifest);
  if (manifest.profile !== profile || lock.profiles[profile] !== digest) throw new ManifestTampered(profile, lock.profiles[profile], digest);
  return { manifest, digest };
}
