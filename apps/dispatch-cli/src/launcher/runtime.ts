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

/** Read-only policy/qualification config: shipped next to the binary in an install; in a checkout the repository's `config/`. Override: DISPATCH_CONFIG_DIR. */
export function configDir(env: Record<string, string | undefined> = process.env, execPath = process.execPath, exists: (p: string) => boolean = existsSync): string | undefined {
  for (const d of [env.DISPATCH_CONFIG_DIR, join(execPath, "..", "..", "config"), join(process.cwd(), "config")]) if (d && exists(join(d, "inference-policy.json"))) return d;
  return undefined;
}

/** The Claude Code plugin shipped next to the binary (install) or in the checkout (`packaging/dispatch/claude-plugin`). Override: DISPATCH_PLUGIN_DIR. */
export function pluginDir(env: Record<string, string | undefined> = process.env, execPath = process.execPath, exists: (p: string) => boolean = existsSync): string | undefined {
  for (const d of [env.DISPATCH_PLUGIN_DIR, join(execPath, "..", "..", "claude-plugin"), join(process.cwd(), "packaging/dispatch/claude-plugin")]) if (d && exists(join(d, ".claude-plugin", "plugin.json"))) return d;
  return undefined;
}
