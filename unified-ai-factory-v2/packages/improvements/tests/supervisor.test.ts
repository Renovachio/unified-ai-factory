import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "@factory/db";
import { recordSignal } from "@factory/capabilities";
import { benchmarkDigests, runPairedComparison, type Benchmark, type IndependentGrader, type PairedSubject } from "@factory/evals";
import { activate, decideApproval, getActive, listTree, policyDigestOf, ReportSigner, requestApproval, revisionOf, submitCandidate, treeDigest, validateSkillTree, type ValidationPolicy } from "@factory/skills";
import { createTestDb } from "../../db/src/testing";
import { advance, generateCandidate, getProposal, ledgerFor, listProposals, lockBenchmark, monitorOnce, recordComparison, superviseOnce, type BoundedChange, type SupervisorDeps } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
const base = mkdtempSync(join(tmpdir(), "sup-"));
const POLICY: ValidationPolicy = { version: "p1", allowedLicenses: ["MIT"], deniedHosts: ["api.anthropic.com"] }; const PD = policyDigestOf(POLICY); const signer = new ReportSigner("k");
let org = "", author = "", requester = "", approver = "", approver2 = "";
const SKILL = `---\nname: prd-writer\ndescription: Write a product requirements document from research notes\nlicense: MIT\nruntimes: [local_model]\nallowed-tools: [Read]\ndomains: [product]\nproduces: [prd]\n---\n# Steps\n1. Read notes.\n2. Write the problem and goals.\n`;
const CHANGE: BoundedChange = { path: "SKILL.md", find: "2. Write the problem and goals.\n", replace: "2. Write the problem and goals.\n3. Add a Non-goals section listing what is explicitly out of scope.\n" };
let v1dir = ""; let v1 = { versionId: "", digest: "" };

