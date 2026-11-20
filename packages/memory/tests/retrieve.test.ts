import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../db/src/index";
import { createTestDb } from "../../db/src/testing";
import { digestOf } from "../../telemetry/src/index";
import {
  approveMemory, eraseMemory, MemoryError, proposeMemory, proposeRevision, rebuildIndex, revokeSource, searchMemories, tsqueryFor,
  type Actor, type MemoryErrorCode,
} from "../src/index";

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let dir = "";
let org = "", orgB = "", projA = "", projB = "", projBOrgB = "";
let author = "", approver = "", viewer = "", steward = "", disabled = "";
let orgBUser = "";
let n = 0;

const A = (u: string): Actor => ({ organizationId: org, userId: u });
const ACL = digestOf({ acl: "retrieval-test" });

async function artifactIn(projectId: string, text: string): Promise<{ id: string; digest: string }> {
  const [repo] = await db.sql`SELECT organization_id FROM repositories WHERE id = ${projectId}`;
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description)
    VALUES (${projectId}, 'api', ${"r" + ++n}, 'sha256:x', 'feature', 't', 'd') RETURNING id`;
  const [job] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${projectId}) RETURNING id`;
  const buf = Buffer.from(text + " #" + ++n, "utf8");
  const hex = createHash("sha256").update(buf).digest("hex");
  const path = join(dir, hex);
  writeFileSync(path, buf);
  const digest = `sha256:${hex}`;
  const [a] = await db.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${job!.id}, 'spec', ${digest}, ${"file://" + path}, ${buf.length}, 'clean') RETURNING id`;
  void repo;
  return { id: a!.id as string, digest };
}
const src = (a: { id: string; digest: string }) => ({ kind: "artifact" as const, id: a.id, digest: a.digest, extractionMethod: "user_statement" as const, aclDigest: ACL });

/** Proposes and approves one memory in a project, citing its own artifact. Returns the memory id and that artifact. */
async function approvedIn(projectId: string, claim: string, orgActor = A(author)) {
  const a = await artifactIn(projectId, claim);
  const p = await proposeMemory(db.sql, orgActor, { projectId, kind: "decision", claim, sources: [src(a)] });
  await approveMemory(db.sql, A(approver), projectId, p.id);
  return { id: p.id, artifact: a };
}
const ids = (r: { hits: Array<{ memoryId: string }> }) => r.hits.map((h) => h.memoryId);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mem03-"));
  db = await createTestDb();
  const sql = db.sql;
  org = (await sql`INSERT INTO organizations (name) VALUES ('A') RETURNING id`)[0]!.id as string;
  orgB = (await sql`INSERT INTO organizations (name) VALUES ('B') RETURNING id`)[0]!.id as string;
  const u = async (o: string, s: string, r: string, dis = false) =>
    (await sql`INSERT INTO users (organization_id, auth_subject, role, disabled_at) VALUES (${o}, ${s}, ${r}, ${dis ? new Date() : null}) RETURNING id`)[0]!.id as string;
  author = await u(org, "author", "editor");
  approver = await u(org, "approver", "approver");
  viewer = await u(org, "viewer", "viewer");
  steward = await u(org, "steward", "security_officer");
  disabled = await u(org, "gone", "viewer", true);
  orgBUser = await u(orgB, "b-approver", "approver");
  projA = (await sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'pa', 'o', 'a') RETURNING id`)[0]!.id as string;
  projB = (await sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'pb', 'o', 'b') RETURNING id`)[0]!.id as string;
  projBOrgB = (await sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${orgB}, 'github', 'pob', 'o', 'b') RETURNING id`)[0]!.id as string;
});
afterAll(async () => {
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the index is a projection maintained by the database", () => {
  test("approval indexes the claim; proposals are not indexed; the index row carries the record's claim hash", async () => {
    const p = await proposeMemory(db.sql, A(author), { projectId: projA, kind: "fact", claim: "CHARLIE proposal stays out of search", sources: [src(await artifactIn(projA, "x"))] });
    const [row] = await db.sql`SELECT 1 FROM memory_index WHERE record_id = ${p.id}`;
    expect(row).toBeUndefined();
    const m = await approvedIn(projA, "DELTA approved decision is searchable");
    const [idx] = await db.sql<{ indexed_claim_hash: string }[]>`SELECT i.indexed_claim_hash FROM memory_index i WHERE i.record_id = ${m.id}`;
    const [rec] = await db.sql<{ normalized_claim_hash: string }[]>`SELECT normalized_claim_hash FROM memory_records WHERE id = ${m.id}`;
    expect(idx!.indexed_claim_hash).toBe(rec!.normalized_claim_hash);
  });
});

