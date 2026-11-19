import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * How this program re-invokes itself for a managed child. Script mode (a source checkout under Bun) is detected by argv[1] being a real source file on disk;
 * a compiled single binary has no such file (its entry lives in an embedded filesystem) and simply re-execs itself.
 */
export function selfCommand(execPath = process.execPath, mainPath = process.argv[1] ?? "", exists: (p: string) => boolean = existsSync): { cmd: string; prefix: string[] } {
  const isScript = /\.(ts|tsx|js|mjs|cjs)$/.test(mainPath) && !mainPath.startsWith("/$bunfs") && exists(mainPath);
  return isScript ? { cmd: execPath, prefix: [mainPath] } : { cmd: execPath, prefix: [] };
}
export const installRoot = (execPath = process.execPath): string => join(execPath, "..", "..");

/** Migrations ship next to the binary in an install; in a source checkout they are the repository's own. Override: DISPATCH_MIGRATIONS_DIR. */
export function migrationsDir(env: Record<string, string | undefined> = process.env, execPath = process.execPath, exists: (p: string) => boolean = existsSync): string | undefined {
  for (const d of [env.DISPATCH_MIGRATIONS_DIR, join(execPath, "..", "..", "migrations")]) if (d && exists(join(d, "0001_core.up.sql"))) return d;
  return undefined; // source checkout: the db package's built-in default applies
}
