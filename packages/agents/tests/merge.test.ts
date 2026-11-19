import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readEvents } from "@factory/db";
import { loadPolicy } from "@factory/domain";
import { buildContextManifest, createIntakeHandler, registerIntakeSchema } from "@factory/intake";
import {
  agentTaskExecutor, builderTaskExecutor, composeExecutors, currentEvidenceBinding, DecisionRejected, FileArtifactStore, loadJobSnapshot, mockPorts, Orchestrator, recordDecision, type BuilderRuntime,
} from "@factory/orchestrator";
import { enrollWorker, runOnce, type RunnerConfig } from "@factory/runner";
import { MockAdapter, SchemaRegistry, type AgentRunRequest } from "@factory/runtimes";
import { detectBackend } from "@factory/sandboxes";
import { candidateScm, createGitScmPort, GitHubClient, InstallationTokenProvider, MergeCoordinator, ROLE_PERMISSIONS } from "@factory/scm";
import { createTestDb } from "../../db/src/testing";
import { FakeGitHub } from "../../scm/tests/fake-github";
import { createReviewPort, createSpecHandler, evaluateJobPolicy, registerSpecSchemas, type Design, type Requirements, type Spec } from "../src/index";

const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...GIT_ENV, HOME: mkdtempSync(join(tmpdir(), "gh-")) } }).trim();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const { policy, digest: POLICY_DIGEST } = loadPolicy(join(import.meta.dir, "../../../config"));

let db: Awaited<ReturnType<typeof createTestDb>>;
let fake: FakeGitHub;
let org = ""; let repo = ""; let remote = ""; let baseSha = ""; let n = 0;
const U: Record<string, string> = {};
const store = new FileArtifactStore(mkdtempSync(join(tmpdir(), "cas-")));
const wsRoot = mkdtempSync(join(tmpdir(), "mrj-ws-"));
const schemas = registerSpecSchemas(registerIntakeSchema(new SchemaRegistry()));
const cfg = (): RunnerConfig => ({ sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" }, heartbeatMs: 1000 });
const requirements = (): Requirements => ({ acceptance_criteria: [{ id: "AC-1", text: "x", observable: "y" }], assumptions: [], out_of_scope: [] });
const design = (files: string[]): Design => ({ approach: "a", files_affected: files.map((path) => ({ path, change: "modify" as const })), threat_notes: [], risks: [] });
const spec = (files: string[]): Spec => ({ tasks: [{ id: "T-1", title: "t", files, covers: ["AC-1"], checks: ["C-1"] }], checks: [{ id: "C-1", description: "d", covers: ["AC-1"], runs: { gate_step: "unit" } }], test_strategy: "" });

beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  for (const [name, role] of [["requester", "editor"], ["approver1", "approver"], ["approver2", "approver"], ["approver3", "approver"]] as const)
    U[name] = (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${name}, ${role}) RETURNING id`)[0]!.id;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', '42', 'o', 'r') RETURNING id`)[0]!.id;
  const root = mkdtempSync(join(tmpdir(), "mrj-remote-"));
  remote = join(root, "remote.git"); const seed = join(root, "seed");
  mkdirSync(seed); sh(root, "init", "--bare", "-b", "main", remote); sh(seed, "init", "-b", "main");
  for (const [p, c] of Object.entries({ "src/search.ts": "v1\n", "package.json": "{}\n", ".github/workflows/ci.yml": "name: ci\n" })) { mkdirSync(dirname(join(seed, p)), { recursive: true }); writeFileSync(join(seed, p), c); }
  sh(seed, "add", "."); sh(seed, "commit", "-m", "base"); sh(seed, "push", remote, "main");
  baseSha = sh(seed, "rev-parse", "HEAD");
  fake = new FakeGitHub(publicKey).start();
});
afterAll(async () => { fake.stop(); await db.drop(); });

const github = () => new GitHubClient({ apiBase: fake.url, sleep: async () => undefined, tokens: new InstallationTokenProvider({ apiBase: fake.url, appId: "1", privateKeyPem: privateKey, installationId: "9" }) });
const repoFor = async () => ({ repo: { owner: "o", name: "r" }, baseBranch: "main", requiredChecks: [] as string[] });

interface CoordOpts { gateOk?: boolean; review?: ReturnType<typeof createReviewPort>; policyDigest?: string; now?: () => number; requiredChecks?: string[] }
interface Env { jobId: string; orch: Orchestrator; reviewPort: ReturnType<typeof createReviewPort>; coordinator: (o?: CoordOpts) => MergeCoordinator; requiredChecks: string[] }

