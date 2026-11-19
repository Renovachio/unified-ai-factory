// Dispatch pilot harness (DSP-10). Run against a RUNNING installed factory: `DISPATCH_HOME=... bun scripts/dispatch-pilot.ts [--wait-seconds N]`.
//  1. Real-pilot gate check: a real coding pilot needs a configured runtime, a qualified model, a provider authorization and a linked repository.
//     If any is missing the pilot is reported BLOCKED with the exact reasons. Nothing is simulated and nothing is faked as passing.
//  2. Deliberately failing pilot: submit a job when those gates are NOT met and show that the factory does NOT run it (no worker, no agent run, no PR), then cancel it.
import { readFileSync } from "node:fs";
import { dispatchPaths, loadConfig } from "../packages/dispatch-core/src/index";
import { DispatchClient } from "../packages/dispatch-client/src/index";

const waitS = Number(process.argv[process.argv.indexOf("--wait-seconds") + 1] || 10);
const paths = dispatchPaths(); const { config } = loadConfig(paths.config);
const token = readFileSync(paths.token, "utf8").trim();
const c = new DispatchClient({ baseUrl: `http://${config.host}:${config.ports.api}`, headers: () => ({ authorization: `Bearer ${token}` }), timeoutMs: 8000 });
const out: string[] = []; const log = (s: string) => { out.push(s); console.log(s); };

const models = await c.get<{ configLoaded: boolean; summary: { available: number; qualified: number; authorized: number } }>("/api/v2/dispatch/capabilities?category=models");
const projects = await c.get<{ items: Array<{ id: string; name: string; provider: string }> }>("/api/v2/dispatch/projects");
const summary = await c.summary();
const gates = [
  { gate: "runtime available", ok: models.summary.available > 0, evidence: `${models.summary.available} configured` },
  { gate: "model qualified for builder role", ok: models.summary.qualified > 0, evidence: `${models.summary.qualified} qualification record(s)` },
  { gate: "provider authorization recorded", ok: models.summary.authorized > 0, evidence: `${models.summary.authorized} approval(s)` },
  { gate: "a worker is registered and heartbeating", ok: summary.workers.active > 0, evidence: `${summary.workers.active} active` },
  { gate: "a project with provider=github exists (a label only: a real GitHub App link is NOT verified here)", ok: projects.items.some((p) => p.provider === "github"), evidence: `${projects.items.length} project(s)` },
];
log(`# Dispatch pilot — ${new Date().toISOString()}\n\n## 1. Real authorized pilot: gate check`);
for (const g of gates) log(`- [${g.ok ? "x" : " "}] ${g.gate} (${g.evidence})`);
const blockers = gates.filter((g) => !g.ok);
log(blockers.length === 0 ? "\nAll gates met: a real pilot MAY be attempted (this script does not run one automatically)." : `\n**REAL PILOT: BLOCKED** by ${blockers.length} unmet gate(s): ${blockers.map((b) => b.gate).join("; ")}.`);

log("\n## 2. Deliberately failing pilot (gates unmet -> must NOT execute)");
const project = projects.items[0];
if (!project) { log("- No project exists in this factory, so a job cannot even be accepted. Nothing to run. (Blocked at intake: safe.)"); process.exit(blockers.length ? 3 : 0); }
const m = c.mutation("POST", "/api/v1/jobs", { repositoryId: project.id, request: { type: "feature", title: "pilot: deliberately failing", description: "Created by dispatch-pilot to prove the factory refuses to execute without a qualified, authorized runtime.", sourceId: `pilot-${Date.now()}` } });
const created = await c.send<{ jobId: string; state: string; version: number }>(m);
log(`- Submitted job ${created.jobId.slice(0, 8)} (state ${created.state}).`);
await new Promise((r) => setTimeout(r, waitS * 1000));
const snap = await c.snapshot(); const j = snap.jobs.find((x) => x.id === created.jobId);
const events = (await c.events(0, 500)).events.filter((e) => e.jobId === created.jobId).map((e) => e.type);
log(`- After ${waitS}s: state **${j?.state ?? "unknown"}**, PR ${j?.prNumber ?? "none"}, events: ${events.join(", ")}`);
const stayed = j?.state === "QUEUED" && j.prNumber === null && !events.some((t) => /agent|build|pull_request|merge/.test(t));
log(stayed ? "- PASS (blocks safely): the job was accepted but nothing executed — no runtime, no agent run, no branch/PR." : "- FAIL: the job moved or produced side effects without the required gates.");
const cancel = c.mutation("POST", `/api/v1/jobs/${created.jobId}/cancel`, { reason: "pilot cleanup", expectedVersion: j?.revision ?? created.version }); await c.send(cancel);
log(`- Cleanup: job ${created.jobId.slice(0, 8)} cancelled.`);
process.exit(stayed ? (blockers.length ? 3 : 0) : 1); // 3 = real pilot blocked (expected here), 1 = safety failure
