import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CONFIG_SCHEMA_VERSION = 1;

export interface DispatchConfig {
  schemaVersion: number;
  host: "127.0.0.1";
  ports: { api: number; web: number };
  postgres: { mode: "managed" | "external"; url?: string };
  browser: { open: boolean };
}
export const DEFAULT_CONFIG: DispatchConfig = { schemaVersion: CONFIG_SCHEMA_VERSION, host: "127.0.0.1", ports: { api: 8787, web: 3000 }, postgres: { mode: "managed" }, browser: { open: true } };

export class ConfigError extends Error {
  constructor(readonly code: "invalid" | "newer-version" | "unreadable", message: string, readonly remediation: string) { super(message); }
}
const isPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1024 && (n as number) <= 65535;

/**
 * Strict validation. Unknown keys, wrong types, a non-loopback host or a newer schema version are errors with a remediation; nothing is repaired
 * or rewritten implicitly (a damaged file is never overwritten by a default).
 */
export function validateConfig(raw: unknown): DispatchConfig {
  const bad = (m: string): never => { throw new ConfigError("invalid", `config: ${m}`, "Fix the file by hand or move it aside; Dispatch will not rewrite it."); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("must be a JSON object");
  const c = raw as Record<string, unknown>;
  if (!Number.isInteger(c.schemaVersion)) return bad("schemaVersion must be an integer");
  if ((c.schemaVersion as number) > CONFIG_SCHEMA_VERSION) throw new ConfigError("newer-version", `config schemaVersion ${String(c.schemaVersion)} is newer than this Dispatch (${CONFIG_SCHEMA_VERSION})`, "Upgrade Dispatch; do not downgrade over a newer config.");
  const allowed = new Set(["schemaVersion", "host", "ports", "postgres", "browser"]);
  for (const k of Object.keys(c)) if (!allowed.has(k)) return bad(`unknown key "${k}"`);
  if (c.host !== "127.0.0.1") return bad('host must be "127.0.0.1" (the factory is loopback-only)');
  const p = c.ports as Record<string, unknown> | undefined;
  if (!p || !isPort(p.api) || !isPort(p.web) || p.api === p.web) return bad("ports.api and ports.web must be distinct integers 1024-65535");
  const pg = c.postgres as Record<string, unknown> | undefined;
  if (!pg || (pg.mode !== "managed" && pg.mode !== "external")) return bad('postgres.mode must be "managed" or "external"');
  if (pg.mode === "external" && (typeof pg.url !== "string" || !/^postgres(ql)?:\/\//.test(pg.url))) return bad("postgres.url (postgres://...) is required for external mode");
  if (pg.mode === "managed" && pg.url !== undefined) return bad("postgres.url is only valid for external mode");
  const b = c.browser as Record<string, unknown> | undefined;
  if (!b || typeof b.open !== "boolean") return bad("browser.open must be a boolean");
  return { schemaVersion: c.schemaVersion as number, host: "127.0.0.1", ports: { api: p.api, web: p.web }, postgres: pg.mode === "external" ? { mode: "external", url: pg.url as string } : { mode: "managed" }, browser: { open: b.open } };
}

/** Missing file => defaults (not written). Present but unreadable/invalid => error. */
export function loadConfig(path: string): { config: DispatchConfig; fromFile: boolean } {
  if (!existsSync(path)) return { config: structuredClone(DEFAULT_CONFIG), fromFile: false };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new ConfigError("unreadable", `cannot read config ${path}: ${(e as Error).message}`, "Fix or move the file aside."); }
  return { config: validateConfig(raw), fromFile: true };
}

/** First-run only: writes defaults if no config exists; never overwrites. */
export function ensureConfig(path: string): DispatchConfig {
  const { config, fromFile } = loadConfig(path);
  if (!fromFile) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, path); }
  return config;
}
