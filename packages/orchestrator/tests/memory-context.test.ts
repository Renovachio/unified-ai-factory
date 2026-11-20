import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../db/src/testing";
import { approveMemory, proposeMemory, type Actor, MemoryError } from "@factory/memory";
import { digestOf } from "@factory/telemetry";
import { FileArtifactStore } from "../src/artifacts";
import { memoryContextLoader, memoryContextUri, MEMORY_CONTEXT_ROLES } from "../src/memory-context";

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let dir = "";
let store: FileArtifactStore;
let org = "", projA = "", viewer = "", approver = "", author = "", disabled = "", jobId = "";
const ACL = digestOf({ acl: "orchestrator-memory" });
const A = (u: string): Actor => ({ organizationId: org, userId: u });
const SYSTEM = "You are the builder. Follow repository policy.";
const TASK = "Implement the export feature";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-mem-"));
  store = new FileArtifactStore(dir);
  db = await createTestDb();
  const sql = db.sql;
  org = (await sql`INSERT INTO organizations (name) VALUES ('O') RETURNING id`)[0]!.id as string;
  const u = async (s: string, r: string, dis = false) =>
    (await sql`INSERT INTO users (organization_id, auth_subject, role, disabled_at) VALUES (${org}, ${s}, ${r}, ${dis ? new Date() : null}) RETURNING id`)[0]!.id as string;
  viewer = await u("v", "viewer");
  approver = await u("a", "approver");
  author = await u("e", "editor");
  disabled = await u("d", "viewer", true);
  projA = (await sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'p', 'o', 'a') RETURNING id`)[0]!.id as string;
  const [req] = await sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description)
    VALUES (${projA}, 'api', 'r1', 'sha256:x', 'feature', 't', 'd') RETURNING id`;
  jobId = (await sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${projA}) RETURNING id`)[0]!.id as string;
  const { createHash } = await import("node:crypto");
  const buf = Buffer.from("orchestrator memory source");
  const hex = createHash("sha256").update(buf).digest("hex");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, hex), buf);
  const [art] = await sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${jobId}, 'spec', ${"sha256:" + hex}, ${"file://" + join(dir, hex)}, ${buf.length}, 'clean') RETURNING id`;
  const p = await proposeMemory(sql, A(author), { projectId: projA, kind: "decision", claim: "Export feature must keep the audit trail", sources: [{ kind: "artifact", id: art!.id as string, digest: "sha256:" + hex, extractionMethod: "user_statement", aclDigest: ACL }] });
  await approveMemory(sql, A(approver), projA, p.id);
});
afterAll(async () => {
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

const deps = (over: Partial<Parameters<typeof memoryContextUri>[0]> = {}) => ({
  sql: db.sql,
  store,
  packInputFor: async () => ({ actor: A(viewer), projectId: projA, task: TASK, systemInstructions: SYSTEM }),
  fallback: (j: string, r: string) => `legacy://${j}/${r}`,
  ...over,
});

describe("opt-in roles", () => {
  test("only spec and builder are opted in by default", () => {
    expect([...MEMORY_CONTEXT_ROLES].sort()).toEqual(["builder", "spec"]);
  });

  test("an opted-in role gets a context-pack URI; the loader returns the stored pack text the run would see", async () => {
    const uri = await memoryContextUri(deps())(jobId, "builder");
    expect(uri).toMatch(/^context-pack:[0-9a-f-]{36}$/);
    const text = await memoryContextLoader(db.sql, store)(uri);
    expect(text.startsWith(SYSTEM)).toBe(true);
    expect(text).toContain(`<task>${TASK}</task>`);
    expect(text).toContain("Export feature must keep the audit trail");
  });

  test("roles that did not opt in keep their existing URI and never create a pack", async () => {
    const [before] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM context_packs`;
    expect(await memoryContextUri(deps())(jobId, "review_code")).toBe(`legacy://${jobId}/review_code`);
    const [after] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM context_packs`;
    expect(after!.n).toBe(before!.n);
  });

  test("a failed pack build refuses the run: no silent fallback to the legacy context", async () => {
    const fn = memoryContextUri(deps({ packInputFor: async () => ({ actor: A(disabled), projectId: projA, task: TASK, systemInstructions: SYSTEM }) }));
    let code = "";
    try { await fn(jobId, "builder"); } catch (e) { code = e instanceof MemoryError ? e.code : String(e); }
    expect(code).toBe("FORBIDDEN");
  });

  test("a budget above the role cap is refused (ROLE_CAP_EXCEEDED), never clipped silently", async () => {
    const fn = memoryContextUri(deps({ packInputFor: async () => ({ actor: A(viewer), projectId: projA, task: TASK, systemInstructions: SYSTEM, maxInputTokens: 10_000_000 }) }));
    let code = "";
    try { await fn(jobId, "builder"); } catch (e) { code = e instanceof MemoryError ? e.code : String(e); }
    expect(code).toBe("ROLE_CAP_EXCEEDED");
  });

  test("the loader refuses a pack ID that the store cannot verify (fails closed)", async () => {
    const uri = await memoryContextUri(deps())(jobId, "spec");
    const emptyStore = new FileArtifactStore(mkdtempSync(join(tmpdir(), "orch-empty-")));
    let failed = false;
    try { await memoryContextLoader(db.sql, emptyStore)(uri); } catch { failed = true; }
    expect(failed).toBe(true);
  });
});
