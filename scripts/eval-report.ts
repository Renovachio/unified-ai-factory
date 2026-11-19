// Renders docs/evals/REPORT.md from every evidence/EVAL-001/runs/*.json (deterministic for fixed inputs).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy } from "../packages/domain/src/index";
import { loadThresholds, renderReport, type BenchmarkResult } from "../packages/evals/src/index";

const root = join(import.meta.dir, "..");
const dir = join(root, "evidence/EVAL-001/runs");
const order = ["oracle", "blind", "noisy", "local"];
const runs = readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) => order.indexOf(a.replace(".json", "")) - order.indexOf(b.replace(".json", ""))).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as BenchmarkResult);
const notes: Record<string, string> = {
  oracle: "Ground-truth stand-in (upper bound) — validates that fixtures, hidden tests and scoring are consistent.",
  "blind-approver": "Approves everything and proposes LOW (lower bound).",
  "noisy-0.7": "Deterministic degraded stand-in: finds ~70% of seeded defects, false-alarms on clean diffs, writes correct code for ~half of the builder tasks.",
  "local-model": "REAL local model via the LocalModelAdapter (loopback, no credentials). Production prompts, strict output schemas, hidden tests executed in the confinement sandbox.",
};
const { digest } = loadPolicy(join(root, "config"));
const md = renderReport(runs.map((result) => ({ result, note: notes[result.subject] ?? "" })), loadThresholds(join(root, "config")), { generatedAt: runs.map((r) => r.startedAt).sort().at(-1) ?? "", policyDigest: digest });
writeFileSync(join(root, "docs/evals/REPORT.md"), md);
console.log(`wrote docs/evals/REPORT.md from ${runs.length} runs`);
