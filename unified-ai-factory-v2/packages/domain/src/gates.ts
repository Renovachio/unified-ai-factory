/** Canonical deterministic gate step ids (blueprint section 11). Gate manifests, specs and evidence all reference these. */
export const GATE_STEP_IDS = ["dependencies", "lint", "typecheck", "unit", "integration", "e2e", "build", "sast", "secrets", "dependency-scan"] as const;
export type GateStepId = (typeof GATE_STEP_IDS)[number];

/** Paths whose modification always raises risk (blueprint section 11 + 6); minimum risk CRITICAL for the first group, HIGH for the rest. */
export const PROTECTED_PATH_GLOBS: ReadonlyArray<{ glob: string; level: "HIGH" | "CRITICAL" }> = [
  { glob: ".github/workflows/**", level: "CRITICAL" },
  { glob: "factory-policy/**", level: "CRITICAL" },
  { glob: "security/**", level: "CRITICAL" },
  { glob: "config/**", level: "CRITICAL" },
  { glob: "licenses/**", level: "CRITICAL" },
  { glob: "migrations/**", level: "HIGH" },
  { glob: "**/package.json", level: "HIGH" },
  { glob: "bun.lock", level: "HIGH" },
  { glob: "**/auth/**", level: "HIGH" },
  { glob: "**/*.sql", level: "HIGH" },
  { glob: "Dockerfile*", level: "HIGH" },
];

const rx = (glob: string) =>
  new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "<<DSLASH>>")
        .replace(/\*\*/g, "<<DSTAR>>")
        .replace(/\*/g, "[^/]*")
        .replace(/<<DSLASH>>/g, "(?:.*/)?")
        .replace(/<<DSTAR>>/g, ".*") +
      "$",
  );
const COMPILED = PROTECTED_PATH_GLOBS.map((p) => ({ ...p, re: rx(p.glob) }));

/** Repo-relative, normalised, traversal-free path or null. */
export function normalizeRepoPath(p: string): string | null {
  if (!p || p.includes("\0") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\")) return null;
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === "" )) return null;
  return parts.filter((s) => s !== ".").join("/") || null;
}

export function protectedPathHits(paths: readonly string[]): Array<{ path: string; level: "HIGH" | "CRITICAL" }> {
  const hits: Array<{ path: string; level: "HIGH" | "CRITICAL" }> = [];
  for (const raw of paths) {
    const p = normalizeRepoPath(raw);
    const m = p === null ? { level: "CRITICAL" as const } : COMPILED.find((c) => c.re.test(p));
    if (m) hits.push({ path: raw, level: m.level });
  }
  return hits;
}