/** Runs `fn` as a given database role inside one transaction (privileges are the ROLE's, not the superuser's). */
const asRole = async <T>(role: string, fn: (tx: Sql) => Promise<T>): Promise<T> => (await db.sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE ${role}`); return fn(tx as unknown as Sql); })) as T;
const denied = async (role: string, stmt: string) => { try { await asRole(role, (tx) => tx.unsafe(stmt)); return "allowed"; } catch (e) { const m = String(e); return /permission denied|cannot|forbidden|illegal|immutable|not allowed|self-approval|supervisor/i.test(m) ? "denied" : `other: ${m.slice(0, 140)}`; } };

async function seedActiveV1() {
  v1dir = mkdtempSync(join(base, "v1-")); writeFileSync(join(v1dir, "SKILL.md"), SKILL);
  const rep = validateSkillTree({ root: v1dir, origin: { uri: "x", type: "local" }, policy: POLICY });
  const sub = await submitCandidate(db.sql, { organizationId: org, kind: "skill", manifest: rep.manifest!, files: listTree(v1dir).entries, createdBy: author, signed: signer.sign(rep), reportPublicKeyPem: signer.publicKeyPem, policyDigest: PD });
  const req = await requestApproval(db.sql, { organizationId: org, versionId: sub.versionId, operation: "activate", requestedBy: requester, idempotencyKey: "seed-v1-req", policyDigest: PD });
  await decideApproval(db.sql, { requestId: req.requestId, approverId: approver, decision: "approved", presentedDigest: req.targetDigest, presentedPermissionDigest: req.permissionDigest });
  await activate(db.sql, { organizationId: org, requestId: req.requestId, expectedRevision: 0, actor: "approver", idempotencyKey: "seed-v1-act", policyDigest: PD });
  v1 = { versionId: sub.versionId, digest: rep.candidateDigest };
}
function benchmark(): Benchmark {
  const mk = (id: string) => ({ id, role: "pm.prd", input: "write prd", checks: [{ type: "contains" as const, value: "problem" }, { type: "contains" as const, value: "non-goals" }] });
  return { name: "pm-prd-seeded", version: "1", role: "pm.prd", graderId: "grader:prd", minSamples: 20, roleThreshold: 0.7, tasks: Array.from({ length: 32 }, (_, i) => mk(`p${i}`)), holdout: Array.from({ length: 8 }, (_, i) => mk(`h${i}`)) };
}
let benchId = ""; let bench: Benchmark;
const grader: IndependentGrader = { id: "grader:independent", review: async (_t, out) => ({ rubricScore: out.includes("non-goals") ? 1 : 0.5, criticalFlags: [] }) };
const subjectFromDir = (id: string, dir: string, digest: string): PairedSubject => ({ id, digest, runtime: "local_model", run: async () => ({ output: readFileSync(join(dir, "SKILL.md"), "utf8").toLowerCase().includes("non-goals") ? "problem and non-goals" : "problem only" }) });

function deps(sql: Sql, o: { improves?: boolean } = {}): SupervisorDeps {
  return {
    sql, organizationId: org,
    proposeCandidate: async () => { const scratch = mkdtempSync(join(base, "scratch-")); const change = o.improves === false ? { ...CHANGE, replace: CHANGE.find + "3. Be polite.\n" } : CHANGE; const candidate = generateCandidate({ approvedDir: v1dir, scratchBase: scratch, change, policy: POLICY }); return { candidate, plan: { problem: "p", hypothesis: { statement: "adds non-goals instruction", metric: "non_goals_rate", baseline: 0.4, target: 0.9, direction: "increase", falsifiedIf: "no gain in paired eval" }, change, expectedBenefit: "x", risk: "low", rollbackCriteria: "roll back if prd_quality < 0.8 over 10+ samples", evaluationPlan: { benchmarkName: bench.name, benchmarkVersion: "1", minSamples: 20, metric: "non_goals_rate", threshold: 0.9, independentEvaluator: true }, signalIds: [] } }; },
    evaluate: async ({ target, candidate }) => {
      const report = await runPairedComparison({ benchmark: bench, lockedDigests: benchmarkDigests(bench), baseline: subjectFromDir("baseline", v1dir, target.digest), candidate: subjectFromDir("candidate", candidate.dir, candidate.candidateDigest), grader, policyDigest: PD, allowedRuntimes: ["local_model"], dataProvenanceValid: true });
      const comparisonId = await asRole("factory_evaluator", (tx) => recordComparison(tx, { organizationId: org, benchmarkId: benchId, report, evaluator: "grader:independent" }));
      return { comparisonId, report, evaluatorId: "grader:independent" };
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  const u = async (s: string, r: string) => (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${s}, ${r}) RETURNING id`)[0]!.id as string;
  author = await u("author", "editor"); requester = await u("requester", "operator"); approver = await u("approver", "approver"); approver2 = await u("approver2", "approver");
  await seedActiveV1();
  bench = benchmark(); benchId = (await lockBenchmark(db.sql, { organizationId: org, benchmark: bench, createdBy: author })).id;
  // seeded quality regression: repeated omissions reported against the exact ACTIVE version
  for (let i = 0; i < 5; i++) await recordSignal(db.sql, { organizationId: org, kind: "low_quality", targetVersionId: v1.versionId, intent: "prd omits non goals section", optedIn: true, anonymized: true, evidence: `omission-${i}` });
  // a stale-version signal must be ignored
  for (let i = 0; i < 5; i++) await recordSignal(db.sql, { organizationId: org, kind: "low_quality", targetVersionId: null as never, intent: "something else entirely", optedIn: true, anonymized: true, evidence: `x-${i}` });
});
afterAll(async () => { await db.drop(); rmSync(base, { recursive: true, force: true }); });

