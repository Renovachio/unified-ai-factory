// Pins the digest of every factory-owned gate manifest. `--check` (used by CI and tests) fails if a manifest changed without re-pinning.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GateManifestSchema, manifestDigest } from "../packages/checks/src/gates/manifest";

const dir = resolve(import.meta.dir, "../config");
const profiles: Record<string, string> = {};
for (const f of readdirSync(join(dir, "gates")).filter((x) => x.endsWith(".json")).sort()) {
  const m = GateManifestSchema.parse(JSON.parse(readFileSync(join(dir, "gates", f), "utf8")));
  profiles[m.profile] = manifestDigest(m);
}
const lock = JSON.stringify({ schemaVersion: 1, note: "Operator-maintained pin of gate manifest digests. Re-pin only after human review of the manifest change.", profiles }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(join(dir, "gates.lock.json"), "utf8"); } catch { /* missing */ }
  if (current !== lock) { console.error("GATE LOCK MISMATCH: config/gates changed without re-pinning (bun scripts/gates-lock.ts)"); process.exit(1); }
  console.log(`gate lock ok (${Object.keys(profiles).length} profile(s))`);
} else { writeFileSync(join(dir, "gates.lock.json"), lock); console.log("pinned", profiles); }
