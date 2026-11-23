import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../db/src/testing";
import { digestOf } from "../../telemetry/src/index";
import { approveMemory, eraseMemoryText, MemoryError, proposeMemory, rejectMemory, runRetention, type Actor, type PackTextStore } from "../src/index";

class BlobStore implements PackTextStore {
  readonly blobs = new Map<string, string>();
  put(text: string) {
    const digest = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    this.blobs.set(digest, text);
    return { digest, uri: `mem://${digest}` };
  }
  get(digest: string): Buffer { const t = this.blobs.get(digest); if (t === undefined) throw new Error("missing"); return Buffer.from(t, "utf8"); }
  delete(digest: string): boolean { return this.blobs.delete(digest); }
}

let db: Awaited<ReturnType<typeof createTestDb>>;
let dir = "";
let org = "", proj = "", author = "", approver = "", steward = "", viewer = "", n = 0;
const ACL = digestOf({ acl: "retention-test" });
const A = (u: string): Actor => ({ organizationId: org, userId: u });
const DAY = 86_400_000;

async function artifact(text: string) {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description)
    VALUES (${proj}, 'api', ${"r" + ++n}, 'sha256:x', 'feature', 't', 'd') RETURNING id`;
  const [job] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${proj}) RETURNING id`;
  const buf = Buffer.from(`${text} #${++n}`, "utf8");
  const hex = createHash("sha256").update(buf).digest("hex");
  writeFileSync(join(dir, hex), buf);
  const digest = `sha256:${hex}`;
  const [a] = await db.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${job!.id}, 'spec', ${digest}, ${"file://" + join(dir, hex)}, ${buf.length}, 'clean') RETURNING id`;
  return { id: a!.id as string, digest };
}
async function proposed(claim: string, ageDays: number) {
  const a = await artifact(claim);
  const m = await proposeMemory(db.sql, A(author), { projectId: proj, kind: "fact", claim, sources: [{ kind: "artifact", id: a.id, digest: a.digest, extractionMethod: "user_statement", aclDigest: ACL }] });
  await db.sql`ALTER TABLE memory_records DISABLE TRIGGER memory_records_guard`;
  await db.sql`UPDATE memory_records SET created_at = ${new Date(Date.now() - ageDays * DAY)}, updated_at = ${new Date(Date.now() - ageDays * DAY)} WHERE id = ${m.id}`;
  await db.sql`ALTER TABLE memory_records ENABLE TRIGGER memory_records_guard`;
  return m.id;
}
const statusOf = async (id: string) => (await db.sql<{ status: string; claim: string }[]>`SELECT status, claim FROM memory_records WHERE id = ${id}`)[0]!;

/** A stored pack whose manifest selected the given memories; the rendered text is held by the store. */
async function pack(store: BlobStore, memoryIds: string[], ageDays: number, text: string) {
  const [ev] = await db.sql<{ id: string }[]>`INSERT INTO memory_retrieval_events (organization_id, project_id, actor_id, query_digest, retrieval_mode, returned_ids, omitted)
    VALUES (${org}, ${proj}, ${author}, ${"sha256:" + "7".repeat(64)}, 'lexical', ${memoryIds}::uuid[], '{}'::jsonb) RETURNING id`;
  const stored = store.put(text);
  await db.sql`ALTER TABLE context_packs DISABLE TRIGGER context_packs_append_only`;
  const [p] = await db.sql<{ id: string }[]>`INSERT INTO context_packs (organization_id, project_id, actor_id, model_role, max_input_tokens, estimated_tokens, retrieval_event_id, manifest, pack_digest, rendered_digest, rendered_uri, created_at)
    VALUES (${org}, ${proj}, ${author}, 'spec', 1000, 10, ${ev!.id}, ${db.sql.json({ selected: memoryIds.map((memoryId) => ({ memoryId })) })}, ${"sha256:" + "8".repeat(64)}, ${stored.digest}, ${stored.uri}, ${new Date(Date.now() - ageDays * DAY)}) RETURNING id`;
  await db.sql`ALTER TABLE context_packs ENABLE TRIGGER context_packs_append_only`;
  return { id: p!.id, digest: stored.digest };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mem-ret-"));
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('R') RETURNING id`)[0]!.id as string;
  const u = async (s: string, r: string) => (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${s}, ${r}) RETURNING id`)[0]!.id as string;
  author = await u("author", "editor");
  approver = await u("approver", "approver");
  steward = await u("steward", "security_officer");
  viewer = await u("viewer", "viewer");
  proj = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'ret', 'o', 'r') RETURNING id`)[0]!.id as string;
});
afterAll(async () => { await db.drop(); rmSync(dir, { recursive: true, force: true }); });