describe("SAI-11 supervisor: detect, propose, evaluate independently, package for humans", () => {
  test("it autonomously detects the seeded regression and creates an evidence-backed proposal awaiting approval — changing nothing live", async () => {
    const versionsBefore = Number((await db.sql`SELECT count(*) AS n FROM skill_versions`)[0]!.n);
    const revBefore = await revisionOf(db.sql, { organizationId: org, kind: "skill", slug: "prd-writer" });
    const run = await asRole("factory_supervisor", (tx) => superviseOnce(deps(tx)));
    expect(run.observed).toBe(5);
    expect(run.proposals).toEqual([expect.objectContaining({ created: true })]);
    expect(run.packages).toHaveLength(1);
    const pkg = run.packages[0]!;
    expect(pkg).toMatchObject({ target: { digest: v1.digest }, approvalRequired: true, security: { ok: true, errors: [] }, grantedScopes: { tools: ["Read"] }, license: { declared: "MIT" } });
    expect(pkg.diff).toContain("+3. Add a Non-goals section");
    expect(pkg.confidence).toMatchObject({ status: "passed", sampleSize: 40 }); expect(pkg.confidence.ciLow).toBeGreaterThan(0);
    expect(pkg.rollbackRules).toMatch(/roll back/);
    const p = (await listProposals(db.sql, org))[0]!;
    expect(p).toMatchObject({ state: "awaiting_approval", targetDigest: v1.digest, candidateDigest: pkg.candidateDigest });
    // nothing live changed: same versions, same active pointer and revision, supervisor stored no new version
    expect(Number((await db.sql`SELECT count(*) AS n FROM skill_versions`)[0]!.n)).toBe(versionsBefore);
    expect((await getActive(db.sql, { organizationId: org, kind: "skill", slug: "prd-writer" }))).toMatchObject({ digest: v1.digest, revision: revBefore });
    const ev = (await ledgerFor(db.sql, p.id)).map((l) => l.event);
    expect(ev).toEqual(["triaged", "evaluated", "approval_package"]);
    const evaluated = (await ledgerFor(db.sql, p.id)).find((l) => l.event === "evaluated")!;
    expect(evaluated).toMatchObject({ evaluator: "grader:independent", benchmarkDigest: benchmarkDigests(bench).benchmark });
  });
  test("a second run does not duplicate the proposal or redo work (dedupe)", async () => {
    const run = await asRole("factory_supervisor", (tx) => superviseOnce(deps(tx)));
    expect(run.proposals.map((p) => p.created)).toEqual([false]);
    expect(run.skipped.join(" ")).toMatch(/already awaiting_approval/);
    expect((await listProposals(db.sql, org)).length).toBe(1);
  });
  test("a non-improving candidate is rejected and its evidence (comparison + ledger) is preserved", async () => {
    // new intent on same version so a fresh proposal is created
    for (let i = 0; i < 4; i++) await recordSignal(db.sql, { organizationId: org, kind: "user_correction", targetVersionId: v1.versionId, intent: "prd tone too casual", optedIn: true, anonymized: true, evidence: `tone-${i}` });
    const before = Number((await db.sql`SELECT count(*) AS n FROM eval_comparisons`)[0]!.n);
    const run = await asRole("factory_supervisor", (tx) => superviseOnce(deps(tx, { improves: false })));
    expect(run.skipped.join(" ")).toMatch(/rejected \((failed|insufficient_evidence)\)/);
    const rejected = (await listProposals(db.sql, org)).find((p) => p.state === "rejected")!;
    expect(rejected.comparisonId).not.toBeNull();
    expect(Number((await db.sql`SELECT count(*) AS n FROM eval_comparisons`)[0]!.n)).toBe(before + 1);
    expect((await ledgerFor(db.sql, rejected.id)).map((l) => l.event)).toContain("evaluated");
    await expect(db.sql`DELETE FROM improvement_proposals WHERE id = ${rejected.id}`).rejects.toThrow(/never deleted/);
  });
});

