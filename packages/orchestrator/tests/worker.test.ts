import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../db/src/testing";
import { approveMemory, proposeMemory, type Actor } from "@factory/memory";
import { detectBackend } from "@factory/sandboxes";
import { enqueueTask, registerWorker } from "@factory/scheduler";
import { runOnce, type RunnerConfig } from "@factory/runner";
import {
  checkQualification, InferenceSourcePolicy, loadPolicyConfig, loadQualificationRegistry, MockAdapter,
  type QualificationRecord, type SelectionCandidate,
} from "@factory/runtimes";
import { digestOf } from "@factory/telemetry";
import { agentWorkerExecutor, FileArtifactStore, workerStartDecision, WORKER_ENABLE_ENV } from "../src/index";

const CFG = join(import.meta.dir, "../../../config");
const policyCfg = loadPolicyConfig(CFG);
const baseReg = loadQualificationRegistry(CFG);
const TODAY = new Date();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const NOW = TODAY;
const plusDays = (n: number) => isoDay(new Date(TODAY.getTime() + n * 86_400_000));
const candidate: SelectionCandidate = { adapterId: "local-model", authMode: "local_model", modelId: "qwen-test", promptVersion: "v1", toolsetDigest: "t1", endpoints: ["http://127.0.0.1:11434"] };
const qualifiedRecord: QualificationRecord = {
  adapterId: "local-model", modelId: "qwen-test", role: "builder", promptVersion: "v1", toolsetDigest: "t1", harnessVersion: "h1", datasetVersion: "d1",
  datasetDigest: "sha256:x", samples: 60, passes: 58, criticalMisses: 0, criticalPolicyViolations: 0, usedRealToolLoop: true,
  resultsPath: "evidence/x", approvedBy: "op", approvedOn: isoDay(TODAY), expiresOn: plusDays(60),
};

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let root = "", wsRoot = "";
let org = "", repo = "", creator = "", approver = "";
const ACL = digestOf({ acl: "worker" });
const A = (u: string): Actor => ({ organizationId: org, userId: u });

async function job(createdBy: string): Promise<string> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description, requester_id)
    VALUES (${repo}, 'api', ${"w" + Math.random()}, 'sha256:x', 'feature', 'Export', 'Implement export', ${createdBy}) RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id, created_by) VALUES (${req!.id}, ${repo}, ${createdBy}) RETURNING id`;
  return j!.id as string;
}

function harness(opts: { qualified: boolean; adapter: MockAdapter }) {
  const registry = { ...baseReg, qualifications: opts.qualified ? [qualifiedRecord] : [] };
  return agentWorkerExecutor({
    sql: db.sql,
    store: new FileArtifactStore(root),
    adapters: new Map([["local-model", opts.adapter]]),
    candidates: [candidate],
    policy: new InferenceSourcePolicy(policyCfg),
    qualification: registry,
    env: {},
    sandboxEnforced: true,
    fallbackContextUri: (j, r) => `ctx://${j}/${r}`,
  });
}

