#!/usr/bin/env bun
// Operator entry point for the memory retention policy (MEM-05). Runs one sweep and exits, or repeats in the foreground with --every-hours N.
// Nothing schedules this automatically: run it from cron/launchd/systemd, or in the foreground. Each run writes one audit row.
//
// Required environment:
//   DATABASE_URL                  connection for a role with the memory write grants (factory_control; see migrations 0017-0024)
//   DISPATCH_ARTIFACT_ROOT        the SAME root as the context pack text store, or pack text cannot be found and removed
//   DISPATCH_RETENTION_STEWARD_ID an enabled steward user of the organization (approver, admin or security_officer); erasures are attributed to this user
//
// Usage: bun scripts/memory-retention.ts [--every-hours N]
import { connect } from "../packages/db/src/index";
import { runRetentionSweep } from "../packages/memory/src/index";
import { FileArtifactStore } from "../packages/orchestrator/src/index";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) { console.error(`missing required environment variable ${k}`); process.exit(2); }
  return v;
};

const everyIdx = process.argv.indexOf("--every-hours");
const everyHours = everyIdx >= 0 ? Number(process.argv[everyIdx + 1]) : 0;
if (everyIdx >= 0 && !(everyHours > 0 && everyHours <= 24 * 31)) { console.error("--every-hours needs a number between 0 and 744"); process.exit(2); }

const sql = connect(need("DATABASE_URL"));
const store = new FileArtifactStore(need("DISPATCH_ARTIFACT_ROOT"));
const steward = need("DISPATCH_RETENTION_STEWARD_ID");

async function once(): Promise<void> {
  const r = await runRetentionSweep(sql, store, steward);
  console.log(JSON.stringify({ level: "info", event: "memory.retention", organizationId: r.organizationId, at: r.at, projects: r.projects }));
}

try {
  await once();
  if (everyHours > 0) {
    for (;;) {
      await new Promise((res) => setTimeout(res, everyHours * 3_600_000));
      await once();
    }
  }
} catch (e) {
  console.error(JSON.stringify({ level: "error", event: "memory.retention.failed", error: String((e as Error).message).slice(0, 300) }));
  process.exitCode = 1;
} finally {
  if (everyHours === 0) await sql.end();
}
