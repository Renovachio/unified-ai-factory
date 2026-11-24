import { existsSync, readFileSync } from "node:fs";
import type { DispatchConfig, DispatchPaths } from "@factory/dispatch-core";

export interface Summary { jobs: { inFlight: number; waitingOnHuman: number; total: number }; approvals: { pending: number }; projects: number; workers: { active: number } }

/** Minimal authenticated call with the local owner token (no model access, no shell). DSP-05's shared client supersedes this for the REPL. */
export async function apiCall<T>(cfg: DispatchConfig, paths: DispatchPaths, path: string, init: { method?: string; key?: string } = {}): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  if (!existsSync(paths.token)) return { ok: false, status: 0, error: "no local token yet (factory never started)" };
  try {
    const r = await fetch(`http://${cfg.host}:${cfg.ports.api}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${readFileSync(paths.token, "utf8").trim()}`, ...(init.key ? { "idempotency-key": init.key } : {}) }, signal: AbortSignal.timeout(5000) });
    const j = (await r.json().catch(() => ({}))) as T & { title?: string };
    return r.ok ? { ok: true, data: j } : { ok: false, status: r.status, error: String((j as { title?: string }).title ?? r.status) };
  } catch (e) { return { ok: false, status: 0, error: (e as Error).message }; }
}
export const getSummary = (cfg: DispatchConfig, paths: DispatchPaths) => apiCall<Summary>(cfg, paths, "/api/v2/dispatch/summary");
