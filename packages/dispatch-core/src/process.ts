import { spawnSync } from "node:child_process";

export interface ProcIdentity { pid: number; startedAt: string; command: string }

/** Real process identity: start time + full command line from `ps` (a PID alone proves nothing: PIDs are reused). */
export function processIdentity(pid: number): ProcIdentity | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const r = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
  if (r.status !== 0) return null;
  const line = r.stdout.trim();
  const m = /^(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line);
  return m ? { pid, startedAt: m[1] as string, command: m[2] as string } : null;
}

/** Working directory of a process (macOS/Linux `lsof`); null if unknown. */
export function processCwd(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const r = spawnSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/bin" } });
  if (r.status !== 0) return null;
  const line = r.stdout.split("\n").find((l) => l.startsWith("n")); return line ? line.slice(1) : null;
}

export interface OwnedRecord { pid: number; startedAt: string; marker: string; cwd?: string | undefined }

/**
 * True only if the PID is alive, started at the recorded time, AND it is recognisably ours: its command line carries our instance marker, or (for programs
 * that rewrite their own process title, such as Next.js) its working directory is the one we launched it in.
 */
export function isOwnedProcess(rec: OwnedRecord, identify: (pid: number) => ProcIdentity | null = processIdentity, cwdOf: (pid: number) => string | null = processCwd): boolean {
  const id = identify(rec.pid);
  if (!id || id.startedAt !== rec.startedAt) return false;
  if (id.command.includes(rec.marker)) return true;
  return rec.cwd !== undefined && cwdOf(rec.pid) === rec.cwd;
}
