// One "dispatch launch" in its own process: take the startup lock, then attach/start. Prints the result as JSON.
import { join } from "node:path";
import { acquireLock, dispatchPaths, Lifecycle, spawnDetached, processIdentity, type ServiceSpec } from "../src/index";

const home = process.env.DISPATCH_HOME as string; const port = Number(process.env.SVC_PORT); const instance = process.env.INSTANCE ?? "inst-1";
const paths = dispatchPaths({ DISPATCH_HOME: home });
const spec: ServiceSpec = {
  name: "api", required: true, kind: "startable", readyTimeoutMs: 15_000,
  probe: async () => { try { const r = await fetch(`http://127.0.0.1:${port}/health`); return { live: true, ready: r.ok, detail: `HTTP ${r.status}` }; } catch { return { live: false, ready: false, detail: "connection refused" }; } },
  start: async (marker) => {
    const { pid } = spawnDetached(process.execPath, [join(import.meta.dir, "fake-service.ts"), String(port), `--dispatch-instance=${marker}`], { PATH: process.env.PATH ?? "" }, join(paths.logs, "api.log"));
    await new Promise((r) => setTimeout(r, 150));
    const id = processIdentity(pid);
    return { pid, ...(id ? { startedAt: id.startedAt } : {}), marker: `--dispatch-instance=${marker}`, port };
  },
};
const release = await acquireLock(paths.lock, { timeoutMs: 20_000 });
try {
  const lc = new Lifecycle([spec], { statePath: paths.state, instanceId: instance });
  console.log(JSON.stringify(await lc.ensure()));
} finally { release(); }