/** Runs the whole pipeline to AWAITING_HUMAN against the fake GitHub (real draft PR creation). */
async function prepare(o: { files?: string[]; script?: string; creator?: string } = {}): Promise<{ jobId: string; head: string; base: string; version: number; env: Env }> {
  fake.refs.set("main", baseSha);
  fake.mergeCalls = 0;
  fake.mergeFault = undefined;
  fake.protectBase = false;
  const files = o.files ?? ["src/search.ts"];
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 'Search', 'Users can search the job list by free text and the page updates without a reload.') RETURNING id`;
  const jobId = (await db.sql`INSERT INTO jobs (request_id, repository_id, created_by) VALUES (${req!.id}, ${repo}, ${(o.creator ?? U.requester) as string}) RETURNING id`)[0]!.id as string;
  const out = (r: AgentRunRequest): unknown => {
    if (r.role.startsWith("review_")) return { reviewerRole: r.role.replace("review_", ""), candidateSha: r.candidateSha, verdict: "pass", findings: [] };
    switch (r.role) {
      case "intake": return { decision: "accept", summary: "ok", risk_hint: "LOW", acceptance_criteria: [{ id: "AC-1", text: "x" }] };
      case "analyst": return requirements();
      case "architect": return design(files);
      case "spec": return spec(files);
      default: return { artifactUri: `mock://${r.role}`, summary: "ok" };
    }
  };
  const adapter = new MockAdapter({ output: out, schemas });
  const agent = agentTaskExecutor({ sql: db.sql, adapter, store, modelFor: () => "m", contextUri: (j, r) => buildContextManifest(db.sql, store, j, r) });
  const runtime: BuilderRuntime = { async edit(ctx, i) { if (i.role === "tester") return { ok: true }; const r = await ctx.run("/bin/sh", ["-c", o.script ?? `printf 'changed\\n' > src/search.ts`]); return { ok: r.exitCode === 0 }; } };
  const build = builderTaskExecutor({ sql: db.sql, store, runtime, remoteFor: async () => ({ url: remote, allowLocalRemote: true }) });
  const reviewPort = createReviewPort({ sql: db.sql, store, adapter, modelFor: () => "m-rev" });
  const gh = github();
  const scmPort = createGitScmPort({ sql: db.sql, github: gh, repoFor: async () => ({ repo: { owner: "o", name: "r" }, baseBranch: "main" }) });
  const base = mockPorts();
  const polDeps = { sql: db.sql, store, policy, policyDigest: POLICY_DIGEST, review: reviewPort };
  const coordinator = (over: CoordOpts = {}) => new MergeCoordinator({
    sql: db.sql, github: gh, repoFor: async () => ({ ...(await repoFor()), requiredChecks: over.requiredChecks ?? [] }),
    snapshot: (q, id) => loadJobSnapshot(q, over.review ?? reviewPort, id), currentBinding: (id) => currentEvidenceBinding(db.sql, over.review ?? reviewPort, id),
    freshDecision: (j) => evaluateJobPolicy({ ...polDeps, ...(over.policyDigest ? { policyDigest: over.policyDigest } : {}), review: over.review ?? reviewPort }, j, j.headSha),
    verifyGate: async () => ((over.gateOk ?? true) ? { ok: true, reasons: [] } : { ok: false, reasons: ["signature-invalid"] }),
    ...(over.now ? { now: over.now } : {}),
  });
  const orch = new Orchestrator({
    sql: db.sql, ports: { ...base, review: reviewPort, policy: { evaluate: async (j, h) => { const d = await evaluateJobPolicy(polDeps, j, h); return { risk: d.risk, eligible: d.autoMergeEligible, reasons: d.reasons, policyDigest: d.policyDigest }; } }, scm: { ...scmPort, prepare: async () => ({ baseSha }), commitCandidate: candidateScm(db.sql).commitCandidate } },
    intake: createIntakeHandler({ sql: db.sql, store }), spec: createSpecHandler({ sql: db.sql, store }), merge: coordinator(),
  });
  const w = await enrollWorker(cfg());
  const exec = composeExecutors(agent, build);
  for (let i = 0; i < 300; i++) {
    const t = await orch.tick(jobId);
    if (t.action === "awaiting-human") break;
    if (["terminal", "awaiting-info"].includes(t.action)) throw new Error(`pipeline stopped: ${JSON.stringify(t)}`);
    if (t.action === "enqueued" || t.action === "waiting") await runOnce(cfg(), w, exec);
  }
  const [j] = await db.sql`SELECT head_sha, base_sha, version, pr_number FROM jobs WHERE id=${jobId}`;
  return { jobId, head: j!.head_sha, base: j!.base_sha, version: j!.version, env: { jobId, orch, reviewPort, coordinator, requiredChecks: [] } };
}
const approve = async (p: Awaited<ReturnType<typeof prepare>>, who: string, over: Partial<Parameters<typeof recordDecision>[2]> = {}) => {
  const [j] = await db.sql`SELECT version, policy_digest FROM jobs WHERE id=${p.jobId}`;
  return recordDecision(db.sql, p.env.reviewPort, { jobId: p.jobId, orgId: org, actorId: U[who] as string, idempotencyKey: crypto.randomUUID(), decision: "approve", headSha: p.head, baseSha: p.base, policyDigest: j!.policy_digest, expectedVersion: j!.version, ...over });
};
const state = async (id: string) => (await db.sql`SELECT state FROM jobs WHERE id=${id}`)[0]!.state as string;
const intents = async (id: string) => (await db.sql`SELECT status, github_merge_sha FROM merge_intents WHERE job_id=${id}`).map((r) => ({ status: r.status as string, github_merge_sha: r.github_merge_sha as string | null }));
const countEvents = async (id: string, type: string) => (await readEvents(db.sql, id, 0, 1000)).filter((e) => e.type === type).length;
const tickUntil = async (p: Awaited<ReturnType<typeof prepare>>, pred: (t: { state: string; action: string }) => boolean) => { let t = await p.env.orch.tick(p.jobId); for (let i = 0; i < 6 && !pred(t); i++) t = await p.env.orch.tick(p.jobId); return t; };

