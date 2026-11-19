import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { isOwnedProcess, processIdentity, type ProcIdentity } from "./process";
import { readState, transition, writeState, type Phase, type ServiceRecord, type SupervisorState } from "./state";

export interface Probe { live: boolean; ready: boolean; detail: string }
export interface Started { pid?: number; startedAt?: string; marker?: string; port?: number; cwd?: string }
export interface ServiceSpec {
  name: string;
  /** Required services failing => Failed; optional ones => Degraded. */
  required: boolean;
  /** "observed" services are only reported, never started or stopped. */
  kind: "startable" | "observed";
  dependsOn?: string[];
  probe(): Promise<Probe>;
  start?(marker: string): Promise<Started>;
  /** Custom graceful stop (e.g. pg_ctl); default is SIGTERM then SIGKILL on a verified-owned PID. */
  stop?(rec: ServiceRecord): Promise<void>;
  readyTimeoutMs?: number;
}
export interface ServiceStatus { name: string; required: boolean; mode: "managed" | "external" | "observed" | "none"; state: "ready" | "degraded" | "failed" | "stopped"; detail: string }

export interface LifecycleDeps {
  statePath: string;
  instanceId: string;
  identify?: (pid: number) => ProcIdentity | null;
  cwdOf?: (pid: number) => string | null;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}
export const phaseOf = (st: ServiceStatus[]): Phase => st.some((s) => s.required && s.state !== "ready") ? "Failed" : st.some((s) => s.state !== "ready" && s.mode !== "observed") ? "Degraded" : "Ready";

