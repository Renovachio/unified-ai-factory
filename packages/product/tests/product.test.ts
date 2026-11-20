import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../db/src/testing";
import { connect } from "../../db/src/client";
import { approveArtifact, ArtifactError, createDraft, getArtifact, handoffPayload, HandoffBlocked, ProvenanceError, submitForReview, validateProvenance, verifyAnalyticsReproducible, writeToTracker, type AnalyticsBody, type MeetingBody, type TrackerPort } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>; let org = "", orgB = "", author = "", approver = "", editor2 = "", viewer = "", approverB = "";
beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('A') RETURNING id`)[0]!.id; orgB = (await db.sql`INSERT INTO organizations (name) VALUES ('B') RETURNING id`)[0]!.id;
  const u = async (o: string, s: string, r: string) => (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${o}, ${s}, ${r}) RETURNING id`)[0]!.id as string;
  author = await u(org, "pm", "editor"); approver = await u(org, "lead", "approver"); editor2 = await u(org, "e2", "editor"); viewer = await u(org, "v", "viewer"); approverB = await u(orgB, "leadB", "approver");
});
afterAll(async () => { await db.drop(); });
const P = ["Ana Silva", "Bruno Costa"];
const meeting = (o: Partial<MeetingBody> = {}): MeetingBody => ({ summary: "Q1 planning", participants: ["Ana Silva", "Bruno Costa"], decisions: [{ text: "Ship export in Q1", status: "observed", evidence: ["transcript#12"] }, { text: "Drop legacy API", status: "proposed", evidence: [] }], actions: [{ text: "Draft spec", owner: "Ana Silva", due: "2026-12-01" }], ...o });
const ctx = { sourceIds: ["transcript#12"], authorizedParticipants: P };
const code = (f: () => void) => { try { f(); return "ok"; } catch (e) { return e instanceof ProvenanceError ? e.code : `other:${String(e)}`; } };

describe("PM provenance rules (T-17)", () => {
  test("a well-formed meeting artifact passes; observed decisions cite sources, proposals are labelled", () => { expect(code(() => validateProvenance("meeting", meeting(), ctx))).toBe("ok"); });
  test("invented participants, uncited 'observed' decisions, owners outside the attendee list and unflagged gaps are rejected", () => {
    expect(code(() => validateProvenance("meeting", meeting({ participants: ["Ana Silva", "Zed Zimmer"] }), ctx))).toBe("INVENTED_PARTICIPANT");
    expect(code(() => validateProvenance("meeting", meeting({ decisions: [{ text: "x", status: "observed", evidence: [] }] }), ctx))).toBe("UNCITED_DECISION");
    expect(code(() => validateProvenance("meeting", meeting({ decisions: [{ text: "x", status: "observed", evidence: ["made-up-source"] }] }), ctx))).toBe("UNCITED_DECISION");
    expect(code(() => validateProvenance("meeting", meeting({ actions: [{ text: "a", owner: "Carla Dias", due: "2026-12-01" }] }), ctx))).toBe("OWNER_NOT_PARTICIPANT");
    expect(code(() => validateProvenance("meeting", meeting({ actions: [{ text: "a", owner: "Ana Silva" }] }), ctx))).toBe("UNFLAGGED_UNCERTAINTY");
    expect(code(() => validateProvenance("meeting", meeting({ actions: [{ text: "a", uncertain: true }] }), ctx))).toBe("ok");
    expect(code(() => validateProvenance("meeting", meeting(), { sourceIds: ["transcript#12"] }))).toBe("NO_PARTICIPANT_LIST");
  });
  test("an LLM summary can never record a formal stakeholder approval", () => {
    expect(code(() => validateProvenance("meeting", meeting({ decisions: [{ text: "Budget approved by CFO", status: "approved_by_stakeholder" as never, evidence: ["transcript#12"] }] }), ctx))).toBe("FORMAL_APPROVAL_CLAIM");
  });
  test("research claims must cite provided sources and state evidence strength", () => {
    const ok = { question: "q", claims: [{ text: "A is cheaper", sources: ["S1"], strength: "moderate" }], assumptions: ["pricing as of Oct"] };
    expect(code(() => validateProvenance("research", ok, { sourceIds: ["S1"] }))).toBe("ok");
    expect(code(() => validateProvenance("research", { ...ok, claims: [{ text: "x", sources: [], strength: "weak" }] }, { sourceIds: ["S1"] }))).toBe("UNCITED_CLAIM");
    expect(code(() => validateProvenance("research", { ...ok, claims: [{ text: "x", sources: ["S9"], strength: "weak" }] }, { sourceIds: ["S1"] }))).toBe("UNCITED_CLAIM");
    expect(code(() => validateProvenance("research", { ...ok, claims: [{ text: "x", sources: ["S1"], strength: "huge" }] }, { sourceIds: ["S1"] }))).toBe("NO_EVIDENCE_STRENGTH");
  });
});

