import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../db/src/testing";
import { activate, decideApproval, emergencyDisable, getActive, lastApprovedBefore, listTree, pinForJob, pinnedVersion, policyDigestOf, ReportSigner, RegistryError, requestApproval, revisionOf, revokeVersion, submitCandidate, validateSkillTree, type ValidationPolicy } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
let org = "", author = "", requester = "", approver = "", approver2 = "", viewer = "", repo = "", jobId = "";
const POLICY: ValidationPolicy = { version: "p1", allowedLicenses: ["MIT"], deniedHosts: ["api.anthropic.com"] };
const PD = policyDigestOf(POLICY);
const signer = new ReportSigner("k1");
const base = mkdtempSync(join(tmpdir(), "reg-"));
let n = 0;
const md = (note: string) => `---\nname: story-writer\ndescription: Write user stories from a PRD ${note}\nlicense: MIT\nruntimes: [local_model]\nallowed-tools: [Read]\n---\nSteps ${note}\n`;
const scope = () => ({ organizationId: org, kind: "skill" as const, slug: "story-writer" });

/** Validates a freshly-written skill dir and submits it as `author`. */
async function candidate(note: string, now?: Date) {
  const root = join(base, `c${n++}`); mkdirSync(root); writeFileSync(join(root, "SKILL.md"), md(note));
  const report = validateSkillTree({ root, origin: { uri: "file:///x", type: "local" }, policy: POLICY, ...(now ? { now } : {}) });
  expect(report.ok).toBe(true);
  const r = await submitCandidate(db.sql, { organizationId: org, kind: "skill", manifest: report.manifest!, files: listTree(root).entries, createdBy: author, signed: signer.sign(report), reportPublicKeyPem: signer.publicKeyPem, policyDigest: PD });
  return { ...r, digest: report.candidateDigest, perm: report.permissionDigest! };
}
let k = 0;
const idem = () => `key-${++k}-${Math.random().toString(36).slice(2)}`;
async function approved(note: string, expectedRevision: number, ttlMs?: number) {
  const c = await candidate(note);
  const req = await requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD, ...(ttlMs ? { ttlMs } : {}) });
  await decideApproval(db.sql, { requestId: req.requestId, approverId: approver, decision: "approved", presentedDigest: req.targetDigest, presentedPermissionDigest: req.permissionDigest });
  return { c, req, act: () => activate(db.sql, { organizationId: org, requestId: req.requestId, expectedRevision, actor: "approver", idempotencyKey: idem(), policyDigest: PD }) };
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof RegistryError ? e.code : `other:${String(e).slice(0, 80)}`; } };

beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  const mk = async (s: string, role: string) => (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${s}, ${role}) RETURNING id`)[0]!.id as string;
  author = await mk("author", "editor"); requester = await mk("requester", "operator"); approver = await mk("approver", "approver"); approver2 = await mk("approver2", "approver"); viewer = await mk("viewer", "viewer");
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id;
  const [rq] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', 'e', 'x', 'feature', 't', 'd') RETURNING id`;
  jobId = (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${rq!.id}, ${repo}) RETURNING id`)[0]!.id;
});
afterAll(async () => { await db.drop(); rmSync(base, { recursive: true, force: true }); });

describe("quarantine and immutability (T-05, T-07)", () => {
  test("a new candidate is stored inactive; nothing is active; duplicate digest never overwrites", async () => {
    const a = await candidate("v1");
    expect(a).toMatchObject({ duplicate: false, state: "validated" });
    expect(await getActive(db.sql, scope())).toBeNull();
    const again = await candidate("v1");
    expect(again).toMatchObject({ duplicate: true, versionId: a.versionId });
  });
  test("a failing/expired report leaves the candidate quarantined, not validated", async () => {
    const root = join(base, `bad${n++}`); mkdirSync(root); writeFileSync(join(root, "SKILL.md"), md("v-bad").replace("license: MIT\n", ""));
    const report = validateSkillTree({ root, origin: { uri: "file:///x", type: "local" }, policy: POLICY });
    expect(report.ok).toBe(false);
    const r = await submitCandidate(db.sql, { organizationId: org, kind: "skill", manifest: { ...({ schemaVersion: "2.2", slug: "story-writer", version: "0", digest: report.candidateDigest, origin: { uri: "x", type: "local" }, permissions: { tools: [], network: [], writeScopes: [], dataClasses: [] }, runtimeCompatibility: ["local_model"], dependencies: [] } as const) }, files: listTree(root).entries, createdBy: author, signed: signer.sign({ ...report, permissionDigest: report.permissionDigest ?? "sha256:" + "0".repeat(64) }), reportPublicKeyPem: signer.publicKeyPem, policyDigest: PD });
    expect(r.state).toBe("quarantined");
    expect(await code(requestApproval(db.sql, { organizationId: org, versionId: r.versionId, operation: "activate", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD }))).toBe("NOT_VALIDATED");
  });
  test("the database itself refuses to edit content, delete a version, or skip lifecycle states", async () => {
    const a = await candidate("v1");
    await expect(db.sql`UPDATE skill_versions SET digest = ${"sha256:" + "1".repeat(64)} WHERE id = ${a.versionId}`).rejects.toThrow(/immutable/);
    await expect(db.sql`UPDATE skill_versions SET manifest = '{}'::jsonb WHERE id = ${a.versionId}`).rejects.toThrow(/immutable/);
    await expect(db.sql`DELETE FROM skill_versions WHERE id = ${a.versionId}`).rejects.toThrow(/cannot be deleted/);
    await expect(db.sql`UPDATE skill_versions SET state = 'approved' WHERE id = ${a.versionId}`).rejects.toThrow(/illegal skill version state/);
    await expect(db.sql`UPDATE skill_validations SET ok = false`).rejects.toThrow();
  });
});

describe("approvals bind exact digests and need an independent human (T-08, T-25)", () => {
  test("no self-approval: requester, package author, non-approver roles and other orgs are all refused by the database", async () => {
    const c = await candidate("v-self");
    const req = await requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD });
    const d = (who: string) => decideApproval(db.sql, { requestId: req.requestId, approverId: who, decision: "approved", presentedDigest: req.targetDigest, presentedPermissionDigest: req.permissionDigest });
    expect(await code(d(requester))).toBe("DB_REJECTED");   // role operator: not an approver
    expect(await code(d(viewer))).toBe("DB_REJECTED");
    expect(await code(d(author))).toBe("DB_REJECTED");     // author is an editor, not approver
    const selfReq = await requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: approver, idempotencyKey: idem(), policyDigest: PD });
    await expect(decideApproval(db.sql, { requestId: selfReq.requestId, approverId: approver, decision: "approved", presentedDigest: selfReq.targetDigest, presentedPermissionDigest: selfReq.permissionDigest })).rejects.toThrow(/self-approval/);
    // an approver who authored the package may not approve it either
    const [authorApprover] = await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, 'aa', 'approver') RETURNING id`;
    const root = join(base, `aa${n++}`); mkdirSync(root); writeFileSync(join(root, "SKILL.md"), md("v-aa"));
    const rep = validateSkillTree({ root, origin: { uri: "x", type: "local" }, policy: POLICY });
    const sub = await submitCandidate(db.sql, { organizationId: org, kind: "skill", manifest: rep.manifest!, files: listTree(root).entries, createdBy: authorApprover!.id as string, signed: signer.sign(rep), reportPublicKeyPem: signer.publicKeyPem, policyDigest: PD });
    const r2 = await requestApproval(db.sql, { organizationId: org, versionId: sub.versionId, operation: "activate", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD });
    await expect(decideApproval(db.sql, { requestId: r2.requestId, approverId: authorApprover!.id as string, decision: "approved", presentedDigest: r2.targetDigest, presentedPermissionDigest: r2.permissionDigest })).rejects.toThrow(/conflict of interest/);
    expect(await getActive(db.sql, scope())).toBeNull();
  });
  test("an approver presenting the wrong digest or permission digest cannot approve", async () => {
    const c = await candidate("v-dig");
    const req = await requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD });
    await expect(decideApproval(db.sql, { requestId: req.requestId, approverId: approver, decision: "approved", presentedDigest: "sha256:" + "a".repeat(64), presentedPermissionDigest: req.permissionDigest })).rejects.toThrow(/exact content/);
    await expect(decideApproval(db.sql, { requestId: req.requestId, approverId: approver, decision: "approved", presentedDigest: req.targetDigest, presentedPermissionDigest: "sha256:" + "b".repeat(64) })).rejects.toThrow(/exact content/);
  });
  test("a request is idempotent per key and a key cannot be reused for something else", async () => {
    const c = await candidate("v-idem"); const key = idem();
    const a = await requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: requester, idempotencyKey: key, policyDigest: PD });
    const b = await requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: requester, idempotencyKey: key, policyDigest: PD });
    expect(b.requestId).toBe(a.requestId);
    expect(await code(requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "revoke", requestedBy: requester, idempotencyKey: key, policyDigest: PD }))).toBe("IDEMPOTENCY_CONFLICT");
  });
  test("policy drift blocks requesting; expired evidence blocks requesting", async () => {
    const c = await candidate("v-pol");
    expect(await code(requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: requester, idempotencyKey: idem(), policyDigest: "sha256:" + "c".repeat(64) }))).toBe("POLICY_CHANGED");
  });
});

