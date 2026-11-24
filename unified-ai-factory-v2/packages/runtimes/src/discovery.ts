import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { platform, arch } from "node:os";

export interface RuntimeRecord {
  adapterId: string;
  kind: "subscription_cli" | "local_engine";
  found: boolean;
  executablePath?: string;
  version?: string;
  os: string;
  /** Human-checkable capability flags; NEVER read from credentials. */
  capabilityFlags: string[];
  detail: string;
}

export interface KnownRuntime { adapterId: string; kind: RuntimeRecord["kind"]; binary: string; versionArgs: string[]; capabilityFlags: string[] }
export const KNOWN_RUNTIMES: readonly KnownRuntime[] = [
  { adapterId: "claude-code", kind: "subscription_cli", binary: "claude", versionArgs: ["--version"], capabilityFlags: ["noninteractive-print", "json-output", "tool-use", "sandboxed-shell-by-factory"] },
  { adapterId: "codex", kind: "subscription_cli", binary: "codex", versionArgs: ["--version"], capabilityFlags: ["noninteractive-exec", "tool-use"] },
  { adapterId: "ollama", kind: "local_engine", binary: "ollama", versionArgs: ["--version"], capabilityFlags: ["openai-compatible-loopback", "tool-calls-model-dependent"] },
];

/** Minimal environment: version probes must never see credentials or billing variables. */
const PROBE_ENV = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C" });

export function findExecutable(binary: string, pathVar = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, binary);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return undefined;
}

/** RT-01: detect installed runtimes (location, version, capability flags, OS). Executes only `<bin> --version` with a scrubbed environment. */
export function discoverRuntimes(o: { known?: readonly KnownRuntime[]; pathVar?: string; timeoutMs?: number } = {}): RuntimeRecord[] {
  const os = `${platform()}-${arch()}`;
  return (o.known ?? KNOWN_RUNTIMES).map((k): RuntimeRecord => {
    const exe = findExecutable(k.binary, o.pathVar);
    if (!exe) return { adapterId: k.adapterId, kind: k.kind, found: false, os, capabilityFlags: [], detail: `${k.binary} not found on PATH` };
    const r = spawnSync(exe, k.versionArgs, { env: PROBE_ENV(), timeout: o.timeoutMs ?? 5000, encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0]?.slice(0, 200) ?? "";
    if (r.error || r.status !== 0) return { adapterId: k.adapterId, kind: k.kind, found: true, executablePath: exe, os, capabilityFlags: [], detail: `version probe failed: ${r.error?.message ?? `exit ${r.status}`}` };
    const m = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(out);
    return { adapterId: k.adapterId, kind: k.kind, found: true, executablePath: exe, ...(m ? { version: m[0] } : {}), os, capabilityFlags: [...k.capabilityFlags], detail: out };
  });
}
