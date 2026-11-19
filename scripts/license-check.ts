import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateSbom, runLicenseCheck } from "../packages/checks/src/license/index";

const root = resolve(import.meta.dir, "..");
const sbomIdx = process.argv.indexOf("--sbom");
const report = runLicenseCheck({ root });
if (sbomIdx > -1 && process.argv[sbomIdx + 1]) {
  const out = resolve(process.argv[sbomIdx + 1] as string);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(generateSbom(report.components), null, 2) + "\n");
}
if (!report.ok) {
  console.error(`LICENSE CHECK FAILED (${report.findings.length})`);
  for (const f of report.findings) console.error(`  [${f.code}] ${f.subject}: ${f.message}`);
  process.exit(1);
}
console.log(`LICENSE CHECK PASSED: ${report.components.length} installed packages`);
