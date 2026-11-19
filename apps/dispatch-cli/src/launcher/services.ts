import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { childEnv, processIdentity, spawnDetached, type DispatchConfig, type DispatchPaths, type Probe, type ServiceSpec, type Started } from "@factory/dispatch-core";
import { databaseUrl, postgresSpec } from "./postgres";
import { selfCommand, configDir } from "./runtime";

export function ensureSecret(path: string, bytes = 32): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const v = randomBytes(bytes).toString("base64url"); writeFileSync(path, v + "\n", { mode: 0o600 }); chmodSync(path, 0o600); return v;
}
const apiUrl = (c: DispatchConfig) => `http://${c.host}:${c.ports.api}`;
export const dashboardUrl = (c: DispatchConfig) => `http://${c.host}:${c.ports.web}`;

async function http(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string } | null> {
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000), redirect: "manual" }); return { status: r.status, body: (await r.text()).slice(0, 2000) }; } catch { return null; }
}

export interface DashboardLocation { dir: string; entry: string }
/** Where the packaged dashboard lives: explicit override, next to the binary (install layout), or a source checkout's standalone build. */
export function findDashboard(env: Record<string, string | undefined>, execPath = process.execPath, repoRoot?: string): DashboardLocation | null {
  if (env.DISPATCH_DASHBOARD_DIR !== undefined) { const d = env.DISPATCH_DASHBOARD_DIR; return existsSync(join(d, "server.js")) ? { dir: d, entry: join(d, "server.js") } : null; } // an explicit override is never silently replaced
  const cands = [join(execPath, "..", "..", "dashboard", "apps", "web"), repoRoot ? join(repoRoot, "apps/web/.next/standalone/apps/web") : undefined];
  for (const d of cands) if (d && existsSync(join(d, "server.js"))) return { dir: d, entry: join(d, "server.js") };
  return null;
}

export function buildSpecs(cfg: DispatchConfig, paths: DispatchPaths, env: Record<string, string | undefined> = process.env, repoRoot?: string): ServiceSpec[] {
  const pg = postgresSpec(cfg, paths, env);
  const self = selfCommand(process.execPath, env.DISPATCH_SELF_MAIN ?? process.argv[1] ?? "");
  const token = () => readFileSync(paths.token, "utf8").trim();

  const api: ServiceSpec = {
    name: "api", required: true, kind: "startable", dependsOn: ["postgres"], readyTimeoutMs: 30_000,
    probe: async (): Promise<Probe> => {
      const live = await http(`${apiUrl(cfg)}/api/v1/health/live`);
      if (!live) return { live: false, ready: false, detail: "not listening" };
      if (live.status !== 200 || !/"status":"ok"/.test(live.body)) return { live: true, ready: false, detail: `port ${cfg.ports.api} is answered by something that is not the factory API` };
      const ready = await http(`${apiUrl(cfg)}/api/v1/health/ready`);
      return ready?.status === 200 ? { live: true, ready: true, detail: `listening on ${cfg.host}:${cfg.ports.api}` } : { live: true, ready: false, detail: "API is up but the database is not ready" };
    },
    start: async (marker): Promise<Started> => {
      ensureSecret(paths.token, 32); const sessionFile = join(paths.secrets, "session-secret"); ensureSecret(sessionFile, 32);
      const e = childEnv(env, { DATABASE_URL: databaseUrl(cfg, paths), PORT: String(cfg.ports.api), HOST: cfg.host, DISPATCH_LOCAL_TOKEN_FILE: paths.token, DISPATCH_SESSION_SECRET_FILE: sessionFile, DISPATCH_DASHBOARD_URL: dashboardUrl(cfg), ALLOWED_ORIGINS: dashboardUrl(cfg), DISPATCH_HOME: paths.home, ...(configDir(env) ? { DISPATCH_CONFIG_DIR: configDir(env) as string } : {}) });
      const m = `--dispatch-instance=${marker}`;
      const { pid } = spawnDetached(self.cmd, [...self.prefix, "__serve", "api", m], e, join(paths.logs, "api.log"));
      await new Promise((r) => setTimeout(r, 200)); const id = processIdentity(pid);
      return { pid, ...(id ? { startedAt: id.startedAt } : {}), marker: m, port: cfg.ports.api };
    },
  };

  const dash = findDashboard(env, process.execPath, repoRoot);
  const dashboard: ServiceSpec = {
    name: "dashboard", required: false, kind: "startable", dependsOn: ["api"], readyTimeoutMs: 40_000,
    probe: async (): Promise<Probe> => {
      const r = await http(`${dashboardUrl(cfg)}/`);
      if (!r) return { live: false, ready: false, detail: "not listening" };
      return r.status < 500 ? { live: true, ready: true, detail: `listening on ${cfg.host}:${cfg.ports.web}` } : { live: true, ready: false, detail: `HTTP ${r.status}` };
    },
    start: async (marker): Promise<Started> => {
      if (!dash) throw new Error("dashboard build not found (set DISPATCH_DASHBOARD_DIR or reinstall Dispatch)");
      const nodeBin = env.DISPATCH_NODE ?? "node";
      const e = childEnv(env, { PORT: String(cfg.ports.web), HOSTNAME: cfg.host, FACTORY_API_URL: apiUrl(cfg), APP_ORIGIN: dashboardUrl(cfg), NODE_ENV: "production" });
      const m = `--dispatch-instance=${marker}`;
      const { pid } = spawnDetached(nodeBin, [dash.entry, m], e, join(paths.logs, "dashboard.log"), dash.dir);
      await new Promise((r) => setTimeout(r, 300)); const id = processIdentity(pid);
      return { pid, ...(id ? { startedAt: id.startedAt } : {}), marker: m, port: cfg.ports.web, cwd: dash.dir };
    },
  };

  const runner: ServiceSpec = {
    name: "runner", required: false, kind: "observed",
    probe: async (): Promise<Probe> => {
      if (!existsSync(paths.token)) return { live: false, ready: false, detail: "unknown (API not started)" };
      const r = await http(`${apiUrl(cfg)}/api/v1/workers`, { authorization: `Bearer ${token()}` });
      if (!r || r.status !== 200) return { live: false, ready: false, detail: "worker list unavailable" };
      try { const items = (JSON.parse(r.body.length >= 2000 ? "{}" : r.body) as { items?: Array<{ status: string }> }).items ?? []; const active = items.filter((w) => w.status === "active").length; return active > 0 ? { live: true, ready: true, detail: `${active} worker(s) registered` } : { live: true, ready: false, detail: "no worker registered (no worker daemon is managed by Dispatch yet)" }; } catch { return { live: true, ready: false, detail: "no worker registered (no worker daemon is managed by Dispatch yet)" }; }
    },
  };
  return [pg, api, dashboard, runner];
}