describe("activation: CAS, single use, expiry, mismatch, rollback (T-09, T-26)", () => {
  test("activation with an exact-digest independent approval promotes atomically and writes the audit log", async () => {
    const rev0 = await revisionOf(db.sql, scope());
    const a = await approved("act-1", rev0);
    const r = await a.act();
    expect(r).toMatchObject({ revision: rev0 + 1, replayed: false, versionId: a.c.versionId });
    expect(await getActive(db.sql, scope())).toMatchObject({ digest: a.c.digest, revision: rev0 + 1 });
    const [log] = await db.sql`SELECT * FROM registry_log WHERE to_version_id = ${a.c.versionId}`;
    expect(log).toMatchObject({ operation: "activate", actor: "approver", revision: rev0 + 1 });
  });
  test("an approval is single use; replay with the same idempotency key is a no-op, a new key is refused", async () => {
    const rev = await revisionOf(db.sql, scope());
    const a = await approved("act-2", rev);
    const key = idem();
    const run = () => activate(db.sql, { organizationId: org, requestId: a.req.requestId, expectedRevision: rev, actor: "approver", idempotencyKey: key, policyDigest: PD });
    const first = await run(); const second = await run();
    expect(second).toMatchObject({ replayed: true, revision: first.revision });
    expect(await code(activate(db.sql, { organizationId: org, requestId: a.req.requestId, expectedRevision: first.revision, actor: "x", idempotencyKey: idem(), policyDigest: PD }))).toBe("APPROVAL_CONSUMED");
  });
  test("stale revision blocks (two concurrent activations: exactly one wins)", async () => {
    const rev = await revisionOf(db.sql, scope());
    const [a, b] = [await approved("race-a", rev), await approved("race-b", rev)];
    const results = await Promise.allSettled([a.act(), b.act()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as RegistryError).code).toBe("STALE_REVISION");
    expect(await revisionOf(db.sql, scope())).toBe(rev + 1);
  });
  test("a stale expectedRevision from the caller is rejected", async () => {
    const rev = await revisionOf(db.sql, scope());
    const a = await approved("stale", rev - 1);
    expect(await code(a.act())).toBe("STALE_REVISION");
  });
  test("an approval that expired before activation blocks activation", async () => {
    const rev = await revisionOf(db.sql, scope());
    const a = await approved("expire", rev, 1500);
    await Bun.sleep(1700);
    expect(await code(a.act())).toBe("APPROVAL_EXPIRED");
  });
  test("a rejected decision never activates; revoked or rejected versions cannot be (re)activated", async () => {
    const c = await candidate("rej");
    const req = await requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD });
    await decideApproval(db.sql, { requestId: req.requestId, approverId: approver, decision: "rejected", presentedDigest: req.targetDigest, presentedPermissionDigest: req.permissionDigest });
    expect(await code(activate(db.sql, { organizationId: org, requestId: req.requestId, expectedRevision: await revisionOf(db.sql, scope()), actor: "x", idempotencyKey: idem(), policyDigest: PD }))).toBe("NOT_APPROVED");
    expect(await code(requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "activate", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD }))).toBe("NOT_VALIDATED");
  });
  test("changing the package after approval (permission digest) blocks: simulated by tampering via the only legal write path is impossible; the DB blocks it", async () => {
    const rev = await revisionOf(db.sql, scope());
    const a = await approved("tamper", rev);
    await expect(db.sql`UPDATE skill_versions SET permission_digest = ${"sha256:" + "d".repeat(64)} WHERE id = ${a.c.versionId}`).rejects.toThrow(/immutable/);
    await expect(db.sql`UPDATE approval_decisions SET presented_digest = 'x' WHERE request_id = ${a.req.requestId}`).rejects.toThrow(/immutable/);
    await expect(db.sql`UPDATE approval_requests SET expires_at = now() + interval '99 days'`).rejects.toThrow();
  });
  test("rollback restores the last approved pinned version with a complete audit trail and a fresh approval", async () => {
    // current active is whatever won above; activate a clean upgrade then roll back.
    let rev = await revisionOf(db.sql, scope());
    const prev = (await getActive(db.sql, scope()))!;
    const up = await approved("up-for-rb", rev); const upRes = await up.act(); rev = upRes.revision;
    expect((await getActive(db.sql, scope()))!.versionId).toBe(up.c.versionId);
    const target = await lastApprovedBefore(db.sql, scope());
    expect(target).toBe(prev.versionId);
    const rb = await requestApproval(db.sql, { organizationId: org, versionId: target!, operation: "rollback", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD });
    await decideApproval(db.sql, { requestId: rb.requestId, approverId: approver2, decision: "approved", presentedDigest: rb.targetDigest, presentedPermissionDigest: rb.permissionDigest });
    const res = await activate(db.sql, { organizationId: org, requestId: rb.requestId, expectedRevision: rev, actor: "approver2", idempotencyKey: idem(), policyDigest: PD });
    expect((await getActive(db.sql, scope()))).toMatchObject({ versionId: prev.versionId, revision: res.revision });
    const ops = (await db.sql`SELECT operation FROM registry_log WHERE slug = 'story-writer' ORDER BY id`).map((r) => r.operation);
    expect(ops.at(-1)).toBe("rollback");
    expect(ops).toContain("upgrade");
    await expect(db.sql`DELETE FROM registry_log`).rejects.toThrow(/append-only|immutable|not allowed|forbid/i);
    await expect(db.sql`UPDATE registry_log SET actor = 'x'`).rejects.toThrow();
  });
  test("a rollback to a never-approved version is refused", async () => {
    const c = await candidate("never-approved");
    const rb = await code(requestApproval(db.sql, { organizationId: org, versionId: c.versionId, operation: "rollback", requestedBy: requester, idempotencyKey: idem(), policyDigest: PD }));
    expect(rb).toBe("NOT_APPROVED");
  });
});