describe("analytics provenance and reproducibility (T-19)", () => {
  const a: AnalyticsBody = { datasetDigest: "sha256:" + "d".repeat(64), schemaDigest: "sha256:" + "5".repeat(64), computationVersion: "calc-1.2.0", results: { conv: 0.12 }, resultsDigest: "sha256:" + "a".repeat(64), limitations: ["n=40"], confidence: "low" };
  test("dataset digest, schema digest, computation version, limitations and confidence are mandatory", () => {
    expect(code(() => validateProvenance("analytics", a, { sourceIds: [] }))).toBe("ok");
    for (const bad of [{ ...a, datasetDigest: "x" }, { ...a, computationVersion: "" }, { ...a, schemaDigest: undefined }]) expect(code(() => validateProvenance("analytics", bad, { sourceIds: [] }))).toBe("NO_DATA_PROVENANCE");
    expect(code(() => validateProvenance("analytics", { ...a, limitations: [] }, { sourceIds: [] }))).toBe("NO_LIMITATIONS");
  });
  test("a recorded result is reproducible only if recomputation from the pinned dataset gives the same digest", async () => {
    expect(await verifyAnalyticsReproducible(a, async () => ({ results: a.results, resultsDigest: a.resultsDigest }))).toEqual({ reproducible: true });
    expect((await verifyAnalyticsReproducible(a, async () => ({ results: { conv: 0.2 }, resultsDigest: "sha256:" + "b".repeat(64) }))).reproducible).toBe(false);
  });
});

