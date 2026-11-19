import { existsSync, realpathSync } from "node:fs";
import { PolicyViolation } from "./env";

export interface WrapContext {
  workspaceRoot: string;
  /** Extra read-only host paths (toolchains) the command legitimately needs. */
  readOnlyPaths?: string[];
  allowNetwork?: false;
  /** Working directory inside the sandbox (must be within the workspace). Defaults to the workspace root. */
  cwd?: string;
  /** Scrubbed environment for the command (bwrap clears the environment, so it must be re-applied explicitly). */
  env?: Record<string, string>;
  cpuSeconds?: number;
  maxFileBytes?: number;
}

export interface WrappedCommand {
  command: string;
  args: string[];
}

export interface SandboxBackend {
  readonly name: "seatbelt" | "bwrap" | "none";
  /** "strong" = filesystem + network confinement enforced by the OS; "none" = trusted repositories only. */
  readonly isolation: "strong" | "none";
  wrap(command: string, args: string[], ctx: WrapContext): WrappedCommand;
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** `ulimit` prelude (CPU seconds; file size in 1024-byte units, which is conservative where sh counts 512-byte blocks), then exec the real command (no shell interpolation of args). */
function limitsPrelude(ctx: WrapContext): string {
  const parts: string[] = [];
  if (ctx.cpuSeconds) parts.push(`ulimit -t ${Math.floor(ctx.cpuSeconds)}`);
  if (ctx.maxFileBytes) parts.push(`ulimit -f ${Math.max(1, Math.floor(ctx.maxFileBytes / 1024))}`);
  return parts.join("; ");
}

export function seatbeltProfile(ctx: WrapContext): string {
  const ws = real(ctx.workspaceRoot);
  const ro = ["/usr/lib", "/usr/bin", "/bin", "/usr/share", "/usr/libexec", "/System", "/Library/Apple", "/private/var/db/dyld", "/private/etc/ssl", "/dev/urandom", "/dev/random", ...(ctx.readOnlyPaths ?? []).map(real)];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow sysctl-read)",
    "(allow signal (target self))",
    "(allow mach-lookup (global-name \"com.apple.system.logger\") (global-name \"com.apple.system.notification_center\"))",
    `(allow file-read* ${ro.map((p) => `(subpath ${q(p)})`).join(" ")} (literal "/") (literal "/dev/null") (literal "/dev/zero") (literal "/private") (literal "/private/var") (literal "/private/tmp"))`,
    `(allow file-read-metadata)`,
    `(allow file-read* file-write* (subpath ${q(ws)}))`,
    `(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper"))`,
    "(deny network*)",
  ].join("\n");
}

export class SeatbeltBackend implements SandboxBackend {
  readonly name = "seatbelt" as const;
  readonly isolation = "strong" as const;
  wrap(command: string, args: string[], ctx: WrapContext): WrappedCommand {
    const pre = limitsPrelude(ctx);
    const inner = pre ? ["/bin/sh", "-c", `${pre}; exec "$0" "$@"`, command, ...args] : [command, ...args];
    return { command: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(ctx), ...inner] };
  }
}

export class BwrapBackend implements SandboxBackend {
  readonly name = "bwrap" as const;
  readonly isolation = "strong" as const;
  constructor(private readonly bin = "bwrap") {}
  wrap(command: string, args: string[], ctx: WrapContext): WrappedCommand {
    const ws = real(ctx.workspaceRoot);
    const ro: string[] = [];
    for (const p of ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc/ssl", "/etc/alternatives", ...(ctx.readOnlyPaths ?? [])]) if (existsSync(p)) ro.push("--ro-bind", p, p);
    const pre = limitsPrelude(ctx);
    const inner = pre ? ["/bin/sh", "-c", `${pre}; exec "$0" "$@"`, command, ...args] : [command, ...args];
    return {
      command: this.bin,
      args: ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", ...Object.entries(ctx.env ?? {}).flatMap(([k, v]) => ["--setenv", k, v]), ...ro, "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", ws, ws, "--chdir", ctx.cwd ? real(ctx.cwd) : ws, ...inner],
    };
  }
}

/** No confinement. Only for repositories the operator has explicitly marked trusted (`trusted_repository_only`). */
export class NoIsolationBackend implements SandboxBackend {
  readonly name = "none" as const;
  readonly isolation = "none" as const;
  wrap(): WrappedCommand {
    throw new PolicyViolation("no-isolation", "no sandbox available: untrusted code will not be executed (mode trusted_repository_only requires explicit operator opt-in)");
  }
}

export function detectBackend(opts: { platform?: string; exists?: (p: string) => boolean; bwrapPath?: string } = {}): SandboxBackend {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  if (platform === "darwin" && exists("/usr/bin/sandbox-exec")) return new SeatbeltBackend();
  if (platform === "linux") {
    for (const p of [opts.bwrapPath, "/usr/bin/bwrap", "/bin/bwrap"]) if (p && exists(p)) return new BwrapBackend(p);
  }
  return new NoIsolationBackend();
}