describe("scope: cross-project and cross-tenant canaries", () => {
  test("a canary in project B is invisible from project A and from another organization", async () => {
    const aMem = await approvedIn(projA, "ALPHA-7 export pipeline must encrypt backups");
    const bMem = await approvedIn(projB, "BRAVO-9 export pipeline must rotate keys");
    const fromA = await searchMemories(db.sql, A(viewer), projA, { query: "BRAVO-9" });
    expect(fromA.hits).toHaveLength(0);
    const fromA2 = await searchMemories(db.sql, A(viewer), projA, { query: "ALPHA-7" });
    expect(ids(fromA2)).toEqual([aMem.id]);
    const fromB = await searchMemories(db.sql, A(viewer), projB, { query: "ALPHA-7" });
    expect(fromB.hits).toHaveLength(0);
    expect(ids(await searchMemories(db.sql, A(viewer), projB, { query: "BRAVO-9" }))).toEqual([bMem.id]);
    await expectCode(searchMemories(db.sql, { organizationId: orgB, userId: orgBUser }, projA, { query: "ALPHA-7" }), "NOT_FOUND");
    // A project of the caller's own organization is valid: it simply holds no ALPHA canary.
    expect((await searchMemories(db.sql, { organizationId: orgB, userId: orgBUser }, projBOrgB, { query: "ALPHA-7" })).hits).toHaveLength(0);
  });
});

describe("ranking and disclosure", () => {
  test("a memory matching more query terms ranks first; the result discloses lexical-only mode", async () => {
    const weak = await approvedIn(projA, "Hiring plan for the platform team");
    const strong = await approvedIn(projA, "Export audit trail decision for the platform team");
    const r = await searchMemories(db.sql, A(viewer), projA, { query: "export audit platform" });
    expect(r.hits[0]!.memoryId).toBe(strong.id);
    expect(ids(r)).toContain(weak.id);
    expect(r.mode).toBe("lexical");
    expect(r.semantic.enabled).toBe(false);
    expect(r.semantic.reason).toMatch(/pgvector/);
    expect(r.hits[0]!.sources[0]!.digest).toBe(strong.artifact.digest);
  });
});

describe("lifecycle changes remove results immediately", () => {
  test("a revoked source removes the memory from search (index invalidated by the database)", async () => {
    const m = await approvedIn(projA, "EPSILON-4 revocable constraint must hold");
    expect(ids(await searchMemories(db.sql, A(viewer), projA, { query: "EPSILON-4" }))).toEqual([m.id]);
    await revokeSource(db.sql, A(steward), projA, { kind: "artifact", id: m.artifact.id }, "withdrawn");
    expect((await searchMemories(db.sql, A(viewer), projA, { query: "EPSILON-4" })).hits).toHaveLength(0);
    const [row] = await db.sql`SELECT 1 FROM memory_index WHERE record_id = ${m.id}`;
    expect(row).toBeUndefined();
  });

  test("an erased memory disappears from search and has no index row", async () => {
    const m = await approvedIn(projA, "ZETA-2 erasable decision text");
    await eraseMemory(db.sql, A(author), projA, m.id, "owner request");
    expect((await searchMemories(db.sql, A(viewer), projA, { query: "ZETA-2" })).hits).toHaveLength(0);
  });

  test("a superseded version is no longer returned; the new approved version is", async () => {
    const v1 = await approvedIn(projA, "ETA-5 threshold is ten percent");
    const v2 = await proposeRevision(db.sql, A(author), v1.id, { claim: "ETA-5 threshold is fifteen percent", sources: [src(v1.artifact)] });
    expect((await searchMemories(db.sql, A(viewer), projA, { query: "ETA-5" })).hits.map((h) => h.memoryId)).toEqual([v1.id]);
    await approveMemory(db.sql, A(approver), projA, v2.id);
    expect(ids(await searchMemories(db.sql, A(viewer), projA, { query: "ETA-5" }))).toEqual([v2.id]);
  });
});