describe("approvals are decision-scoped", () => {
  test("approval refuses evidence that no longer matches; records the full binding; does NOT merge", async () => {
    const p = await prepare();
    await expect(approve(p, "approver1", { headSha: "f".repeat(40) })).rejects.toMatchObject({ code: "stale-evidence" });
    await expect(approve(p, "approver1", { baseSha: "f".repeat(40) })).rejects.toMatchObject({ code: "stale-evidence" });
    await expect(approve(p, "approver1", { policyDigest: "sha256:" + "0".repeat(64) })).rejects.toMatchObject({ code: "stale-evidence" });
    await expect(approve(p, "approver1", { expectedVersion: p.version + 3 })).rejects.toMatchObject({ code: "version-conflict" });
    expect((await db.sql`SELECT count(*)::int AS c FROM approvals WHERE job_id=${p.jobId}`)[0]!.c).toBe(0); // refused approvals are never stored
    const r = await approve(p, "approver1");
    expect(r).toMatchObject({ state: "PREMERGE", replayed: false });
    const [a] = await db.sql`SELECT head_sha, base_sha, policy_digest, binding, decision FROM approvals WHERE job_id=${p.jobId}`;
    expect(a).toMatchObject({ head_sha: p.head, base_sha: p.base, decision: "approve" });
    expect(Object.keys(a!.binding as object).sort()).toEqual(["artifactDigest", "baseSha", "gateConfigDigest", "headSha", "policyDigest", "policyVersion", "repoId", "reviewerSetDigest"]);
    expect(fake.mergeCalls).toBe(0);
    expect(await intents(p.jobId)).toHaveLength(0);
  });
  test("idempotent replay returns the same decision; a different body with the same key is refused; the requester cannot self-approve HIGH; reject/rework move the job", async () => {
    const p = await prepare({ files: ["package.json"], script: `printf '{"a":1}\\n' > package.json` });
    await expect(approve(p, "requester")).rejects.toMatchObject({ code: "self-approval" });
    const key = crypto.randomUUID();
    const a = await approve(p, "approver1", { idempotencyKey: key });
    const b = await approve(p, "approver1", { idempotencyKey: key, expectedVersion: p.version });
    expect(b).toMatchObject({ decisionId: a.decisionId, replayed: true });
    expect((await db.sql`SELECT count(*)::int AS c FROM approvals WHERE job_id=${p.jobId}`)[0]!.c).toBe(1);
    await expect(approve(p, "approver1", { idempotencyKey: key, decision: "reject", reason: "no" })).rejects.toMatchObject({ code: "idempotency-conflict" });
    const q = await prepare();
    await expect(approve(q, "approver1", { decision: "reject" })).rejects.toMatchObject({ code: "validation" });
    expect(await approve(q, "approver1", { decision: "reject", reason: "out of scope" })).toMatchObject({ state: "REJECTED" });
    const r = await prepare();
    expect(await approve(r, "approver1", { decision: "rework", reason: "please add error handling" })).toMatchObject({ state: "REWORK" });
    expect((await readEvents(db.sql, r.jobId, 0, 1000)).find((e) => e.type === "human.changes_requested")!.payload).toMatchObject({ message: "please add error handling" });
    await expect(approve(r, "approver1")).rejects.toMatchObject({ code: "not-awaiting-approval" });
  });
});