describe("the supervisor cannot approve, install, change scope, edit tests or enable paid inference (T-22) — enforced by its DB role", () => {
  test("denied: approvals, decisions, versions, activation, registry log, policies, benchmarks, comparisons, qualifications, users, secrets/integrations, merge intents", async () => {
    const d = (s: string) => denied("factory_supervisor", s);
    const any = "'00000000-0000-0000-0000-000000000000'";
    expect(await d(`INSERT INTO approval_decisions (request_id, decision, decided_by, presented_digest, presented_permission_digest) VALUES (${any}, 'approved', ${any}, 'x', 'x')`)).toBe("denied");
    expect(await d(`INSERT INTO approval_requests (organization_id, version_id, operation, target_digest, permission_digest, policy_digest, evidence_digest, requested_by, idempotency_key, expires_at) VALUES (${any}, ${any}, 'activate', 'x','x','x','x', ${any}, 'k', now())`)).toBe("denied");
    expect(await d(`INSERT INTO skill_versions (organization_id, kind, slug, version, digest, permission_digest, manifest, origin, file_manifest, created_by) VALUES (${any}, 'skill', 'abc', '1', 'x','x','{}','{}','[]', ${any})`)).toBe("denied");
    expect(await d(`UPDATE skill_versions SET state = 'approved'`)).toBe("denied");
    expect(await d(`UPDATE registry_active SET active_version_id = NULL`)).toBe("denied");
    expect(await d(`INSERT INTO registry_active (organization_id, kind, slug) VALUES (${any}, 'skill', 'abc')`)).toBe("denied");
    expect(await d(`INSERT INTO registry_log (organization_id, workspace_id, kind, slug, operation, revision, actor, idempotency_key) VALUES (${any}, 'default', 'skill', 'a', 'activate', 1, 'x', 'k')`)).toBe("denied");
    expect(await d(`INSERT INTO rollback_policies (organization_id, version_id, metric, comparator, threshold, min_samples, action, approved_by, created_by) VALUES (${any}, ${any}, 'm', 'lt', 1, 1, 'disable', ${any}, ${any})`)).toBe("denied");
    expect(await d(`INSERT INTO benchmarks (organization_id, name, version, role, digest, holdout_digest, grader_digest, min_samples, created_by) VALUES (${any}, 'n', '1', 'r', 'x','x','x', 1, ${any})`)).toBe("denied");
    expect(await d(`UPDATE benchmarks SET min_samples = 1`)).toBe("denied");
    expect(await d(`INSERT INTO eval_comparisons (organization_id, benchmark_id, candidate_digest, baseline_digest, benchmark_digest, policy_digest, status, report, evaluator) VALUES (${any}, ${any}, 'a','b','c','d','passed','{}','x')`)).toBe("denied");
    expect(await d(`INSERT INTO capability_qualifications (organization_id, version_id, role, runtime, comparison_id, score, sample_size, approved_by, expires_at) VALUES (${any}, ${any}, 'r', 'local_model', ${any}, 1, 1, ${any}, now())`)).toBe("denied");
    expect(await d(`INSERT INTO users (organization_id, auth_subject, role) VALUES (${any}, 's', 'admin')`)).toBe("denied");
    expect(await d(`UPDATE users SET role = 'admin'`)).toBe("denied");
    expect(await d(`SELECT credentials_ref FROM integrations`)).toBe("denied");
    expect(await d(`INSERT INTO merge_intents (job_id) VALUES (${any})`)).toBe("denied");
    expect(await d(`UPDATE auto_merge_global SET kill_switch = false`)).toBe("denied");
    expect(await d(`DELETE FROM improvement_signals`)).toBe("denied");
  });
  test("it can read what it needs, and write only signals, proposals (non-authority states) and the ledger", async () => {
    const ok = async (s: string) => { try { await asRole("factory_supervisor", (tx) => tx.unsafe(s)); return "ok"; } catch (e) { return String(e).slice(0, 100); } };
    expect(await ok("SELECT count(*) FROM skill_versions")).toBe("ok"); expect(await ok("SELECT count(*) FROM improvement_proposals")).toBe("ok"); expect(await ok("SELECT count(*) FROM eval_comparisons")).toBe("ok");
  });
  test("the proposal state machine refuses the supervisor identity any authority-bearing state — even via a legal edge", async () => {
    const p = (await listProposals(db.sql, org)).find((x) => x.state === "awaiting_approval")!;
    for (const to of ["approved", "monitoring", "accepted"] as const) await expect(asRole("factory_supervisor", (tx) => advance(tx, p.id, to))).rejects.toThrow(/supervisor identity cannot approve|illegal proposal transition/);
    await expect(asRole("factory_supervisor", (tx) => tx.unsafe(`UPDATE improvement_proposals SET problem = 'edited' WHERE id = '${p.id}'`))).rejects.toThrow(/immutable/);
    await expect(asRole("factory_supervisor", (tx) => tx.unsafe(`UPDATE improvement_proposals SET state = 'awaiting_approval', comparison_id = NULL WHERE id = '${p.id}'`))).resolves.toBeDefined(); // no state change: harmless no-op
    expect((await getProposal(db.sql, p.id)).state).toBe("awaiting_approval");
  });
  test("its code has no network or model-inference surface: no fetch, SDK, CLI spawn or provider host in the supervisor sources", () => {
    const dir = join(import.meta.dir, "../src");
    for (const f of readdirSync(dir)) { const src = readFileSync(join(dir, f), "utf8"); expect(src, f).not.toMatch(/\bfetch\(|child_process|Bun\.spawn|spawnSync|anthropic|openai|api[_-]?key/i); }
  });
});

describe("independent human approval promotes the exact digest atomically; post-release regression only DISABLES via a pre-approved policy", () => {
  let v2 = { versionId: "", digest: "" }; let policyId = "";
  test("the control plane submits the evaluated candidate, an independent approver approves the exact digest, activation is atomic", async () => {
    const p = (await listProposals(db.sql, org)).find((x) => x.state === "awaiting_approval")!;
    const pkg = ((await ledgerFor(db.sql, p.id)).find((l) => l.event === "approval_package")!.detail as { package: { candidateDigest: string } }).package;
    // the candidate bytes: regenerate from the same bounded change to obtain the identical tree (content addressing)
    const cand = generateCandidate({ approvedDir: v1dir, scratchBase: mkdtempSync(join(base, "scratch-")), change: CHANGE, policy: POLICY });
    expect(cand.candidateDigest).toBe(pkg.candidateDigest); expect(treeDigest(cand.files)).toBe(p.candidateDigest as string);
    const sub = await submitCandidate(db.sql, { organizationId: org, kind: "skill", manifest: cand.report.manifest!, files: cand.files, createdBy: author, signed: signer.sign(cand.report), reportPublicKeyPem: signer.publicKeyPem, policyDigest: PD });
    v2 = { versionId: sub.versionId, digest: cand.candidateDigest };
    const req = await requestApproval(db.sql, { organizationId: org, versionId: sub.versionId, operation: "upgrade", requestedBy: requester, idempotencyKey: "sup-v2-req", policyDigest: PD });
    expect(req.targetDigest).toBe(pkg.candidateDigest);
    await expect(asRole("factory_supervisor", (tx) => decideApproval(tx, { requestId: req.requestId, approverId: approver, decision: "approved", presentedDigest: req.targetDigest, presentedPermissionDigest: req.permissionDigest }))).rejects.toThrow(/denied/);
    await decideApproval(db.sql, { requestId: req.requestId, approverId: approver2, decision: "approved", presentedDigest: req.targetDigest, presentedPermissionDigest: req.permissionDigest });
    const rev = await revisionOf(db.sql, { organizationId: org, kind: "skill", slug: "prd-writer" });
    const res = await activate(db.sql, { organizationId: org, requestId: req.requestId, expectedRevision: rev, actor: "approver2", idempotencyKey: "sup-v2-act", policyDigest: PD });
    expect(res.revision).toBe(rev + 1);
    expect(await getActive(db.sql, { organizationId: org, kind: "skill", slug: "prd-writer" })).toMatchObject({ digest: v2.digest });
    await advance(db.sql, p.id, "approved"); await advance(db.sql, p.id, "monitoring");
  });
  test("humans pre-approve a deterministic rollback policy (creator != approver); the supervisor cannot create one", async () => {
    await expect(db.sql`INSERT INTO rollback_policies (organization_id, version_id, metric, comparator, threshold, min_samples, action, approved_by, created_by) VALUES (${org}, ${v2.versionId}, 'prd_quality', 'lt', 0.8, 10, 'disable', ${approver}, ${approver})`).rejects.toThrow();
    policyId = (await db.sql`INSERT INTO rollback_policies (organization_id, version_id, metric, comparator, threshold, min_samples, action, approved_by, created_by) VALUES (${org}, ${v2.versionId}, 'prd_quality', 'lt', 0.8, 10, 'disable', ${approver}, ${requester}) RETURNING id`)[0]!.id;
    expect(await denied("factory_supervisor", `INSERT INTO rollback_policies (organization_id, version_id, metric, comparator, threshold, min_samples, action, approved_by, created_by) VALUES ('${org}', '${v2.versionId}', 'm', 'lt', 99, 1, 'disable', '${approver}', '${requester}')`)).toBe("denied");
  });
  test("no action when the threshold is not breached or samples are too few", async () => {
    const r = await asRole("factory_supervisor", (tx) => monitorOnce({ sql: tx, organizationId: org }, [{ policyId, metric: "prd_quality", value: 0.9, samples: 50 }]));
    expect(r[0]).toMatchObject({ action: "none" }); expect(r[0]!.reason).toMatch(/not breached/);
  });
  test("too few samples does nothing", async () => {
    const r = await asRole("factory_supervisor", (tx) => monitorOnce({ sql: tx, organizationId: org }, [{ policyId, metric: "prd_quality", value: 0.1, samples: 3 }]));
    expect(r[0]).toMatchObject({ action: "none" }); expect(r[0]!.reason).toMatch(/not enough samples/);
    expect(await getActive(db.sql, { organizationId: org, kind: "skill", slug: "prd-writer" })).not.toBeNull();
  });
  test("a detected post-release regression disables the version via the approved policy; no new version is enabled; audit is preserved", async () => {
    const versionsBefore = Number((await db.sql`SELECT count(*) AS n FROM skill_versions WHERE state = 'approved'`)[0]!.n);
    const r = await asRole("factory_supervisor", (tx) => monitorOnce({ sql: tx, organizationId: org }, [{ policyId, metric: "prd_quality", value: 0.55, samples: 14 }]));
    expect(r[0]).toMatchObject({ action: "disabled" });
    expect(await getActive(db.sql, { organizationId: org, kind: "skill", slug: "prd-writer" })).toBeNull(); // OFF, and nothing else took its place
    const [act] = await db.sql`SELECT active_version_id, disabled_reason FROM registry_active WHERE slug = 'prd-writer'`;
    expect(act!.active_version_id).toBeNull(); expect(act!.disabled_reason).toContain(policyId);
    expect(Number((await db.sql`SELECT count(*) AS n FROM skill_versions WHERE state = 'approved'`)[0]!.n)).toBe(versionsBefore); // no version enabled/approved
    const [log] = await db.sql`SELECT operation, actor, reason FROM registry_log ORDER BY id DESC LIMIT 1`;
    expect(log).toMatchObject({ operation: "policy_disable", actor: "supervisor" }); expect(log!.reason).toMatch(/prd_quality=0\.55 over 14 samples/);
    const p = (await listProposals(db.sql, org)).find((x) => x.candidateDigest === v2.digest)!; expect(p.state).toBe("rolled_back");
    expect((await ledgerFor(db.sql, p.id)).map((l) => l.event)).toContain("policy_disable");
    // the supervisor still cannot turn it back on
    expect(await denied("factory_supervisor", `UPDATE registry_active SET active_version_id = '${v2.versionId}' WHERE slug = 'prd-writer'`)).toBe("denied");
    const again = await asRole("factory_supervisor", (tx) => monitorOnce({ sql: tx, organizationId: org }, [{ policyId, metric: "prd_quality", value: 0.55, samples: 14 }]));
    expect(again[0]).toMatchObject({ action: "disabled" }); // exact same observation replays idempotently (same key) ...
    const other = await asRole("factory_supervisor", (tx) => monitorOnce({ sql: tx, organizationId: org }, [{ policyId, metric: "prd_quality", value: 0.2, samples: 99 }]));
    expect(other[0]).toMatchObject({ action: "none" }); expect(other[0]!.reason).toMatch(/not the active version/); // ... and a new observation cannot act on an already-disabled version
  });
});
