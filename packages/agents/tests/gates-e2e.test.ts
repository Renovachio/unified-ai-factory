import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGatePort, EvidenceSigner, generateEvidenceKeypair, loadLockedManifest, verifyStoredGateEvidence } from "@factory/checks";
import { readEvents } from "@factory/db";
import { buildContextManifest, createIntakeHandler, registerIntakeSchema } from "@factory/intake";
import { agentTaskExecutor, builderTaskExecutor, composeExecutors, FileArtifactStore, mockPorts, Orchestrator, type BuilderRuntime } from "@factory/orchestrator";
import { enrollWorker, runOnce, type RunnerConfig } from "@factory/runner";
import { MockAdapter, SchemaRegistry, type AgentRunRequest } from "@factory/runtimes";
import { detectBackend } from "@factory/sandboxes";
import { candidateScm } from "@factory/scm";
import { createTestDb } from "../../db/src/testing";
import { createSpecHandler, registerSpecSchemas, type Design, type Requirements, type Spec } from "../src/index";

const REAL_CONFIG = join(import.meta.dir, "../../../config");
const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...GIT_ENV, HOME: mkdtempSync(join(tmpdir(), "gh-")) } }).trim();
const keys = generateEvidenceKeypair();

const requirements = (): Requirements => ({ acceptance_criteria: [{ id: "AC-1", text: "search works", observable: "x" }], assumptions: [], out_of_scope: [] });
const design = (): Design => ({ approach: "a", files_affected: [{ path: "src/search.ts", change: "modify" }, { path: "tests/search.test.ts", change: "add" }, { path: "package.json", change: "modify" }], threat_notes: [], risks: [] });
const spec = (): Spec => ({ tasks: [{ id: "T-1", title: "t", files: ["src/search.ts", "tests/search.test.ts"], covers: ["AC-1"], checks: ["C-1"] }], checks: [{ id: "C-1", description: "d", covers: ["AC-1"], runs: { test_file: "tests/search.test.ts" } }], test_strategy: "" });

let db: Awaited<ReturnType<typeof createTestDb>>;
let org = ""; let repo = ""; let remote = ""; let baseSha = ""; let n = 0;
const store = new FileArtifactStore(mkdtempSync(join(tmpdir(), "cas-")));
const wsRoot = mkdtempSync(join(tmpdir(), "gate-e2e-"));
const schemas = registerSpecSchemas(registerIntakeSchema(new SchemaRegistry()));
const cfg = (): RunnerConfig => ({ sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" }, heartbeatMs: 1000 });

beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id;
  const root = mkdtempSync(join(tmpdir(), "gate-e2e-remote-"));
  remote = join(root, "remote.git"); const seed = join(root, "seed");
  mkdirSync(seed); sh(root, "init", "--bare", "-b", "main", remote); sh(seed, "init", "-b", "main");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "demo", private: true, scripts: { lint: "sh scripts/check.sh lint", typecheck: "sh scripts/check.sh typecheck", "test:unit": "sh scripts/check.sh unit", build: "sh scripts/check.sh build" } }, null, 2) + "\n",
    "scripts/check.sh": `#!/bin/sh\nif grep -rq FAIL src 2>/dev/null; then echo "check $1 failed"; exit 1; fi\necho "check $1 ok"\n`,
    "src/search.ts": "export const search = () => 'v1';\n",
  };
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(seed, p)), { recursive: true }); writeFileSync(join(seed, p), c); }
  sh(seed, "add", "."); sh(seed, "commit", "-m", "base"); sh(seed, "push", remote, "main");
  baseSha = sh(seed, "rev-parse", "HEAD");
});
afterAll(async () => { await db.drop(); });

async function job() {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 'Search', 'Users can search the job list by free text and the page updates without a reload.') RETURNING id`;
  return (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repo}) RETURNING id`)[0]!.id as string;
}
const scripted = (f: (role: "builder" | "tester", round: number) => string): BuilderRuntime => ({ async edit(ctx, i) { const r = await ctx.run("/bin/sh", ["-c", f(i.role, i.round)]); return { ok: r.exitCode === 0 }; } });

function rig(runtime: BuilderRuntime, configDir = REAL_CONFIG) {
  const out = (req: AgentRunRequest): unknown => {
    switch (req.role) {
      case "intake": return { decision: "accept", summary: "ok", acceptance_criteria: [{ id: "AC-1", text: "search works" }] };
      case "analyst": return requirements();
      case "architect": return design();
      case "spec": return spec();
      default: return { artifactUri: `mock://${req.role}`, summary: "ok" };
    }
  };
  const agent = agentTaskExecutor({ sql: db.sql, adapter: new MockAdapter({ output: out, schemas }), store, modelFor: () => "mock", contextUri: (j, r) => buildContextManifest(db.sql, store, j, r) });
  const remoteFor = async () => ({ url: remote, allowLocalRemote: true });
  const build = builderTaskExecutor({ sql: db.sql, store, runtime, remoteFor });
  const gate = createGatePort({ sql: db.sql, store, signer: new EvidenceSigner(keys.privateKeyPem), configDir, profile: "typescript-web", backend: detectBackend(), workspaceRoot: wsRoot, remoteFor });
  const base = mockPorts();
  const mk = () => new Orchestrator({
    sql: db.sql, ports: { ...base, gate, scm: { ...base.scm, prepare: async () => ({ baseSha }), commitCandidate: candidateScm(db.sql).commitCandidate } },
    intake: createIntakeHandler({ sql: db.sql, store }), spec: createSpecHandler({ sql: db.sql, store }),
  });
  return { exec: composeExecutors(agent, build), mk };
}
async function drive(id: string, r: ReturnType<typeof rig>) {
  const w = await enrollWorker(cfg());
  const orch = r.mk();
  for (let i = 0; i < 300; i++) {
    const t = await orch.tick(id);
    if (["terminal", "awaiting-human", "awaiting-info"].includes(t.action)) return t;
    if (t.action === "enqueued" || t.action === "waiting") await runOnce(cfg(), w, r.exec);
  }
  throw new Error("did not settle");
}
const good = (role: "builder" | "tester") => (role === "builder" ? `printf "export const search = () => 'ok';\\n" > src/search.ts` : `mkdir -p tests && printf "// t\\n" > tests/search.test.ts`);
const manifestDigest = () => loadLockedManifest(REAL_CONFIG, "typescript-web").digest;