describe("retention policy (MEM-05 decision)", () => {
  test("a proposed memory older than 90 days is erased; a younger one is kept", async () => {
    const old = await proposed("Old proposal probe", 100);
    const young = await proposed("Young proposal probe", 10);
    const r = await runRetention(db.sql, new BlobStore(), A(steward), proj);
    expect(r.erasedProposed).toBeGreaterThanOrEqual(1);
    expect((await statusOf(old)).status).toBe("deleted");
    expect((await statusOf(old)).claim).toBe("");
    expect((await statusOf(young)).status).toBe("proposed");
  });

  test("a rejected memory is erased after 30 days, kept before", async () => {
    const oldId = await proposed("Old rejection probe", 40);
    await rejectMemory(db.sql, A(approver), proj, oldId, "not needed");
    await db.sql`ALTER TABLE memory_records DISABLE TRIGGER memory_records_guard`;
    await db.sql`UPDATE memory_records SET updated_at = ${new Date(Date.now() - 40 * DAY)} WHERE id = ${oldId}`;
    await db.sql`ALTER TABLE memory_records ENABLE TRIGGER memory_records_guard`;
    const recentId = await proposed("Recent rejection probe", 5);
    await rejectMemory(db.sql, A(approver), proj, recentId, "not needed");
    await runRetention(db.sql, new BlobStore(), A(steward), proj);
    expect((await statusOf(oldId)).status).toBe("deleted");
    expect((await statusOf(recentId)).status).toBe("rejected");
  });

  test("an approved memory never expires automatically, however old", async () => {
    const a = await artifact("Approved forever probe");
    const m = await proposeMemory(db.sql, A(author), { projectId: proj, kind: "decision", claim: "Approved forever probe", sources: [{ kind: "artifact", id: a.id, digest: a.digest, extractionMethod: "user_statement", aclDigest: ACL }] });
    await approveMemory(db.sql, A(approver), proj, m.id);
    await db.sql`ALTER TABLE memory_records DISABLE TRIGGER memory_records_guard`;
    await db.sql`UPDATE memory_records SET created_at = ${new Date(Date.now() - 900 * DAY)} WHERE id = ${m.id}`;
    await db.sql`ALTER TABLE memory_records ENABLE TRIGGER memory_records_guard`;
    await runRetention(db.sql, new BlobStore(), A(steward), proj);
    expect((await statusOf(m.id)).status).toBe("approved");
  });

  test("retention requires a steward; an ordinary viewer is refused", async () => {
    let err: unknown;
    try { await runRetention(db.sql, new BlobStore(), A(viewer), proj); } catch (e) { err = e; }
    expect(err instanceof MemoryError && err.code).toBe("FORBIDDEN");
  });

  test("pack text older than 30 days is deleted, and a second run is a no-op (idempotent)", async () => {
    const store = new BlobStore();
    const m = await proposed("Pack age probe", 1);
    const oldPack = await pack(store, [m], 45, "rendered context with Pack age probe");
    const first = await runRetention(db.sql, store, A(steward), proj);
    expect(first.packTextsDeleted).toBeGreaterThanOrEqual(1);
    expect(store.blobs.has(oldPack.digest)).toBe(false);
    const second = await runRetention(db.sql, store, A(steward), proj);
    expect(second.erasedProposed + second.erasedRejected).toBe(0);
  });
});

describe("erasing one memory removes the pack text that contains it", () => {
  test("only the packs that selected the erased memory lose their text; other packs keep theirs", async () => {
    const store = new BlobStore();
    const target = await proposed("Erase target probe", 1);
    const other = await proposed("Other memory probe", 1);
    const withTarget = await pack(store, [target, other], 1, "text containing Erase target probe");
    const withoutTarget = await pack(store, [other], 1, "text containing only Other memory probe");
    const r = await eraseMemoryText(db.sql, store, A(steward), proj, target, "subject request");
    expect(r.packTextsDeleted).toBe(1);
    expect(store.blobs.has(withTarget.digest)).toBe(false);
    expect(store.blobs.has(withoutTarget.digest)).toBe(true);
    expect((await statusOf(target)).status).toBe("deleted");
  });

  test("a retry after a failed blob deletion still removes the text (erasure is idempotent)", async () => {
    const store = new BlobStore();
    const target = await proposed("Retry erase probe", 1);
    const p = await pack(store, [target], 1, "text containing Retry erase probe");
    await eraseMemoryText(db.sql, store, A(steward), proj, target, "subject request");
    store.blobs.set(p.digest, "text containing Retry erase probe"); // simulate a blob that survived the first attempt
    const again = await eraseMemoryText(db.sql, store, A(steward), proj, target, "subject request");
    expect(again.packTextsDeleted).toBe(1);
    expect(store.blobs.has(p.digest)).toBe(false);
  });
});