async function runBuilderTask(jobId: string, executor: ReturnType<typeof agentWorkerExecutor>) {
  await enqueueTask(db.sql, { jobId, stage: "BUILDING:r0", role: "builder" });
  const workerId = await registerWorker(db.sql, { organizationId: org, mode: "local" });
  const cfg: RunnerConfig = { sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" }, trustedRepositoryOnly: true, heartbeatMs: 50 };
  return runOnce(cfg, workerId, executor, ["builder"]);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "worker-store-"));
  wsRoot = mkdtempSync(join(tmpdir(), "worker-ws-"));
  db = await createTestDb();
  const sql = db.sql;
  org = (await sql`INSERT INTO organizations (name) VALUES ('W') RETURNING id`)[0]!.id as string;
  const u = async (s: string, r: string) => (await sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${s}, ${r}) RETURNING id`)[0]!.id as string;
  creator = await u("c", "editor");
  approver = await u("a", "approver");
  repo = (await sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'w', 'o', 'n') RETURNING id`)[0]!.id as string;
  const buf = Buffer.from("worker source");
  const hex = createHash("sha256").update(buf).digest("hex");
  writeFileSync(join(root, hex), buf);
  const seed = await job(creator);
  const [art] = await sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${seed}, 'spec', ${"sha256:" + hex}, ${"file://" + join(root, hex)}, ${buf.length}, 'clean') RETURNING id`;
  const p = await proposeMemory(sql, A(creator), { projectId: repo, kind: "decision", claim: "Worker memory claim", sources: [{ kind: "artifact", id: art!.id as string, digest: "sha256:" + hex, extractionMethod: "user_statement", aclDigest: ACL }] });
  await approveMemory(sql, A(approver), repo, p.id);
});
afterAll(async () => {
  await db.drop();
  rmSync(root, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
});

describe("worker start decision (default off)", () => {
  test("stopped unless DISPATCH_WORKER_ENABLE is exactly \"1\" and an adapter is registered", () => {
    expect(workerStartDecision({}, 1).start).toBe(false);
    expect(workerStartDecision({ [WORKER_ENABLE_ENV]: "true" }, 1).start).toBe(false);
    expect(workerStartDecision({ [WORKER_ENABLE_ENV]: "1" }, 0).start).toBe(false);
    expect(workerStartDecision({ [WORKER_ENABLE_ENV]: "1" }, 1).start).toBe(true);
  });
});

describe("selection gate on the worker", () => {
  test("the qualification registry is sanity-checked against the candidate (test fixture is valid)", () => {
    expect(checkQualification({ ...baseReg, qualifications: [qualifiedRecord] }, { adapterId: "local-model", modelId: "qwen-test", role: "builder", promptVersion: "v1", toolsetDigest: "t1" }, NOW).ok).toBe(true);
  });

  test("no qualified model: the task is NOT run, the adapter is never started, and the block reason is recorded", async () => {
    const adapter = new MockAdapter({ behavior: "ok" });
    let started = 0;
    const origStart = adapter.start.bind(adapter);
    adapter.start = async (req, rep) => { started++; return origStart(req, rep); };
    const jobId = await job(creator);
    const outcome = await runBuilderTask(jobId, harness({ qualified: false, adapter }));
    expect(started).toBe(0);
    expect(outcome?.status).toBe("failed");
    const [ev] = await db.sql<{ payload: { selected: unknown; blockReason: string } }[]>`SELECT payload_redacted AS payload FROM events WHERE job_id = ${jobId} AND type = 'runtime.selection'`;
    expect(ev!.payload.selected).toBeNull();
    expect(ev!.payload.blockReason).toBe("MODEL_NOT_QUALIFIED");
  });

  test("a qualified candidate runs through the real loop and the selection is recorded", async () => {
    const adapter = new MockAdapter({ behavior: "ok" });
    const jobId = await job(creator);
    const outcome = await runBuilderTask(jobId, harness({ qualified: true, adapter }));
    expect(outcome?.status).toBe("succeeded");
    const [ev] = await db.sql<{ payload: { selected: string } }[]>`SELECT payload_redacted AS payload FROM events WHERE job_id = ${jobId} AND type = 'runtime.selection'`;
    expect(ev!.payload.selected).toBe("local-model/qwen-test");
  });

  test("a candidate with no adapter in this build is never selected", async () => {
    const exec = agentWorkerExecutor({
      sql: db.sql, store: new FileArtifactStore(root), adapters: new Map(), candidates: [candidate],
      policy: new InferenceSourcePolicy(policyCfg), qualification: { ...baseReg, qualifications: [qualifiedRecord] }, env: {}, sandboxEnforced: true,
      fallbackContextUri: (j, r) => `ctx://${j}/${r}`,
    });
    const jobId = await job(creator);
    const outcome = await runBuilderTask(jobId, exec);
    expect(outcome?.status).toBe("failed");
    const [ev] = await db.sql<{ payload: { selected: unknown; blockReason: string } }[]>`SELECT payload_redacted AS payload FROM events WHERE job_id = ${jobId} AND type = 'runtime.selection'`;
    expect(ev!.payload.selected).toBeNull();
    expect(ev!.payload.blockReason).toBe("RUNTIME_UNAVAILABLE");
  });

  test("with memory on, a selected run receives a verified pack URI (no fallback)", async () => {
    const adapter = new MockAdapter({ behavior: "ok" });
    const seen: string[] = [];
    const origStart = adapter.start.bind(adapter);
    adapter.start = async (req, rep) => { seen.push(req.immutableContextManifestUri); return origStart(req, rep); };
    const exec = agentWorkerExecutor({
      sql: db.sql, store: new FileArtifactStore(root), adapters: new Map([["local-model", adapter]]), candidates: [candidate],
      policy: new InferenceSourcePolicy(policyCfg), qualification: { ...baseReg, qualifications: [qualifiedRecord] }, env: {}, sandboxEnforced: true,
      fallbackContextUri: (j, r) => `ctx://${j}/${r}`, memory: { enabled: true },
    });
    const jobId = await job(creator);
    const outcome = await runBuilderTask(jobId, exec);
    expect(outcome?.status).toBe("succeeded");
    expect(seen[0]).toMatch(/^context-pack:/);
  });
});
