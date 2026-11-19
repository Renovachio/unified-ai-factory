import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureConfig, loadConfig, dispatchPaths, forbiddenEnvNames, Lifecycle, type DispatchConfig, type DispatchPaths } from "@factory/dispatch-core";
import { randomUUID } from "node:crypto";
import { readState } from "@factory/dispatch-core";
import { buildSpecs } from "./services";

export interface Ctx { cfg: DispatchConfig; paths: DispatchPaths; lifecycle: Lifecycle; env: Record<string, string | undefined>; forbidden: string[] }

/** Repository root when running from a source checkout (used to find a locally built dashboard); undefined for an installed binary. */
export const repoRootGuess = (): string | undefined => { const here = import.meta.dir; const root = join(here, "../../../.."); return root.endsWith("unified-ai-factory-v2") || here.includes("/apps/dispatch-cli/") ? root : undefined; };

/** `create`: first-run writes default config; read-only commands (status/doctor) never create anything. */
export function makeCtx(opts: { create: boolean; env?: Record<string, string | undefined> } = { create: false }): Ctx {
  const env = opts.env ?? process.env; const paths = dispatchPaths(env);
  if (opts.create) mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const cfg = opts.create ? ensureConfig(paths.config) : loadConfig(paths.config).config;
  const instanceId = readState(paths.state)?.instanceId ?? randomUUID();
  const lifecycle = new Lifecycle(buildSpecs(cfg, paths, env, repoRootGuess()), { statePath: paths.state, instanceId });
  void dirname;
  return { cfg, paths, lifecycle, env, forbidden: forbiddenEnvNames(env) };
}
