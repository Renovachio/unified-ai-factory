// Usage: bun scripts/run-evals.ts <oracle|blind|noisy|local> [model] [endpoint]
// Writes evidence/EVAL-001/runs/<subject>.json. `local` runs the production prompts through the LocalModelAdapter against a loopback model
// server (no credentials, no network beyond loopback). Re-render the report with: bun scripts/eval-report.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../packages/domain/src/index";
import { registerIntakeSchema } from "../packages/intake/src/index";
import { InferenceSourcePolicy, loadPolicyConfig, LocalModelAdapter, SchemaRegistry } from "../packages/runtimes/src/index";
import { detectBackend } from "../packages/sandboxes/src/index";
import { AdapterSubject, BlindSubject, NoisySubject, OracleSubject, runBenchmark, type EvalSubject } from "../packages/evals/src/index";

const [kind = "oracle", model = "qwen3.5:4b", endpoint = "http://127.0.0.1:11434"] = process.argv.slice(2);
const root = join(import.meta.dir, "..");
const { policy, digest } = loadPolicy(join(root, "config"));
let subject: EvalSubject; let modelName = "n/a";
if (kind === "oracle") subject = new OracleSubject();
else if (kind === "blind") subject = new BlindSubject();
else if (kind === "noisy") { subject = new NoisySubject("noisy-0.7", 0.7, 0.34, 0.5); modelName = "deterministic stand-in (recall .7, fp .34)"; }
else if (kind === "local") {
  const ctx = new Map<string, string>();
  const schemas = registerIntakeSchema(new SchemaRegistry());
  const adapter = new LocalModelAdapter({
    endpoint, policy: new InferenceSourcePolicy(loadPolicyConfig(join(root, "config"))), env: { PATH: process.env.PATH ?? "" }, extraBody: { think: false, reasoning_effort: "none" },
    loadContext: async (uri) => ctx.get(uri) ?? "{}", schemas,
  });
  subject = new AdapterSubject(`local-model`, adapter, model, ctx);
  modelName = model;
} else throw new Error(`unknown subject ${kind}`);

const r = await runBenchmark({
  subject, model: modelName, policy, policyDigest: digest, backend: detectBackend(), workspaceRoot: mkdtempSync(join(tmpdir(), "eval-run-")),
  onProgress: (d, t, id) => console.error(`[${kind}] ${d}/${t} ${id}`),
});
mkdirSync(join(root, "evidence/EVAL-001/runs"), { recursive: true });
writeFileSync(join(root, `evidence/EVAL-001/runs/${kind}.json`), JSON.stringify(r, null, 2) + "\n");
console.log(JSON.stringify(r.metrics, null, 2));
