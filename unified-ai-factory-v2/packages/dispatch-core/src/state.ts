import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Phase = "Stopped" | "Starting" | "Ready" | "Degraded" | "Failed" | "Stopping";
/** ARCHITECTURE lifecycle: the only legal edges. */
const EDGES: Record<Phase, readonly Phase[]> = {
  Stopped: ["Starting"], Starting: ["Ready", "Degraded", "Failed"], Ready: ["Stopping", "Degraded", "Failed"], Degraded: ["Ready", "Stopping", "Failed"], Failed: ["Starting", "Stopping"], Stopping: ["Stopped"],
};
export class IllegalTransition extends Error { constructor(from: Phase, to: Phase) { super(`illegal lifecycle transition ${from} -> ${to}`); } }
export function transition(from: Phase, to: Phase): Phase { if (from === to) return to; if (!EDGES[from].includes(to)) throw new IllegalTransition(from, to); return to; }

export interface ServiceRecord { managed: boolean; pid?: number; startedAt?: string; marker?: string; port?: number; cwd?: string }
export interface SupervisorState { schemaVersion: 1; instanceId: string; phase: Phase; services: Record<string, ServiceRecord>; updatedAt: string }

export function readState(path: string): SupervisorState | null {
  if (!existsSync(path)) return null;
  try { const s = JSON.parse(readFileSync(path, "utf8")) as SupervisorState; return s && s.schemaVersion === 1 && typeof s.instanceId === "string" && s.services && typeof s.services === "object" ? s : null; } catch { return null; }
}
export function writeState(path: string, s: SupervisorState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, path);
}