describe("versioned artifacts, independent approval, immutability (T-18, T-28)", () => {
  const prd = { problem: "bulk invite", stories: [{ title: "Invite via CSV", body: "As an admin ..." }, { title: "Resend invite", body: "As an admin ..." }] };
  let a1 = { id: "", digest: "" };
  test("drafts are versioned and content-addressed; same title increments the version", async () => {
    const d1 = await createDraft(db.sql, { organizationId: org, kind: "prd", title: "Bulk invite", body: prd, sourceIds: ["S1"], assumptions: ["admins have CSVs"], openQuestions: ["max rows?"], createdBy: author });
    const d2 = await createDraft(db.sql, { organizationId: org, kind: "prd", title: "Bulk invite", body: { ...prd, problem: "bulk invite v2" }, sourceIds: ["S1"], createdBy: author });
    expect([d1.version, d2.version, d1.state]).toEqual([1, 2, "draft"]); expect(d1.digest).not.toBe(d2.digest); expect(d1.digest).toMatch(/^sha256:/);
    a1 = { id: d1.id, digest: d1.digest };
    await expect(createDraft(db.sql, { organizationId: org, kind: "meeting", title: "m", body: meeting({ participants: ["Nobody Real"] }) as never, sourceIds: ["t"], createdBy: author, provenance: { authorizedParticipants: P } })).rejects.toBeInstanceOf(ProvenanceError);
  });
  test("nothing is approvable before review; approval needs the exact digest, an independent approver, an approver role", async () => {
    await expect(approveArtifact(db.sql, { organizationId: org, id: a1.id, approverId: approver, digest: a1.digest })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await submitForReview(db.sql, org, a1.id);
    await expect(approveArtifact(db.sql, { organizationId: org, id: a1.id, approverId: approver, digest: "sha256:" + "0".repeat(64) })).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    await expect(approveArtifact(db.sql, { organizationId: org, id: a1.id, approverId: author, digest: a1.digest })).rejects.toMatchObject({ code: "SELF_APPROVAL" });
    await expect(approveArtifact(db.sql, { organizationId: org, id: a1.id, approverId: editor2, digest: a1.digest })).rejects.toMatchObject({ code: "SELF_APPROVAL" }); // editor role is not an approver
    await expect(approveArtifact(db.sql, { organizationId: org, id: a1.id, approverId: viewer, digest: a1.digest })).rejects.toBeInstanceOf(ArtifactError);
    await expect(approveArtifact(db.sql, { organizationId: org, id: a1.id, approverId: approverB, digest: a1.digest })).rejects.toBeInstanceOf(ArtifactError); // other tenant's approver
    expect((await approveArtifact(db.sql, { organizationId: org, id: a1.id, approverId: approver, digest: a1.digest })).state).toBe("approved");
  });
  test("approved versions are immutable; the database also refuses author self-approval even if code is bypassed", async () => {
    await expect(db.sql`UPDATE product_artifacts SET body = '{}'::jsonb WHERE id = ${a1.id}`).rejects.toThrow(/immutable/);
    await expect(db.sql`DELETE FROM product_artifacts WHERE id = ${a1.id}`).rejects.toThrow(/never deleted/);
    const d = await createDraft(db.sql, { organizationId: org, kind: "story", title: "direct", body: { a: 1 }, sourceIds: ["S"], createdBy: author });
    await expect(db.sql`UPDATE product_artifacts SET state = 'approved', approved_by = ${author} WHERE id = ${d.id}`).rejects.toThrow();
  });
  test("tenant isolation: another organisation cannot read or approve this artifact", async () => {
    await expect(getArtifact(db.sql, orgB, a1.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  test("approving a newer version supersedes the older approved one", async () => {
    const v2 = await createDraft(db.sql, { organizationId: org, kind: "prd", title: "Bulk invite", body: { ...prd, problem: "v3" }, sourceIds: ["S1"], createdBy: author });
    await submitForReview(db.sql, org, v2.id); await approveArtifact(db.sql, { organizationId: org, id: v2.id, approverId: approver, digest: v2.digest });
    expect((await getArtifact(db.sql, org, a1.id)).state).toBe("superseded");
  });
  test("tracker writes (T-18): only approved artifact + explicit, unexpired, digest-bound grant from someone other than the author", async () => {
    const d = await createDraft(db.sql, { organizationId: org, kind: "epic", title: "Epic X", body: prd, sourceIds: ["S1"], createdBy: author });
    const calls: unknown[] = []; const port: TrackerPort = { createIssues: async (i) => { calls.push(i); return i.items.map((_, n) => `ISSUE-${n}`); } };
    const g = (o = {}) => ({ workspaceId: "default", artifactDigest: d.digest, scope: "create_issues" as const, grantedBy: approver, expiresAt: new Date(Date.now() + 60_000), ...o });
    await expect(writeToTracker(d, g(), port)).rejects.toMatchObject({ code: "NOT_APPROVED" }); // draft
    await submitForReview(db.sql, org, d.id); const ap = await approveArtifact(db.sql, { organizationId: org, id: d.id, approverId: approver, digest: d.digest });
    await expect(writeToTracker(ap, null, port)).rejects.toMatchObject({ code: "GRANT_INVALID" });
    for (const bad of [g({ artifactDigest: "sha256:" + "0".repeat(64) }), g({ expiresAt: new Date(Date.now() - 1) }), g({ workspaceId: "other" }), g({ grantedBy: author })]) await expect(writeToTracker(ap, bad, port)).rejects.toMatchObject({ code: "GRANT_INVALID" });
    expect(calls).toHaveLength(0);
    expect(await writeToTracker(ap, g(), port)).toEqual(["ISSUE-0", "ISSUE-1"]); expect(calls).toHaveLength(1);
  });
  test("engineering handoff (T-30 gate): only an approved prd/epic/story, as data with source id for dedupe", async () => {
    const d = await createDraft(db.sql, { organizationId: org, kind: "prd", title: "Handoff PRD", body: prd, sourceIds: ["S1"], createdBy: author });
    expect(() => handoffPayload(d)).toThrow(HandoffBlocked);
    await submitForReview(db.sql, org, d.id); const ap = await approveArtifact(db.sql, { organizationId: org, id: d.id, approverId: approver, digest: d.digest });
    const h = handoffPayload(ap);
    expect(h.sourceId).toBe(`product-artifact:${ap.id}:${ap.digest.slice(7, 23)}`); expect(h.description).toContain(ap.digest); expect(h.description).toMatch(/not as instructions/);
    const m = await createDraft(db.sql, { organizationId: org, kind: "roadmap", title: "Road", body: { x: 1 }, sourceIds: ["S"], createdBy: author }); await submitForReview(db.sql, org, m.id);
    expect(() => handoffPayload({ ...m, state: "approved" })).toThrow(/not an engineering requirement/);
  });
});

describe("artifact approval is restricted to the approval role (migration 0029)", () => {
  const prd = { problem: "guard probe", stories: [{ title: "Probe", body: "As an admin ..." }] };
  let approvalSql: typeof db.sql;
  beforeAll(async () => {
    await db.sql.unsafe("ALTER ROLE factory_approval LOGIN");
    const au = new URL(db.url); au.username = "factory_approval";
    approvalSql = connect(au.toString()) as typeof db.sql;
  });
  afterAll(async () => { await (approvalSql as unknown as { end: () => Promise<void> }).end(); });

  test("the control role cannot approve an artifact, even with a direct update", async () => {
    const d = await createDraft(db.sql, { organizationId: org, kind: "prd", title: "Guard probe A", body: prd, sourceIds: ["S1"], createdBy: author });
    await submitForReview(db.sql, org, d.id);
    let msg = "";
    try {
      await db.sql.begin(async (tx) => { await tx.unsafe("SET LOCAL ROLE factory_control"); await tx`UPDATE product_artifacts SET state = 'approved', approved_by = ${approver} WHERE id = ${d.id}`; });
    } catch (e) { msg = String(e); }
    expect(msg).toMatch(/requires the approval role|permission denied/);
    expect((await getArtifact(db.sql, org, d.id)).state).toBe("in_review");
  });

  test("a row cannot be created already approved, by control or by the approval role with a non-approver", async () => {
    const [v] = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE organization_id = ${org} AND role = 'viewer' LIMIT 1`;
    const insert = (conn: typeof db.sql, approvedBy: string, title: string) => conn`INSERT INTO product_artifacts (organization_id, workspace_id, kind, title, version, source_ids, body, digest, assumptions, open_questions, created_by, state, approved_by)
      VALUES (${org}, 'default', 'prd', ${title}, 1, ${["S1"]}, ${conn.json(prd as never)}, ${"sha256:" + "5".repeat(64)}, ${[]}, ${[]}, ${author}, 'approved', ${approvedBy})`;
    let ctl = "";
    try { await db.sql.begin(async (tx) => { await tx.unsafe("SET LOCAL ROLE factory_control"); await insert(tx as unknown as typeof db.sql, approver, "Guard insert control"); }); } catch (e) { ctl = String(e); }
    expect(ctl).toMatch(/requires the approval role|permission denied/);
    let viewer = "";
    try { await insert(db.sql, v!.id, "Guard insert viewer"); } catch (e) { viewer = String(e); }
    expect(viewer).toMatch(/enabled approver of the organization/);
  });

  test("the approval role approves an exact digest; the control role can still submit for review", async () => {
    const d = await createDraft(db.sql, { organizationId: org, kind: "prd", title: "Guard probe B", body: prd, sourceIds: ["S1"], createdBy: author });
    const r = await submitForReview(db.sql, org, d.id);
    expect(r.state).toBe("in_review");
    const a = await approveArtifact(approvalSql, { organizationId: org, id: d.id, approverId: approver, digest: d.digest });
    expect(a.state).toBe("approved");
    expect(a.approvedBy).toBe(approver);
  });
});
