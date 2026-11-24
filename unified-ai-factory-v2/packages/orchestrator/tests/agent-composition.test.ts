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
import { MockAdapter } from "@factory/runtimes";
import { digestOf } from "@factory/telemetry";
import { composeAgentExecutor, FileArtifactStore, memoryContextEnabled, MEMORY_CONTEXT_ENV } from "../src/index";

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let root = "";
let wsRoot = "";
let org = "", repo = "", creator = "", approver = "", disabledCreator = "";
const ACL = digestOf({ acl: "agent-composition" });
const A = (u: string): Actor => ({ organizationId: org, userId: u });
const CLAIM = "Export must keep the audit trail for every release";

async function job(createdBy: string | null, title: string, description: string): Promise<string> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description, requester_id)
    VALUES (${repo}, 'api', ${"e" + Math.random()}, 'sha256:x', 'feature', ${title}, ${description}, ${createdBy}) RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id, created_by) VALUES (${req!.id}, ${repo}, ${createdBy}) RETURNING id`;
  return j!.id as string;
}

/** Runs one builder task through the real runner loop. Returns what the mock runtime received and the run outcome. */
async function runBuilder(jobId: string, env: Record<string, string | undefined>) {
  const store = new FileArtifactStore(root);
  const adapter = new MockAdapter({ behavior: "ok" });
  const received: string[] = [];
  const origStart = adapter.start.bind(adapter);
  adapter.start = async (req, rep) => { received.push(req.immutableContextManifestUri); return origStart(req, rep); };
  const composed = composeAgentExecutor({
    sql: db.sql, adapter, store, modelFor: () => "mock",
    fallbackContextUri: (j, r) => `ctx://${j}/${r}`,
    memory: { enabled: memoryContextEnabled(env) },
  });
  await enqueueTask(db.sql, { jobId, stage: "BUILDING:r0", role: "builder" });
  const workerId = await registerWorker(db.sql, { organizationId: org, mode: "local" });
  const cfg: RunnerConfig = {
    sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" },
    trustedRepositoryOnly: true, heartbeatMs: 50,
  };
  const outcome = await runOnce(cfg, workerId, composed.executor, ["builder"]);
  return { received, outcome, loadContext: composed.loadContext };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-comp-"));
  wsRoot = mkdtempSync(join(tmpdir(), "agent-ws-"));
  db = await createTestDb();
  const sql = db.sql;
  org = (await sql`INSERT INTO organizations (name) VALUES ('O') RETURNING id`)[0]!.id as string;
  const u = async (s: string, r: string, dis = false) =>
    (await sql`INSERT INTO users (organization_id, auth_subject, role, disabled_at) VALUES (${org}, ${s}, ${r}, ${dis ? new Date() : null}) RETURNING id`)[0]!.id as string;
  creator = await u("creator", "editor");
  approver = await u("approver", "approver");
  disabledCreator = await u("gone", "editor", true);
  repo = (await sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id as string;
  // An approved memory on the repository, sourced from a real artifact so the pack is non-trivial.
  const buf = Buffer.from("composition source text");
  const hex = createHash("sha256").update(buf).digest("hex");
  writeFileSync(join(root, hex), buf);
  const seedJob = await job(creator, "seed", "seed");
  const [art] = await sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${seedJob}, 'spec', ${"sha256:" + hex}, ${"file://" + join(root, hex)}, ${buf.length}, 'clean') RETURNING id`;
  const p = await proposeMemory(sql, A(creator), { projectId: repo, kind: "decision", claim: CLAIM, sources: [{ kind: "artifact", id: art!.id as string, digest: "sha256:" + hex, extractionMethod: "user_statement", aclDigest: ACL }] });
  await approveMemory(sql, A(approver), repo, p.id);
});
afterAll(async () => {
  await db.drop();
  rmSync(root, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
});

describe("feature flag", () => {
  test("memory is OFF unless DISPATCH_MEMORY_CONTEXT is exactly \"1\"", () => {
    expect(memoryContextEnabled({})).toBe(false);
    expect(memoryContextEnabled({ [MEMORY_CONTEXT_ENV]: "true" })).toBe(false);
    expect(memoryContextEnabled({ [MEMORY_CONTEXT_ENV]: "0" })).toBe(false);
    expect(memoryContextEnabled({ [MEMORY_CONTEXT_ENV]: "1" })).toBe(true);
  });
});

describe("end-to-end builder run through the runner loop", () => {
  test("flag off: the runtime receives the existing URI and no pack is created", async () => {
    const jobId = await job(creator, "Export feature", "Implement the export");
    const before = (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM context_packs`)[0]!.n;
    const { received, outcome } = await runBuilder(jobId, {});
    expect(outcome?.status).toBe("succeeded");
    expect(received).toEqual([`ctx://${jobId}/builder`]);
    expect((await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM context_packs`)[0]!.n).toBe(before);
  });

  test("flag on: the runtime receives a pack URI; the loaded text has the role prompt, the escaped task and the approved memory", async () => {
    const jobId = await job(creator, "Export feature", "Implement <the> export & report");
    const { received, outcome, loadContext } = await runBuilder(jobId, { [MEMORY_CONTEXT_ENV]: "1" });
    expect(outcome?.status).toBe("succeeded");
    const uri = received[0]!;
    expect(uri).toMatch(/^context-pack:/);
    const text = await loadContext(uri);
    expect(text).toContain("Export feature");
    expect(text).toContain("&lt;the&gt; export &amp; report");
    expect(text).toContain(CLAIM);
    expect(text.indexOf("<memory ")).toBeGreaterThan(text.indexOf("<task>"));
    const [pack] = await db.sql<{ actor_id: string; manifest: { selected: unknown[] } }[]>`SELECT actor_id, manifest FROM context_packs WHERE id = ${uri.replace("context-pack:", "")}`;
    expect(pack!.actor_id).toBe(creator);
    expect(pack!.manifest.selected.length).toBeGreaterThan(0);
  });

  test("flag on, job creator disabled: the run is refused before the runtime starts (no fallback URI)", async () => {
    const jobId = await job(disabledCreator, "Blocked", "Creator no longer has access");
    const { received, outcome } = await runBuilder(jobId, { [MEMORY_CONTEXT_ENV]: "1" });
    expect(received).toEqual([]);
    expect(outcome?.status).toBe("error");
    expect(outcome?.error).toMatch(/FORBIDDEN|actor lacks the role/);
  });

  test("flag on, job without a creator: refused, never built on a system identity", async () => {
    const jobId = await job(null, "Orphan", "No creator recorded");
    const { received, outcome } = await runBuilder(jobId, { [MEMORY_CONTEXT_ENV]: "1" });
    expect(received).toEqual([]);
    expect(outcome?.status).toBe("error");
    expect(outcome?.error).toMatch(/no creator/);
  });
});