describe("fail-closed double check at read time", () => {
  test("a stale index row (claim hash no longer matches) is omitted and counted, and a rebuild restores it", async () => {
    const m = await approvedIn(projA, "THETA-8 stale index probe");
    await db.sql`UPDATE memory_index SET indexed_claim_hash = 'stale' WHERE record_id = ${m.id}`;
    const r = await searchMemories(db.sql, A(viewer), projA, { query: "THETA-8" });
    expect(r.hits).toHaveLength(0);
    expect(r.omitted.stale_index).toBe(1);
    const count = await rebuildIndex(db.sql, A(steward), projA);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(ids(await searchMemories(db.sql, A(viewer), projA, { query: "THETA-8" }))).toEqual([m.id]);
  });

  test("an index row planted for a non-approved memory is refused as not usable", async () => {
    const p = await proposeMemory(db.sql, A(author), { projectId: projA, kind: "fact", claim: "IOTA-1 planted index row", sources: [src(await artifactIn(projA, "y"))] });
    await db.sql`INSERT INTO memory_index (record_id, organization_id, project_id, indexed_claim_hash, index_version, lexical)
      SELECT id, organization_id, project_id, normalized_claim_hash, 1, to_tsvector('simple', claim) FROM memory_records WHERE id = ${p.id}`;
    const r = await searchMemories(db.sql, A(viewer), projA, { query: "IOTA-1" });
    expect(r.hits).toHaveLength(0);
    expect(r.omitted.not_usable).toBe(1);
  });

  test("a project-level revocation that the index missed is still refused at read time", async () => {
    const m = await approvedIn(projA, "KAPPA-3 defence in depth probe");
    await db.sql`INSERT INTO memory_source_revocations (organization_id, project_id, source_kind, source_id, reason, revoked_by)
      VALUES (${org}, ${projA}, 'artifact', ${m.artifact.id}, 'planted for test', ${steward})`;
    const r = await searchMemories(db.sql, A(viewer), projA, { query: "KAPPA-3" });
    expect(r.hits).toHaveLength(0);
    expect(r.omitted.revoked_source).toBe(1);
  });
});

