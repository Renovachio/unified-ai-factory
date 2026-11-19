import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { processIdentity, type ProcIdentity } from "./process";

export class LockTimeout extends Error { constructor(readonly holder: { pid: number } | null) { super(`another dispatch is starting the factory (pid ${holder?.pid ?? "unknown"}); timed out waiting`); } }

export interface LockDeps { identify?: (pid: number) => ProcIdentity | null; sleep?: (ms: number) => Promise<void>; now?: () => number; pid?: number }

/**
 * Cross-process startup lock: an exclusively created file holding {pid, startedAt}. A holder is live only if its PID exists with the SAME start time,
 * so a crashed holder's lock (stale, or its PID reused by another process) is reclaimed, and a live holder is waited for. Reclaiming renames the stale file
 * to a unique name first, so two reclaimers cannot both win.
 */
export async function acquireLock(path: string, opts: LockDeps & { timeoutMs?: number } = {}): Promise<() => void> {
  const identify = opts.identify ?? processIdentity; const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid; const me = identify(pid); const deadline = now() + (opts.timeoutMs ?? 30_000);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ pid, startedAt: me?.startedAt ?? "" });
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600); writeSync(fd, body); closeSync(fd);
      let released = false;
      return () => { if (released) return; released = true; try { const cur = JSON.parse(readFileSync(path, "utf8")) as { pid: number }; if (cur.pid === pid) rmSync(path, { force: true }); } catch { /* already gone */ } };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    let holder: { pid: number; startedAt: string } | null = null;
    try { holder = JSON.parse(readFileSync(path, "utf8")) as { pid: number; startedAt: string }; } catch { /* torn write or removed: treat as unknown */ }
    const live = holder ? (() => { const id = identify(holder.pid); return !!id && id.startedAt === holder.startedAt; })() : false;
    if (!live) { const aside = `${path}.stale.${pid}.${now()}`; try { renameSync(path, aside); rmSync(aside, { force: true }); } catch { /* someone else reclaimed it */ } continue; }
    if (now() >= deadline) throw new LockTimeout(holder);
    await sleep(100);
  }
}
