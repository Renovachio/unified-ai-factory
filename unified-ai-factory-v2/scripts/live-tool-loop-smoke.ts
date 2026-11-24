// LIVE smoke of the local tool loop (RT-05) against a REAL local model on loopback, in a DISPOSABLE repo under the OS sandbox.
// Local compute only; no credentials; no network beyond loopback. The model used here is NOT qualified for the builder role: this proves the
// mechanism (read/edit/test/iterate), not model fitness, and the factory's runtime selection refuses it for real builder work.
// Usage: bun scripts/live-tool-loop-smoke.ts [model] [endpoint] [out.json]
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxEnv, createWorkspace, detectBackend, runSandboxed, teardownWorkspace } from "../packages/sandboxes/src/index";
import { InferenceSourcePolicy, loadPolicyConfig, runToolLoop, ToolHost, toolsetDigest } from "../packages/runtimes/src/index";

const model = process.argv[2] ?? "qwen3.5:4b";
const endpoint = process.argv[3] ?? "http://127.0.0.1:11434";
const out = process.argv[4] ?? join(import.meta.dir, "../evidence/ACT-01/live-tool-loop.json");
const policy = new InferenceSourcePolicy(loadPolicyConfig(join(import.meta.dir, "../config")));
const base = mkdtempSync(join(tmpdir(), "live-loop-"));
const ws = createWorkspace(base, "liveloop");
mkdirSync(join(ws.repoDir, "src"));
writeFileSync(join(ws.repoDir, "src/slug.js"), "export function slugify(s) {\n  return s; // TODO: lowercase, trim, replace runs of non-alphanumerics with a single '-'\n}\n");
writeFileSync(join(ws.repoDir, "check.mjs"), `import { slugify } from "./src/slug.js";
const cases = [["Hello World", "hello-world"], ["  A  b--C ", "a-b-c"], ["Ünï!", "n"]];
let bad = 0; for (const [i, o] of cases) { const g = slugify(i); if (g !== o) { bad++; console.log("FAIL", JSON.stringify(i), "->", JSON.stringify(g), "expected", JSON.stringify(o)); } }
console.log(bad ? bad + " failing" : "all passing"); process.exit(bad ? 1 : 0);
`);
const backend = detectBackend();
const bun = process.execPath;
const check = async () => { const r = await runSandboxed({ backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: bun, args: ["check.mjs"], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }, { PATH: process.env.PATH ?? "" }), timeoutMs: 20_000, readOnlyPaths: [bun.replace(/\/[^/]*$/, "")] }); return { exitCode: r.exitCode, output: r.stdout + r.stderr }; };
const host = new ToolHost({ repoDir: ws.repoDir, checks: { test: check } });
const events: unknown[] = [];
const t0 = Date.now();
const before = readFileSync(join(ws.repoDir, "src/slug.js"), "utf8");
const res = await runToolLoop({
  endpoint, policy, env: { PATH: process.env.PATH ?? "" }, modelId: model, host, maxIterations: 10, maxWallMs: 420_000,
  extraBody: { think: false, reasoning_effort: "none" }, onEvent: (t, p) => events.push({ t, ...p }),
  system: "You are a careful software engineer. Use the tools to read files, edit them and run the `test` check. Make the check pass by editing src/slug.js only. When the check passes, reply with a one-line summary and no tool call.",
  task: "Implement slugify in src/slug.js so that `run_check` with name `test` passes. Read src/slug.js and check.mjs first.",
});
const final = await check();
const report = {
  model, endpoint, backend: backend.name, bun: Bun.version, elapsedMs: Date.now() - t0, loop: res,
  independentCheckAfterLoop: { exitCode: final.exitCode, output: final.output.slice(-400) },
  fileChanged: readFileSync(join(ws.repoDir, "src/slug.js"), "utf8") !== before, diff: { before, after: readFileSync(join(ws.repoDir, "src/slug.js"), "utf8") },
  eventsSummary: events, toolsetDigest: toolsetDigest(["test"]),
  caveat: "Model is NOT qualified for the builder role; this demonstrates the controlled tool loop on a live local engine only.",
};
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: res.status, iterations: res.iterations, toolCalls: res.toolCalls, invalidCalls: res.invalidCalls, changed: res.changedFiles, independentCheckExit: final.exitCode, elapsedMs: report.elapsedMs }));
teardownWorkspace(base, ws); rmSync(base, { recursive: true, force: true });