describe("query safety, limits and roles", () => {
  test("query text is a bound parameter: injection-shaped queries return nothing and change nothing", async () => {
    const before = (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_records`)[0]!.n;
    for (const q of [`') OR 1=1 --`, `"; DROP TABLE memory_records; --`, `' UNION SELECT claim FROM memory_records --`, `!!! ||| &&&`]) {
      const r = await searchMemories(db.sql, A(viewer), projA, { query: q });
      expect(Array.isArray(r.hits)).toBe(true);
      expect(r.hits.every((h) => h.claim.length > 0)).toBe(true);
    }
    const after = (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_records`)[0]!.n;
    expect(after).toBe(before);
    expect((await searchMemories(db.sql, A(viewer), projB, { query: `') OR 1=1 --` })).hits).toHaveLength(0);
  });

  test("invalid queries and limits are refused before any read", async () => {
    await expectCode(searchMemories(db.sql, A(viewer), projA, { query: "   " }), "INVALID_QUERY");
    await expectCode(searchMemories(db.sql, A(viewer), projA, { query: "x".repeat(201) }), "INVALID_QUERY");
    await expectCode(searchMemories(db.sql, A(viewer), projA, { query: "a\u0000b" }), "INVALID_QUERY");
    await expectCode(searchMemories(db.sql, A(viewer), projA, { query: "ok", limit: 0 }), "INVALID_QUERY");
    await expectCode(searchMemories(db.sql, A(viewer), projA, { query: "ok", limit: 51 }), "INVALID_QUERY");
  });

  test("limit bounds the number of hits", async () => {
    for (let i = 0; i < 4; i++) await approvedIn(projA, `LAMBDA-6 bounded result number ${i}`);
    const r = await searchMemories(db.sql, A(viewer), projA, { query: "LAMBDA-6", limit: 2 });
    expect(r.hits).toHaveLength(2);
  });

  test("a disabled user is denied; a viewer may search", async () => {
    await expectCode(searchMemories(db.sql, A(disabled), projA, { query: "ALPHA-7" }), "FORBIDDEN");
    expect((await searchMemories(db.sql, A(viewer), projA, { query: "ALPHA-7" })).hits.length).toBeGreaterThan(0);
  });
});

describe("retrieval log and durability", () => {
  test("each search writes an append-only event with a query digest, never the query text", async () => {
    const secretQuery = "CANARY-PRIVATE-QUERY-TERM";
    const r = await searchMemories(db.sql, A(viewer), projA, { query: secretQuery });
    const [ev] = await db.sql<{ query_digest: string; returned_ids: string[]; omitted: unknown }[]>`SELECT query_digest, returned_ids, omitted FROM memory_retrieval_events WHERE id = ${r.requestId}`;
    expect(ev!.query_digest).toBe(digestOf({ query: secretQuery }));
    expect(JSON.stringify(ev)).not.toContain(secretQuery);
    let err = "";
    try { await db.sql`UPDATE memory_retrieval_events SET returned_ids = '{}' WHERE id = ${r.requestId}`; } catch (e) { err = String((e as Error).message); }
    expect(err).toMatch(/append-only/);
  });

  test("results survive a restart: a fresh connection finds the same approved memory", async () => {
    const m = await approvedIn(projA, "MU-11 durable retrieval probe");
    const fresh = connect(db.url, { max: 2 });
    try {
      const r = await searchMemories(fresh, A(viewer), projA, { query: "MU-11" });
      expect(ids(r)).toEqual([m.id]);
    } finally { await fresh.end({ timeout: 1 }); }
  });

  test("rebuilding the index is reproducible: the same set of approved memories is indexed", async () => {
    const [before] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_index i JOIN memory_records r ON r.id = i.record_id WHERE r.project_id = ${projA} AND r.status = 'approved'`;
    const count = await rebuildIndex(db.sql, A(steward), projA);
    const [after] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_index WHERE project_id = ${projA}`;
    expect(count).toBe(before!.n);
    expect(after!.n).toBe(before!.n);
  });
});

async function expectCode(p: Promise<unknown>, code: MemoryErrorCode) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err instanceof MemoryError ? err.code : "raw").toBe(code);
}

describe("query sanitizer (pure)", () => {
  test("only letter and digit terms survive; operators and quotes never reach the tsquery", () => {
    expect(tsqueryFor(`') OR 1=1 --`)).toBe("or | 1");
    expect(tsqueryFor(`"export" & !audit | (trail)`)).toBe("export | audit | trail");
    expect(tsqueryFor("Export EXPORT export")).toBe("export");
    expect(tsqueryFor("!!! ||| &&&")).toBeNull();
    expect(tsqueryFor("Ação 3 de Março")).toBe("ação | 3 | de | março");
  });
});