describe("gates inside the orchestrator pipeline", () => {
  test("a good candidate passes the real sandboxed gates; the evidence is signed, SHA-bound and re-verifiable from the DB", async () => {
    const id = await job();
    expect((await drive(id, rig(scripted((role) => good(role))))).action).toBe("awaiting-human");
    const [g] = await db.sql`SELECT head_sha, base_sha, verdict, results_digest, gate_config_digest FROM gate_results WHERE job_id=${id}`;
    const [j] = await db.sql`SELECT head_sha FROM jobs WHERE id=${id}`;
    expect(g).toMatchObject({ verdict: "pass", head_sha: j!.head_sha, base_sha: baseSha, gate_config_digest: manifestDigest() });
    expect(await verifyStoredGateEvidence({ sql: db.sql, store, publicKeyPem: keys.publicKeyPem }, { jobId: id, headSha: j!.head_sha, baseSha, manifestDigest: manifestDigest() })).toEqual({ ok: true, reasons: [] });
  });

  test("failing gate -> rework with the failure fed back to the builder -> fixed candidate passes; each evidence is bound to its own SHA", async () => {
    const id = await job();
    const runtime = scripted((role, round) => (role === "builder" ? `printf "export const search = () => '${round === 0 ? "FAIL" : "ok"}';\\n" > src/search.ts` : good("tester")));
    expect((await drive(id, rig(runtime))).action).toBe("awaiting-human");
    const gates = await db.sql`SELECT head_sha, verdict FROM gate_results WHERE job_id=${id} ORDER BY created_at`;
    expect(gates.map((g) => g.verdict)).toEqual(["fail", "pass"]);
    expect(gates[0]!.head_sha).not.toBe(gates[1]!.head_sha);
    const failEv = (await readEvents(db.sql, id, 0, 500)).find((e) => e.type === "gate.failed")!;
    expect(failEv.payload).toMatchObject({ round: 0, class: "lint" });
    const [{ c }] = (await db.sql`SELECT count(*)::int AS c FROM artifacts WHERE job_id=${id} AND kind LIKE 'gate.r%.json'`) as unknown as [{ c: number }];
    expect(c).toBe(2);
    // the passing evidence cannot be replayed for the failing head
    expect((await verifyStoredGateEvidence({ sql: db.sql, store, publicKeyPem: keys.publicKeyPem }, { jobId: id, headSha: gates[0]!.head_sha, baseSha, manifestDigest: manifestDigest() })).ok).toBe(false);
  });

  test("a builder that weakens the checks (package.json) is escalated to a human IMMEDIATELY: no automated retry, no pass", async () => {
    const id = await job();
    const runtime = scripted((role) => (role === "builder" ? `printf '{"name":"demo","private":true,"scripts":{"lint":"true","typecheck":"true","test:unit":"true","build":"true"}}' > package.json && printf "export const search = () => 'ok';\\n" > src/search.ts` : good("tester")));
    const res = await drive(id, rig(runtime));
    expect(res.action).toBe("awaiting-human");
    expect((await db.sql`SELECT count(DISTINCT round)::int AS c FROM candidates WHERE job_id=${id}`)[0]!.c).toBe(1);
    expect((await db.sql`SELECT verdict FROM gate_results WHERE job_id=${id}`).map((g) => g.verdict)).toEqual(["fail"]);
    expect((await readEvents(db.sql, id, 0, 500)).find((e) => e.type === "gate.failed")!.payload).toMatchObject({ class: "checks-tampered" });
    expect((await db.sql`SELECT count(*)::int AS c FROM review_results WHERE job_id=${id}`)[0]!.c).toBe(0); // never reached review
  });

  test("a tampered gate manifest escalates immediately and nothing is ever reviewed or merged", async () => {
    const id = await job();
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    cpSync(join(REAL_CONFIG, "gates"), join(dir, "gates"), { recursive: true });
    cpSync(join(REAL_CONFIG, "gates.lock.json"), join(dir, "gates.lock.json"));
    const p = join(dir, "gates/typescript-web.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"lint"', '"lint"').replace('["bun", "run", "lint"]', '["bun", "run", "typecheck"]'));
    const res = await drive(id, rig(scripted((role) => good(role)), dir));
    expect(res.action).toBe("awaiting-human");
    expect((await db.sql`SELECT verdict FROM gate_results WHERE job_id=${id}`).map((g) => g.verdict)).toEqual(["error"]);
    expect((await db.sql`SELECT count(*)::int AS c FROM review_results WHERE job_id=${id}`)[0]!.c).toBe(0);
    expect((await db.sql`SELECT count(*)::int AS c FROM merge_intents WHERE job_id=${id}`)[0]!.c).toBe(0);
    expect((await readEvents(db.sql, id, 0, 500)).find((e) => e.type === "gate.failed")!.payload).toMatchObject({ class: "manifest-mismatch" });
  });
});
