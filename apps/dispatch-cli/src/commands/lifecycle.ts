import { createInterface } from "node:readline/promises";
import { statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { acquireLock, LockTimeout, type ServiceStatus } from "@factory/dispatch-core";
import { apiCall, getSummary, type Summary } from "../launcher/api";
import { openBrowser } from "../launcher/browser";
import { makeCtx, type Ctx } from "../launcher/context";
import { findPg, runMigrations, schemaState, databaseUrl } from "../launcher/postgres";
import { dashboardUrl, findDashboard } from "../launcher/services";
import { color, HEADER, safe, sym } from "../render";
import { DISPATCH_VERSION } from "../version";

const LABEL: Record<string, string> = { postgres: "Database", api: "Factory API", dashboard: "Dashboard", runner: "Local runner" };
export function renderServices(services: ServiceStatus[], out: (s: string) => void = console.log): void {
  for (const s of services) {
    const icon = s.state === "ready" ? sym.ok() : s.state === "failed" ? sym.fail() : s.state === "stopped" ? sym.none() : sym.warn();
    const tag = s.mode === "managed" ? "managed" : s.mode === "external" ? "external" : s.mode === "observed" ? "observed" : "";
    out(`${icon} ${(LABEL[s.name] ?? s.name).padEnd(14)} ${s.state === "ready" ? "Online" : (s.state[0] ?? "").toUpperCase() + s.state.slice(1)}${tag ? color.dim(` (${tag})`) : ""} ${color.dim("— " + safe(s.detail))}`);
  }
}
const summaryLine = (s: Summary) => `${s.jobs.inFlight} job(s) in flight · ${s.jobs.waitingOnHuman} waiting on you · ${s.approvals.pending} approval(s) pending`;

export async function startFactory(c: Ctx, opts: { quiet?: boolean } = {}): Promise<{ ok: boolean; phase: string; services: ServiceStatus[] }> {
  if (c.forbidden.length) console.error(`${sym.warn()} model-provider variables present in your shell (${c.forbidden.join(", ")}): they are NOT passed to any Dispatch process. Dispatch never uses usage-billed inference.`);
  let release: (() => void) | undefined;
  try { release = await acquireLock(c.paths.lock, { timeoutMs: 60_000 }); } catch (e) { if (e instanceof LockTimeout) { console.error(`${sym.fail()} ${e.message}`); return { ok: false, phase: "Failed", services: [] }; } throw e; }
  try {
    const r = await c.lifecycle.ensure();
    if (!opts.quiet) renderServices(r.services);
    return { ok: r.phase !== "Failed", phase: r.phase, services: r.services };
  } finally { release(); }
}

export async function cmdStart(args: string[]): Promise<number> {
  const c = makeCtx({ create: true }); void args;
  console.log(HEADER()); const r = await startFactory(c);
  if (r.phase === "Failed") { console.error(`\n${sym.fail()} Factory failed to start. Run \`dispatch doctor\` for remediation, then \`dispatch start\` to retry.`); return 1; }
  console.log(r.phase === "Degraded" ? `\n${sym.warn()} Running degraded (see above).` : `\n${sym.ok()} Factory ready.`); return 0;
}

export async function cmdStatus(): Promise<number> {
  const c = makeCtx({ create: false }); const st = await c.lifecycle.status();
  console.log(HEADER()); renderServices(st.services);
  const api = st.services.find((s) => s.name === "api");
  if (api?.state === "ready") { const s = await getSummary(c.cfg, c.paths); console.log(s.ok ? `${s.data.projects} project(s) · ${summaryLine(s.data)}` : `${sym.warn()} could not read job summary: ${safe(s.error)}`); }
  console.log(color.dim(`state: ${st.phase} · dispatch ${DISPATCH_VERSION}`));
  return st.phase === "Failed" || st.phase === "Stopped" ? 1 : 0;
}

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim()); } finally { rl.close(); }
}

export async function cmdStop(args: string[]): Promise<number> {
  const c = makeCtx({ create: false }); const yes = args.includes("--yes");
  const st = await c.lifecycle.status(); const api = st.services.find((s) => s.name === "api");
  let inFlight = 0;
  if (api?.state === "ready") { const s = await getSummary(c.cfg, c.paths); if (!s.ok) { console.error(`${sym.fail()} cannot determine active jobs (${safe(s.error)}); refusing to stop. Fix the API or investigate.`); return 1; } inFlight = s.data.jobs.inFlight; }
  if (inFlight > 0 && !yes) {
    console.log(`${sym.warn()} ${inFlight} job(s) are in flight. Stopping the factory will interrupt them (they resume on the next start, but running work is lost).`);
    if (!(await confirm("Stop anyway?"))) { console.log("Not stopped. Use `dispatch stop --yes` to confirm non-interactively."); return 2; }
  }
  const r = await c.lifecycle.stop({ confirmed: true, activeJobs: inFlight });
  for (const x of r.results) console.log(`${x.action === "stopped" ? sym.ok() : sym.none()} ${(LABEL[x.name] ?? x.name).padEnd(14)} ${x.action}`);
  if (r.results.length === 0) console.log("Nothing was owned by Dispatch; nothing stopped.");
  return 0;
}

