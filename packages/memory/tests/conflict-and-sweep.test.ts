import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../db/src/client";
import { createTestDb } from "../../db/src/testing";
import { digestOf } from "../../telemetry/src/index";
import {
  approveMemory, approveWithErasure, eraseMemory, lockProjectApprovals, MemoryError, proposeMemory, proposeRevision, runRetentionSweep, type Actor, type PackTextStore,
} from "../src/index";

class BlobStore implements PackTextStore {
  readonly blobs = new Map<string, string>();
  put(text: string) { const digest = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`; this.blobs.set(digest, text); return { digest, uri: `mem://${digest}` }; }
  get(digest: string): Buffer { const t = this.blobs.get(digest); if (t === undefined) throw new Error("missing"); return Buffer.from(t, "utf8"); }
  delete(digest: string): boolean { return this.blobs.delete(digest); }
}

let db: Awaited<ReturnType<typeof createTestDb>>;
let dir = "";
let org = "", author = "", approver = "", steward = "", viewer = "", n = 0;
const ACL = digestOf({ acl: "conflict-test" });
const A = (u: string): Actor => ({ organizationId: org, userId: u });

async function newProject(name: string) {
  return (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', ${"c" + ++n}, 'o', ${name}) RETURNING id`)[0]!.id as string;
}
async function source(projectId: string) {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description)
    VALUES (${projectId}, 'api', ${"q" + ++n}, 'sha256:x', 'feature', 't', 'd') RETURNING id`;
  const [job] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${projectId}) RETURNING id`;
  const buf = Buffer.from(`evidence ${++n}`, "utf8");
  const hex = createHash("sha256").update(buf).digest("hex");
  writeFileSync(join(dir, hex), buf);
  const digest = `sha256:${hex}`;
  const [a] = await db.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${job!.id}, 'spec', ${digest}, ${"file://" + join(dir, hex)}, ${buf.length}, 'clean') RETURNING id`;
  return [{ kind: "artifact" as const, id: a!.id as string, digest, extractionMethod: "user_statement" as const, aclDigest: ACL }];
}
async function proposal(projectId: string, claim: string, kind = "requirement") {
  return (await proposeMemory(db.sql, A(author), { projectId, kind: kind as "requirement", claim, sources: await source(projectId) })).id;
}
async function approved(projectId: string, claim: string) {
  const id = await proposal(projectId, claim);
  await approveMemory(db.sql, A(approver), projectId, id);
  return id;
}
const statusOf = async (id: string) => (await db.sql<{ status: string; claim: string }[]>`SELECT status, claim FROM memory_records WHERE id = ${id}`)[0]!;
async function expectCode(p: Promise<unknown>, code: string) {
  let err: unknown; try { await p; } catch (e) { err = e; }
  expect(err instanceof MemoryError ? err.code : String(err)).toBe(code);
}
/** Stores a pack whose manifest selected the given memory and returns its text digest. */
async function packFor(store: BlobStore, projectId: string, memoryId: string, text: string) {
  const [ev] = await db.sql<{ id: string }[]>`INSERT INTO memory_retrieval_events (organization_id, project_id, actor_id, query_digest, retrieval_mode, returned_ids, omitted)
    VALUES (${org}, ${projectId}, ${author}, ${"sha256:" + "9".repeat(64)}, 'lexical', ${[memoryId]}::uuid[], '{}'::jsonb) RETURNING id`;
  const stored = store.put(text);
  await db.sql`INSERT INTO context_packs (organization_id, project_id, actor_id, model_role, max_input_tokens, estimated_tokens, retrieval_event_id, manifest, pack_digest, rendered_digest, rendered_uri)
    VALUES (${org}, ${projectId}, ${author}, 'spec', 1000, 10, ${ev!.id}, ${db.sql.json({ selected: [{ memoryId }] })}, ${"sha256:" + "a".repeat(64)}, ${stored.digest}, ${stored.uri})`;
  return stored.digest;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mem-conf-"));
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('C') RETURNING id`)[0]!.id as string;
  const u = async (s: string, r: string) => (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${s}, ${r}) RETURNING id`)[0]!.id as string;
  author = await u("author", "editor");
  approver = await u("approver", "approver");
  steward = await u("steward", "security_officer");
  viewer = await u("viewer", "viewer");
});
afterAll(async () => { await db.drop(); rmSync(dir, { recursive: true, force: true }); });

describe("approval resolves overlaps only with an explicit erasure decision", () => {
  test("approving a memory that overlaps approved memory is refused", async () => {
    const p = await newProject("p1");
    const old = await approved(p, "The payment service must retry failed charges three times");
    const nu = await proposal(p, "The payment service must retry failed charges five times");
    await expectCode(approveMemory(db.sql, A(approver), p, nu), "CONFLICT_UNRESOLVED");
    expect((await statusOf(nu)).status).toBe("proposed");
    expect((await statusOf(old)).status).toBe("approved");
  });

  test("an erasure decision that names no overlapping memory is refused", async () => {
    const p = await newProject("p2");
    const old = await approved(p, "Invoices are issued on the first business day of the month");
    const nu = await proposal(p, "Invoices are issued on the last business day of the month");
    await expectCode(approveWithErasure(db.sql, new BlobStore(), A(approver), p, nu, []), "CONFLICT_UNRESOLVED");
    expect((await statusOf(old)).status).toBe("approved");
    expect((await statusOf(nu)).status).toBe("proposed");
  });

  test("an erasure decision that also names an UNRELATED approved memory is refused; the unrelated one is kept", async () => {
    const p = await newProject("p3");
    const old = await approved(p, "Deploys run only from the main branch after review");
    const unrelated = await approved(p, "Backups are encrypted with the operator key");
    const nu = await proposal(p, "Deploys run only from the main branch after the review");
    await expectCode(approveWithErasure(db.sql, new BlobStore(), A(approver), p, nu, [old, unrelated]), "CONFLICT_UNRESOLVED");
    expect((await statusOf(unrelated)).status).toBe("approved");
    expect((await statusOf(old)).status).toBe("approved");
  });

  test("naming exactly the overlapping memory erases it, approves the new one, and removes pack text that contained the old claim", async () => {
    const p = await newProject("p4");
    const store = new BlobStore();
    const old = await approved(p, "Retention of audit logs is seven years");
    const digest = await packFor(store, p, old, "rendered context: Retention of audit logs is seven years");
    const nu = await proposal(p, "Retention of audit logs is seven years for regulated data");
    const view = await approveWithErasure(db.sql, store, A(approver), p, nu, [old]);
    expect(view.status).toBe("approved");
    expect((await statusOf(old)).status).toBe("deleted");
    expect((await statusOf(old)).claim).toBe("");
    expect(store.blobs.has(digest)).toBe(false);
    expect((await statusOf(nu)).status).toBe("approved");
  });

  test("a revision is not a conflict with the memory it replaces", async () => {
    const p = await newProject("p5");
    const old = await approved(p, "The API rate limit is 100 requests per minute");
    const rev = (await proposeRevision(db.sql, A(author), old, { claim: "The API rate limit is 200 requests per minute", sources: await source(p) })).id;
    await approveMemory(db.sql, A(approver), p, rev);
    expect((await statusOf(rev)).status).toBe("approved");
    expect((await statusOf(old)).status).toBe("superseded");
  });

  test("no overlap: approval proceeds with an empty decision", async () => {
    const p = await newProject("p6");
    const nu = await proposal(p, "Pagination uses opaque cursors");
    await approveWithErasure(db.sql, new BlobStore(), A(approver), p, nu, []);
    expect((await statusOf(nu)).status).toBe("approved");
  });
});

describe("retention sweep (operator entry point)", () => {
  test("a non-steward cannot run the sweep", async () => {
    await expectCode(runRetentionSweep(db.sql, new BlobStore(), viewer), "FORBIDDEN");
  });

  test("the sweep reports each project, writes one audit row attributed to the steward, and repairs pack text left by a failed erasure", async () => {
    const p = await newProject("p7");
    const store = new BlobStore();
    const gone = await approved(p, "Legacy export format is CSV only");
    const digest = await packFor(store, p, gone, "rendered context: Legacy export format is CSV only");
    await eraseMemory(db.sql, A(steward), p, gone, "subject request"); // erasure whose blob deletion never happened
    store.blobs.set(digest, "rendered context: Legacy export format is CSV only"); // the blob survived
    const r = await runRetentionSweep(db.sql, store, steward);
    const project = r.projects.find((x) => x.projectId === p);
    expect(project?.repairedPackTexts).toBe(1);
    expect(store.blobs.has(digest)).toBe(false);
    const [audit] = await db.sql<{ actor: string; action: string; result: string }[]>`SELECT actor, action, result FROM audit_entries WHERE action = 'memory.retention' AND actor = ${steward} ORDER BY created_at DESC LIMIT 1`;
    expect(audit).toEqual({ actor: steward, action: "memory.retention", result: "ok" });
    expect(digestOf(r)).toMatch(/^sha256:/);
  });
});

describe("concurrency and the control role (review of the conflict and sweep work)", () => {
  test("an approval that starts while an overlapping approval is still uncommitted waits, then sees it and is refused", async () => {
    const p = await newProject("race");
    const x = await proposal(p, "Refund requests close within five business days");
    const y = await proposal(p, "Refund requests must close within five business days");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    // First approval: takes the project lock, approves y, does NOT commit yet.
    const first = db.sql.begin(async (tx) => {
      await lockProjectApprovals(tx, p);
      await approveMemory(tx as unknown as typeof db.sql, A(approver), p, y);
      await hold;
    });
    await sleep(200);
    // Second approval of the overlapping x starts now. With the lock it must wait for the first to commit.
    const second = approveMemory(db.sql, A(approver), p, x).then(() => "approved", (e) => e);
    await sleep(300);
    release();
    await first;
    const outcome = await second;
    expect(outcome instanceof MemoryError && outcome.code).toBe("CONFLICT_UNRESOLVED");
    expect((await statusOf(x)).status).toBe("proposed");
  });

  test("the erasure path works as the control role (the role an operator connection uses), not only as the database owner", async () => {
    await db.sql.unsafe("ALTER ROLE factory_control LOGIN");
    const cu = new URL(db.url); cu.username = "factory_control";
    const control = connect(cu.toString());
    try {
      const p = await newProject("control");
      const store = new BlobStore();
      const old = await approved(p, "Ledger exports are signed with the finance key");
      const digest = await packFor(store, p, old, "rendered context: Ledger exports are signed with the finance key");
      const nu = await proposal(p, "Ledger exports must be signed with the finance key");
      await approveWithErasure(control, store, A(approver), p, nu, [old]);
      expect((await statusOf(old)).status).toBe("deleted");
      expect(store.blobs.has(digest)).toBe(false);
      const r = await runRetentionSweep(control, store, steward);
      expect(r.projects.some((x) => x.projectId === p)).toBe(true);
    } finally {
      await control.end();
    }
  });
});