export class Lifecycle {
  private readonly identify; private readonly kill; private readonly sleep; private readonly now;
  constructor(private readonly specs: ServiceSpec[], private readonly d: LifecycleDeps) {
    this.identify = d.identify ?? processIdentity; this.kill = d.kill ?? ((p, s) => process.kill(p, s)); this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); this.now = d.now ?? Date.now;
  }
  private state(): SupervisorState { return readState(this.d.statePath) ?? { schemaVersion: 1, instanceId: this.d.instanceId, phase: "Stopped", services: {}, updatedAt: "" }; }
  private owned(rec: ServiceRecord | undefined): boolean { return !!rec && rec.pid !== undefined && rec.startedAt !== undefined && rec.marker !== undefined && isOwnedProcess({ pid: rec.pid, startedAt: rec.startedAt, marker: rec.marker, cwd: rec.cwd }, this.identify, this.d.cwdOf); }

  /** Read-only: probes every service and says whether we own it. No mutation, no lock needed. */
  async status(): Promise<{ phase: Phase; services: ServiceStatus[] }> {
    const st = this.state(); const out: ServiceStatus[] = [];
    for (const s of this.specs) {
      const p = await s.probe().catch((e: unknown) => ({ live: false, ready: false, detail: `probe error: ${(e as Error).message}` }));
      const rec = st.services[s.name]; const own = this.owned(rec);
      const mode: ServiceStatus["mode"] = s.kind === "observed" ? "observed" : p.live ? (own || (rec?.managed && s.name === "postgres" && p.ready) ? "managed" : "external") : "none";
      out.push({ name: s.name, required: s.required, mode, state: p.ready ? "ready" : p.live ? "degraded" : s.kind === "observed" ? "degraded" : "stopped", detail: p.detail });
    }
    const startable = out.filter((s) => s.mode !== "observed");
    if (startable.every((s) => s.state === "stopped")) return { phase: "Stopped", services: out };
    return { phase: phaseOf(out.map((s) => (s.state === "stopped" ? { ...s, state: "failed" as const } : s))), services: out };
  }

  /** Attach to what is healthy, start only what is missing (caller holds the startup lock). Never kills anything. */
  async ensure(): Promise<{ phase: Phase; services: ServiceStatus[] }> {
    const st = this.state();
    const out: ServiceStatus[] = []; const failed = new Set<string>();
    for (const s of this.specs) {
      const blocker = (s.dependsOn ?? []).find((n) => failed.has(n));
      if (blocker) { failed.add(s.name); out.push({ name: s.name, required: s.required, mode: "none", state: "failed", detail: `not started: ${blocker} is not ready` }); continue; }
      let p = await s.probe().catch((e: unknown) => ({ live: false, ready: false, detail: `probe error: ${(e as Error).message}` }));
      const rec = st.services[s.name];
      if (s.kind === "observed") { out.push({ name: s.name, required: s.required, mode: "observed", state: p.ready ? "ready" : "degraded", detail: p.detail }); continue; }
      if (p.ready) { out.push({ name: s.name, required: s.required, mode: this.owned(rec) || rec?.managed ? "managed" : "external", state: "ready", detail: p.detail }); continue; }
      // Not ready. A recorded process that no longer matches its identity is stale (crash, PID reuse): forget it, never signal it.
      if (rec && !this.owned(rec)) { Reflect.deleteProperty(st.services, s.name); this.d.log?.(`${s.name}: stale record discarded`); }
      if (p.live && !this.owned(st.services[s.name])) { // something we do not own answers but is not ready: do not start a second copy on top of it
        out.push({ name: s.name, required: s.required, mode: "external", state: "degraded", detail: `external ${s.name} is up but not ready: ${p.detail}` }); if (s.required) failed.add(s.name); continue;
      }
      if (!s.start) { out.push({ name: s.name, required: s.required, mode: "none", state: "failed", detail: `not running and cannot be started by Dispatch: ${p.detail}` }); if (s.required) failed.add(s.name); continue; }
      if (!this.owned(st.services[s.name])) {
        try {
          const started = await s.start(this.d.instanceId);
          st.services[s.name] = { managed: true, ...started };
          st.phase = "Starting"; writeState(this.d.statePath, st);
        } catch (e) { out.push({ name: s.name, required: s.required, mode: "managed", state: "failed", detail: `start failed: ${(e as Error).message}` }); if (s.required) failed.add(s.name); continue; }
      }
      const deadline = this.now() + (s.readyTimeoutMs ?? 30_000);
      for (;;) { p = await s.probe().catch((e: unknown) => ({ live: false, ready: false, detail: `probe error: ${(e as Error).message}` })); if (p.ready || this.now() >= deadline) break; await this.sleep(200); }
      out.push({ name: s.name, required: s.required, mode: "managed", state: p.ready ? "ready" : "failed", detail: p.ready ? p.detail : `did not become ready within ${(s.readyTimeoutMs ?? 30_000) / 1000}s: ${p.detail}` });
      if (!p.ready && s.required) failed.add(s.name);
    }
    const next = phaseOf(out);
    // Walk the legal edges from the persisted phase (an interrupted Starting/Stopping counts as Failed, then an explicit retry).
    let cur: Phase = st.phase === "Starting" || st.phase === "Stopping" ? "Failed" : st.phase;
    if (cur === "Stopped" || cur === "Failed") cur = transition(cur, "Starting");
    cur = transition(cur, next);
    st.phase = cur; writeState(this.d.statePath, st);
    return { phase: cur, services: out };
  }

  /**
   * Graceful shutdown of OWNED services only (reverse order). With active jobs it refuses unless `confirmed`. External services are reported and left alone;
   * a recorded PID that fails the identity check is never signalled.
   */
  async stop(opts: { confirmed: boolean; activeJobs: number }): Promise<{ stopped: boolean; reason?: "active-jobs"; activeJobs?: number; results: Array<{ name: string; action: "stopped" | "left-external" | "not-running" | "stale-record-dropped" | "kill-refused" }> }> {
    if (opts.activeJobs > 0 && !opts.confirmed) return { stopped: false, reason: "active-jobs", activeJobs: opts.activeJobs, results: [] };
    const st = this.state(); const results: Array<{ name: string; action: "stopped" | "left-external" | "not-running" | "stale-record-dropped" | "kill-refused" }> = [];
    st.phase = "Stopping"; writeState(this.d.statePath, st);
    for (const s of [...this.specs].reverse()) {
      if (s.kind === "observed") continue;
      const rec = st.services[s.name]; const p = await s.probe().catch(() => ({ live: false, ready: false, detail: "" }));
      if (!rec) { results.push({ name: s.name, action: p.live ? "left-external" : "not-running" }); continue; }
      if (s.stop && rec.managed) { // custom stop (managed postgres through its own control tool)
        if (p.live) await s.stop(rec); Reflect.deleteProperty(st.services, s.name); results.push({ name: s.name, action: p.live ? "stopped" : "not-running" }); continue;
      }
      if (!this.owned(rec)) { Reflect.deleteProperty(st.services, s.name); results.push({ name: s.name, action: p.live ? "left-external" : "stale-record-dropped" }); continue; }
      const pid = rec.pid as number;
      try { this.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      const deadline = this.now() + 10_000;
      while (this.owned(rec) && this.now() < deadline) await this.sleep(100);
      if (this.owned(rec)) { try { this.kill(pid, "SIGKILL"); } catch { /* gone */ } } // identity re-verified immediately before the forced kill
      Reflect.deleteProperty(st.services, s.name); results.push({ name: s.name, action: "stopped" });
    }
    st.phase = "Stopped"; writeState(this.d.statePath, st);
    return { stopped: true, results };
  }
}

/** Detached spawn (the child outlives this process and its terminal), logging to a file; identity is read back from the OS. */
export function spawnDetached(cmd: string, args: string[], env: Record<string, string>, logFile: string, cwd?: string): { pid: number } {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = openSync(logFile, "a", 0o600);
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", fd, fd], env, ...(cwd ? { cwd } : {}) });
  closeSync(fd); child.unref();
  if (!child.pid) throw new Error(`failed to spawn ${cmd}`);
  return { pid: child.pid };
}