export async function cmdMigrate(args: string[]): Promise<number> {
  const c = makeCtx({ create: false }); const url = databaseUrl(c.cfg, c.paths);
  const st = await schemaState(url).catch((e: Error) => { console.error(`${sym.fail()} cannot reach the database: ${safe(e.message)}`); return null; });
  if (!st) return 1;
  if (st.unknown.length) { console.error(`${sym.fail()} the database has migrations this Dispatch does not know (${st.unknown.join(", ")}). Upgrade Dispatch; migrating is refused.`); return 1; }
  if (st.pending.length === 0) { console.log(`${sym.ok()} schema is current (${st.applied.at(-1)}).`); return 0; }
  console.log(`Pending migrations (additive, reversible): ${st.pending.join(", ")}`);
  if (!args.includes("--yes") && !(await confirm("Apply them to the database now?"))) { console.log("Not applied. Re-run with --yes to confirm."); return 2; }
  const done = await runMigrations(url); console.log(`${sym.ok()} applied ${done.join(", ") || "nothing"}`); return 0;
}

export async function cmdDoctor(): Promise<number> {
  const out: Array<{ level: "ok" | "warn" | "fail"; msg: string; fix?: string }> = [];
  const add = (level: "ok" | "warn" | "fail", msg: string, fix?: string) => out.push({ level, msg, ...(fix ? { fix } : {}) });
  let c: Ctx | null = null;
  try { c = makeCtx({ create: false }); add("ok", "config valid"); } catch (e) { add("fail", (e as Error).message, (e as { remediation?: string }).remediation); }
  add(process.platform === "darwin" ? "ok" : "warn", `platform ${process.platform} ${process.arch}`, process.platform === "darwin" ? undefined : "macOS is the supported target");
  const node = spawnSync(c?.env.DISPATCH_NODE ?? "node", ["--version"], { encoding: "utf8" });
  add(node.status === 0 ? "ok" : "warn", node.status === 0 ? `node ${node.stdout.trim()} (needed for the dashboard)` : "node not found: the dashboard cannot start (the CLI and API still work)", node.status === 0 ? undefined : "brew install node");
  if (c) {
    if (c.cfg.postgres.mode === "managed") { const pg = findPg("pg_ctl", c.env); add(pg ? "ok" : "fail", pg ? `PostgreSQL binaries: ${pg}` : "PostgreSQL 17 binaries not found", pg ? undefined : "brew install postgresql@17"); } else add("ok", "PostgreSQL: external (never started or stopped by Dispatch)");
    add(c.forbidden.length ? "warn" : "ok", c.forbidden.length ? `model-provider variables in this shell: ${c.forbidden.join(", ")} (never forwarded to Dispatch processes)` : "no model-provider credentials in the environment", c.forbidden.length ? "unset them if you do not need them in this shell" : undefined);
    const st = await c.lifecycle.status();
    for (const s of st.services) add(s.state === "ready" ? "ok" : s.state === "stopped" ? "warn" : s.required ? "fail" : "warn", `${LABEL[s.name] ?? s.name}: ${s.state} — ${safe(s.detail)}`, s.state === "ready" ? undefined : s.state === "stopped" ? "run `dispatch start`" : undefined);
    if (existsSync(c.paths.token)) { const mode = statSync(c.paths.token).mode & 0o777; add(mode === 0o600 ? "ok" : "fail", mode === 0o600 ? "local owner token is private (0600)" : `local owner token permissions are ${mode.toString(8)}`, mode === 0o600 ? undefined : `chmod 600 ${c.paths.token}`); }
    const dash = findDashboard(c.env, process.execPath, undefined); add(dash ? "ok" : "warn", dash ? `dashboard build: ${dash.dir}` : "dashboard build not found next to this install", dash ? undefined : "reinstall Dispatch or set DISPATCH_DASHBOARD_DIR");
    add("ok", `dashboard address: ${dashboardUrl(c.cfg)} (loopback only)`);
  }
  for (const o of out) console.log(`${o.level === "ok" ? sym.ok() : o.level === "warn" ? sym.warn() : sym.fail()} ${o.msg}${o.fix ? color.dim(`\n    fix: ${o.fix}`) : ""}`);
  return out.some((o) => o.level === "fail") ? 1 : 0;
}

export async function launchBrowser(c: Ctx, services: ServiceStatus[]): Promise<void> {
  const dash = services.find((s) => s.name === "dashboard");
  if (dash?.state !== "ready") { console.log(`${sym.warn()} Dashboard not available; skipping browser. Use the terminal.`); return; }
  const code = await apiCall<{ code: string }>(c.cfg, c.paths, "/api/v2/dispatch/browser-code", { method: "POST", key: `browser-${Date.now()}` });
  const url = code.ok ? `http://${c.cfg.host}:${c.cfg.ports.api}/api/v1/local/enter?code=${encodeURIComponent(code.data.code)}` : dashboardUrl(c.cfg);
  const r = openBrowser(url, c.cfg);
  console.log(r.opened ? `${sym.ok()} Dashboard opened ${color.dim("(" + dashboardUrl(c.cfg) + ")")}` : `${sym.warn()} Could not open a browser (${r.reason}). Open ${dashboardUrl(c.cfg)} yourself.`);
}