describe("merge coordinator: exact-head, fresh-evidence, exactly-once", () => {
  test("an approved candidate merges EXACTLY once: draft marked ready, merge bound to the head SHA with the merge-role credential, one merge logged", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    const t = await tickUntil(p, (x) => x.state === "MERGED");
    expect(t.state).toBe("MERGED");
    expect(await state(p.jobId)).toBe("POSTMERGE_MONITOR");
    expect(fake.mergeCalls).toBe(1);
    const prNo0 = (await db.sql`SELECT pr_number FROM jobs WHERE id=${p.jobId}`)[0]!.pr_number as number;
    const pr = fake.prs.find((x) => x.number === prNo0)!;
    expect(pr).toMatchObject({ merged: true, draft: false });
    expect(fake.refs.get("main")).toBe(pr.merge_commit_sha ?? undefined);
    expect(await intents(p.jobId)).toEqual([{ status: "merged", github_merge_sha: pr.merge_commit_sha }]);
    expect(await countEvents(p.jobId, "merge.completed")).toBe(1);
    const put = fake.log.filter((l) => l.method === "PUT").at(-1)!;
    expect(put.perms).toEqual(ROLE_PERMISSIONS.merge);
    expect(put.perms).not.toEqual(ROLE_PERMISSIONS.branch_write);
    // idempotent afterwards
    expect(await p.env.coordinator().merge(p.jobId)).toMatchObject({ status: "already-merged", mergeSha: pr.merge_commit_sha });
    for (let i = 0; i < 3; i++) await p.env.orch.tick(p.jobId);
    expect(fake.mergeCalls).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS c FROM job_transitions WHERE job_id=${p.jobId} AND to_state='MERGED'`)[0]!.c).toBe(1);
  });

  test("8 concurrent coordinators produce one merge call and one authoritative result", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    const before = fake.mergeCalls;
    const rs = await Promise.all(Array.from({ length: 8 }, () => p.env.coordinator().merge(p.jobId)));
    expect(fake.mergeCalls - before).toBe(1);
    expect(rs.filter((r) => r.status === "merged").length).toBeGreaterThanOrEqual(1);
    expect(await intents(p.jobId)).toHaveLength(1);
    expect(await countEvents(p.jobId, "merge.completed")).toBe(1);
    expect(["MERGED", "POSTMERGE_MONITOR"]).toContain(await state(p.jobId));
  });

  test("HEAD changed after approval (someone pushed to the factory branch): blocked and QUARANTINED, nothing merged", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    const prNo = (await db.sql`SELECT pr_number FROM jobs WHERE id=${p.jobId}`)[0]!.pr_number as number;
    fake.movePrHead(prNo, "c".repeat(40));
    const before = fake.mergeCalls;
    const t = await tickUntil(p, (x) => x.state === "QUARANTINED");
    expect(t.state).toBe("QUARANTINED");
    expect(fake.mergeCalls).toBe(before);
    expect(JSON.stringify((await readEvents(db.sql, p.jobId, 0, 1000)).find((e) => e.type === "merge.blocked")!.payload)).toContain("differs from the evaluated candidate");
    expect(await intents(p.jobId)).toHaveLength(0);
  });

  test("BASE moved after approval: blocked, returns to a human, nothing merged", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    fake.refs.set("main", "d".repeat(40));
    const before = fake.mergeCalls;
    const r = await p.env.coordinator().merge(p.jobId);
    expect(r).toMatchObject({ status: "blocked", next: "AWAITING_HUMAN" });
    expect((r as { blockers: string[] }).blockers.join(" ")).toMatch(/base branch moved/);
    expect(fake.mergeCalls).toBe(before);
    expect(await state(p.jobId)).toBe("PREMERGE");
    await p.env.orch.tick(p.jobId);
    expect(await state(p.jobId)).toBe("AWAITING_HUMAN");
  });

  test("POLICY change after approval blocks (fresh digest differs; stored job policy digest also invalidates the bound approval)", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    const r = await p.env.coordinator({ policyDigest: "sha256:" + "7".repeat(64) }).merge(p.jobId);
    expect(r).toMatchObject({ status: "blocked" });
    expect((r as { blockers: string[] }).blockers.join(" ")).toMatch(/policy changed/);
    expect(fake.mergeCalls).toBe(0);
    const q = await prepare();
    await approve(q, "approver1");
    await db.sql`UPDATE jobs SET policy_digest = ${"sha256:" + "8".repeat(64)} WHERE id=${q.jobId}`;
    const r2 = await q.env.coordinator().merge(q.jobId);
    expect(r2.status).toBe("blocked");
    expect((r2 as { blockers: string[] }).blockers.join(" ")).toMatch(/stale|policy changed/);
  });

  test("CHECKS: missing/failing required checks block; a running check waits; success merges", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    const coord = (checks: string[]) => p.env.coordinator({ requiredChecks: checks });
    const r1 = await coord(["ci"]).merge(p.jobId);
    expect((r1 as { blockers: string[] }).blockers.join(" ")).toMatch(/"ci" has not reported/);
    fake.checks.set(p.head, [{ name: "ci", status: "in_progress", conclusion: null }]);
    const r2 = await coord(["ci"]).merge(p.jobId);
    expect(r2).toMatchObject({ status: "blocked", next: "stay" });
    fake.checks.set(p.head, [{ name: "ci", status: "completed", conclusion: "failure" }]);
    const r3 = await coord(["ci"]).merge(p.jobId);
    expect(r3).toMatchObject({ status: "blocked", next: "AWAITING_HUMAN" });
    expect(fake.mergeCalls).toBe(0);
    fake.checks.set(p.head, [{ name: "ci", status: "completed", conclusion: "success" }]);
    expect((await coord(["ci"]).merge(p.jobId)).status).toBe("merged");
    expect(fake.mergeCalls).toBe(1);
  });

  test("gate evidence that cannot be verified, or a required review missing for the head, blocks", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    const r = await p.env.coordinator({ gateOk: false }).merge(p.jobId);
    expect((r as { blockers: string[] }).blockers.join(" ")).toMatch(/gate evidence not verifiable: signature-invalid/);
    const stricter = { ...p.env.reviewPort, requiredRoles: async () => ["code", "security"] } as typeof p.env.reviewPort;
    const r2 = await p.env.coordinator({ review: stricter }).merge(p.jobId);
    expect((r2 as { blockers: string[] }).blockers.join(" ")).toMatch(/required security review is missing|stale/);
    expect(fake.mergeCalls).toBe(0);
  });

  test("never merges without a human approval, even if the job is forced into PREMERGE; expired approvals do not count", async () => {
    const p = await prepare({ files: ["package.json"], script: `printf '{"b":2}\\n' > package.json` });
    await db.sql`UPDATE jobs SET state='PREMERGE', version=version+1 WHERE id=${p.jobId}`;
    const r = await p.env.coordinator().merge(p.jobId);
    expect((r as { blockers: string[] }).blockers.join(" ")).toMatch(/no human approval|HIGH changes can only be merged/);
    expect(fake.mergeCalls).toBe(0);
    const q = await prepare();
    await approve(q, "approver1");
    const late = await q.env.coordinator({ now: () => Date.now() + 241 * 60_000 }).merge(q.jobId);
    expect((late as { blockers: string[] }).blockers.join(" ")).toMatch(/stale or expired/);
  });

  test("CRITICAL needs two distinct approvers", async () => {
    const p = await prepare({ files: [".github/workflows/ci.yml"], script: `printf 'name: x\\n' > .github/workflows/ci.yml` });
    await approve(p, "approver1");
    const first = await p.env.coordinator().merge(p.jobId);
    expect((first as { blockers: string[] }).blockers.join(" ")).toMatch(/two distinct approvers/);
    await p.env.orch.tick(p.jobId);
    expect(await state(p.jobId)).toBe("AWAITING_HUMAN");
    await approve(p, "approver1"); // the same person again does not count twice
    expect((await p.env.coordinator().merge(p.jobId)).status).toBe("blocked");
    await p.env.orch.tick(p.jobId);
    await approve(p, "approver2");
    expect((await p.env.coordinator().merge(p.jobId)).status).toBe("merged");
    expect(fake.mergeCalls).toBeGreaterThanOrEqual(1);
  });

  test("GitHub REFUSES (branch protection): no bypass, no retry loop, intent aborted, job returns to a human", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    fake.protectBase = true;
    const before = fake.mergeCalls;
    const r = await p.env.coordinator().merge(p.jobId);
    fake.protectBase = false;
    expect(r).toMatchObject({ status: "blocked", next: "AWAITING_HUMAN" });
    expect(fake.mergeCalls - before).toBe(1);
    expect(await intents(p.jobId)).toEqual([{ status: "aborted", github_merge_sha: null }]);
    expect(await state(p.jobId)).toBe("PREMERGE");
    expect(fake.log.some((l) => /protection|rulesets/.test(l.path))).toBe(false); // branch protection untouched
  });

  test("GitHub times out AFTER merging: reconcile against the authoritative PR; one merge result, no second merge call", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    fake.mergeFault = "timeout-after-merge";
    const before = fake.mergeCalls;
    const r = await p.env.coordinator().merge(p.jobId);
    fake.mergeFault = undefined;
    expect(r).toMatchObject({ status: "merged", reconciled: true });
    expect(fake.mergeCalls - before).toBe(1);
    expect(await intents(p.jobId)).toHaveLength(1);
    expect(await countEvents(p.jobId, "merge.completed")).toBe(1);
    expect(await state(p.jobId)).toBe("POSTMERGE_MONITOR");
  });

  test("GitHub fails BEFORE merging (502): outcome pending, nothing recorded as merged; the retry merges once", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    fake.mergeFault = "error-before-merge";
    const before = fake.mergeCalls;
    const r = await p.env.coordinator().merge(p.jobId);
    expect(r.status).toBe("pending");
    expect(await state(p.jobId)).toBe("MERGING");
    expect((await intents(p.jobId))[0]!.status).toBe("pending");
    fake.mergeFault = undefined;
    const r2 = await p.env.coordinator().merge(p.jobId); // crash-recovery path: job is MERGING
    expect(r2.status).toBe("merged");
    expect(fake.mergeCalls - before).toBe(2);
    expect(await intents(p.jobId)).toHaveLength(1);
    expect(await countEvents(p.jobId, "merge.completed")).toBe(1);
  });

  test("a PR already merged on GitHub for the approved head is reconciled, never merged twice", async () => {
    const p = await prepare();
    await approve(p, "approver1");
    const prNo = (await db.sql`SELECT pr_number FROM jobs WHERE id=${p.jobId}`)[0]!.pr_number as number;
    fake.externalMerge(prNo);
    const before = fake.mergeCalls;
    const r = await p.env.coordinator().merge(p.jobId);
    expect(r).toMatchObject({ status: "merged", reconciled: true });
    expect(fake.mergeCalls).toBe(before);
  });

  test("post-merge health: healthy => DONE; failure => FAILED with an incident event and error code", async () => {
    const ok = await prepare(); await approve(ok, "approver1"); await tickUntil(ok, (x) => x.state === "MERGED");
    await ok.env.coordinator().recordPostmerge(ok.jobId, { ok: true, detail: "main CI green" });
    expect(await state(ok.jobId)).toBe("DONE");
    const bad = await prepare(); await approve(bad, "approver1"); await tickUntil(bad, (x) => x.state === "MERGED");
    await bad.env.coordinator().recordPostmerge(bad.jobId, { ok: false, detail: "main CI red after merge" });
    expect(await state(bad.jobId)).toBe("FAILED");
    expect((await db.sql`SELECT last_error_code FROM jobs WHERE id=${bad.jobId}`)[0]!.last_error_code).toBe("postmerge-failed");
    expect(await countEvents(bad.jobId, "postmerge.failed")).toBe(1);
    await expect(ok.env.coordinator().recordPostmerge(ok.jobId, { ok: true, detail: "again" })).rejects.toThrow();
  });

  test("the merge coordinator is the only writer of merges: no other code path calls the merge endpoint", () => {
    const writes = fake.log.filter((l) => l.method === "PUT");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => /\/pulls\/\d+\/merge$/.test(w.path) && JSON.stringify(w.perms) === JSON.stringify(ROLE_PERMISSIONS.merge))).toBe(true);
    void DecisionRejected;
  });
});