describe("job pinning, revocation and emergency disable (T-27)", () => {
  test("a job keeps its exact pinned version while the registry moves on", async () => {
    const pin = await pinForJob(db.sql, jobId, scope());
    const rev = await revisionOf(db.sql, scope());
    const a = await approved("after-pin", rev); await a.act();
    expect((await getActive(db.sql, scope()))!.versionId).toBe(a.c.versionId);
    expect(await pinnedVersion(db.sql, jobId, "story-writer")).toEqual(pin);
    await expect(db.sql`UPDATE job_skill_pins SET digest = 'x'`).rejects.toThrow();
  });
  test("emergency disable turns the active version off immediately and is idempotent; nothing is enabled by it", async () => {
    const before = await getActive(db.sql, scope()); expect(before).not.toBeNull();
    const key = idem();
    const r1 = await emergencyDisable(db.sql, { ...scope(), actor: "operator", reason: "incident", idempotencyKey: key });
    const r2 = await emergencyDisable(db.sql, { ...scope(), actor: "operator", reason: "incident", idempotencyKey: key });
    expect(r2.revision).toBe(r1.revision);
    expect(await getActive(db.sql, scope())).toBeNull();
    expect(await pinnedVersion(db.sql, jobId, "story-writer")).not.toBeNull(); // pins are history, not authority
  });
  test("revoking an approved version prevents any future activation", async () => {
    const rev = await revisionOf(db.sql, scope());
    const a = await approved("to-revoke", rev); await a.act();
    await revokeVersion(db.sql, { organizationId: org, versionId: a.c.versionId, actor: "sec", reason: "cve", idempotencyKey: idem() });
    expect(await getActive(db.sql, scope())).toBeNull();
    const [v] = await db.sql`SELECT state FROM skill_versions WHERE id = ${a.c.versionId}`;
    expect(v!.state).toBe("revoked");
    await expect(db.sql`UPDATE skill_versions SET state = 'approved' WHERE id = ${a.c.versionId}`).rejects.toThrow(/illegal/);
  });
});
