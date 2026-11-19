import { afterAll, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readEvents } from "@factory/db";
import { loadPolicy, policyDigest as digestOfPolicy, type PolicyConfig } from "@factory/domain";
import { buildContextManifest, createIntakeHandler, registerIntakeSchema } from "@factory/intake";
import {
  agentTaskExecutor, builderTaskExecutor, composeExecutors, currentEvidenceBinding, FileArtifactStore, loadJobSnapshot, type AutoMergeController, mockPorts, Orchestrator, recordDecision, type BuilderRuntime,
} from "@factory/orchestrator";
import { enrollWorker, runOnce, type RunnerConfig } from "@factory/runner";
import { MockAdapter, SchemaRegistry, type AgentRunRequest } from "@factory/runtimes";
import { detectBackend } from "@factory/sandboxes";
import { candidateScm, createGitScmPort, GitHubClient, InstallationTokenProvider, MergeCoordinator } from "@factory/scm";
import { createTestDb } from "../../db/src/testing";
import { FakeGitHub } from "../../scm/tests/fake-github";
import { createReviewPort, createSpecHandler, evaluateJobPolicy, registerSpecSchemas, type Design, type Requirements, type Spec } from "../src/index";

const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
export const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...GIT_ENV, HOME: mkdtempSync(join(tmpdir(), "gh-")) } }).trim();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
export const { policy, digest: POLICY_DIGEST } = loadPolicy(join(import.meta.dir, "../../../config"));

export let db: Awaited<ReturnType<typeof createTestDb>>;
export let fake: FakeGitHub;
export let org = ""; export let repo = ""; export let remote = ""; export let baseSha = ""; let n = 0;
export const U: Record<string, string> = {};
export const store = new FileArtifactStore(mkdtempSync(join(tmpdir(), "cas-")));
export const wsRoot = mkdtempSync(join(tmpdir(), "mrj-ws-"));
export const schemas = registerSpecSchemas(registerIntakeSchema(new SchemaRegistry()));
export const cfg = (): RunnerConfig => ({ sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" }, heartbeatMs: 1000 });
export const requirements = (): Requirements => ({ acceptance_criteria: [{ id: "AC-1", text: "x", observable: "y" }], assumptions: [], out_of_scope: [] });
export const design = (files: string[]): Design => ({ approach: "a", files_affected: files.map((path) => ({ path, change: "modify" as const })), threat_notes: [], risks: [] });
export const spec = (files: string[]): Spec => ({ tasks: [{ id: "T-1", title: "t", files, covers: ["AC-1"], checks: ["C-1"] }], checks: [{ id: "C-1", description: "d", covers: ["AC-1"], runs: { gate_step: "unit" } }], test_strategy: "" });

export function registerHooks(): void {
beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  for (const [name, role] of [["requester", "editor"], ["approver1", "approver"], ["approver2", "approver"], ["approver3", "approver"]] as const)
    U[name] = (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${name}, ${role}) RETURNING id`)[0]!.id;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', '42', 'o', 'r') RETURNING id`)[0]!.id;
  const root = mkdtempSync(join(tmpdir(), "mrj-remote-"));
  remote = join(root, "remote.git"); const seed = join(root, "seed");
  mkdirSync(seed); sh(root, "init", "--bare", "-b", "main", remote); sh(seed, "init", "-b", "main");
  for (const [p, c] of Object.entries({ "src/search.ts": "v1\n", "package.json": "{}\n", "docs/guide.md": "guide\n", ".github/workflows/ci.yml": "name: ci\n" })) { mkdirSync(dirname(join(seed, p)), { recursive: true }); writeFileSync(join(seed, p), c); }
  sh(seed, "add", "."); sh(seed, "commit", "-m", "base"); sh(seed, "push", remote, "main");
  baseSha = sh(seed, "rev-parse", "HEAD");
  fake = new FakeGitHub(publicKey).start();
});
afterAll(async () => { fake.stop(); await db.drop(); });
}

export const github = () => new GitHubClient({ apiBase: fake.url, sleep: async () => undefined, tokens: new InstallationTokenProvider({ apiBase: fake.url, appId: "1", privateKeyPem: privateKey, installationId: "9" }) });
export const repoFor = async () => ({ repo: { owner: "o", name: "r" }, baseBranch: "main", requiredChecks: [] as string[] });

export interface CoordOpts { gateOk?: boolean; review?: ReturnType<typeof createReviewPort>; policyDigest?: string; now?: () => number; requiredChecks?: string[] }
export interface Env { jobId: string; orch: Orchestrator; reviewPort: ReturnType<typeof createReviewPort>; coordinator: (o?: CoordOpts) => MergeCoordinator; requiredChecks: string[] }

/** Runs the whole pipeline to AWAITING_HUMAN against the fake GitHub (real draft PR creation). */
export async function prepare(o: { files?: string[]; script?: string; creator?: string; description?: string; policy?: PolicyConfig; auto?: AutoMergeController; hold?: boolean; stopAt?: string } = {}): Promise<{ jobId: string; head: string; base: string; version: number; state: string; env: Env }> {
  fake.refs.set("main", baseSha);
  fake.mergeCalls = 0;
  fake.mergeFault = undefined;
  fake.protectBase = false;
  const files = o.files ?? ["src/search.ts"];
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 'Search', ${o.description ?? "Users can search the job list by free text and the page updates without a reload."}) RETURNING id`;
  const jobId = (await db.sql`INSERT INTO jobs (request_id, repository_id, created_by) VALUES (${req!.id}, ${repo}, ${(o.creator ?? U.requester) as string}) RETURNING id`)[0]!.id as string;
  if (o.hold && o.auto) await o.auto.holdJob("op", org, jobId, "operator hold");
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
  const usedPolicy = o.policy ?? policy;
  const polDeps = { sql: db.sql, store, policy: usedPolicy, policyDigest: o.policy ? digestOfPolicy(o.policy) : POLICY_DIGEST, review: reviewPort, ...(o.auto ? { autoMerge: o.auto } : {}) };
  const coordinator = (over: CoordOpts = {}) => new MergeCoordinator({
    sql: db.sql, github: gh, repoFor: async () => ({ ...(await repoFor()), requiredChecks: over.requiredChecks ?? [] }),
    snapshot: (q, id) => loadJobSnapshot(q, over.review ?? reviewPort, id), currentBinding: (id) => currentEvidenceBinding(db.sql, over.review ?? reviewPort, id),
    freshDecision: (j) => evaluateJobPolicy({ ...polDeps, ...(over.policyDigest ? { policyDigest: over.policyDigest } : {}), review: over.review ?? reviewPort }, j, j.headSha),
    ...(o.auto ? { onAutoMergeFailure: async (j: { repositoryId: string; detail: string }) => o.auto?.trip(j.repositoryId, `post-merge failure: ${j.detail}`) } : {}),
    verifyGate: async () => ((over.gateOk ?? true) ? { ok: true, reasons: [] } : { ok: false, reasons: ["signature-invalid"] }),
    ...(over.now ? { now: over.now } : {}),
  });
  const orch = new Orchestrator({
    sql: db.sql, ports: { ...base, review: reviewPort, policy: { evaluate: async (j, h) => { const d = await evaluateJobPolicy(polDeps, j, h); return { risk: d.risk, eligible: d.autoMergeEligible, reasons: [...d.reasons, ...d.blockers.map((b) => `blocker: ${b}`)], policyDigest: d.policyDigest }; } }, scm: { ...scmPort, prepare: async () => ({ baseSha }), commitCandidate: candidateScm(db.sql).commitCandidate } },
    intake: createIntakeHandler({ sql: db.sql, store }), spec: createSpecHandler({ sql: db.sql, store }), merge: coordinator(),
    ...(o.stopAt ? { fault: (p: string) => { if (p === o.stopAt) throw new Error("__stop__"); } } : {}),
  });
  const w = await enrollWorker(cfg());
  const exec = composeExecutors(agent, build);
  for (let i = 0; i < 300; i++) {
    let t;
    try { t = await orch.tick(jobId); } catch (e) { if (String(e).includes("__stop__")) break; throw e; }
    if (t.action === "awaiting-human" || ["MERGED", "POSTMERGE_MONITOR", "DONE"].includes(t.state)) break;
    if (["terminal", "awaiting-info"].includes(t.action)) throw new Error(`pipeline stopped: ${JSON.stringify(t)}`);
    if (t.action === "enqueued" || t.action === "waiting") await runOnce(cfg(), w, exec);
  }
  const [j] = await db.sql`SELECT head_sha, base_sha, version, pr_number, state FROM jobs WHERE id=${jobId}`;
  return { jobId, head: j!.head_sha, base: j!.base_sha, version: j!.version, state: j!.state as string, env: { jobId, orch, reviewPort, coordinator, requiredChecks: [] } };
}
export const approve = async (p: Awaited<ReturnType<typeof prepare>>, who: string, over: Partial<Parameters<typeof recordDecision>[2]> = {}) => {
  const [j] = await db.sql`SELECT version, policy_digest FROM jobs WHERE id=${p.jobId}`;
  return recordDecision(db.sql, p.env.reviewPort, { jobId: p.jobId, orgId: org, actorId: U[who] as string, idempotencyKey: crypto.randomUUID(), decision: "approve", headSha: p.head, baseSha: p.base, policyDigest: j!.policy_digest, expectedVersion: j!.version, ...over });
};
export const state = async (id: string) => (await db.sql`SELECT state FROM jobs WHERE id=${id}`)[0]!.state as string;
export const intents = async (id: string) => (await db.sql`SELECT status, github_merge_sha FROM merge_intents WHERE job_id=${id}`).map((r) => ({ status: r.status as string, github_merge_sha: r.github_merge_sha as string | null }));
export const countEvents = async (id: string, type: string) => (await readEvents(db.sql, id, 0, 1000)).filter((e) => e.type === type).length;
export const tickUntil = async (p: Awaited<ReturnType<typeof prepare>>, pred: (t: { state: string; action: string }) => boolean) => { let t = await p.env.orch.tick(p.jobId); for (let i = 0; i < 6 && !pred(t); i++) t = await p.env.orch.tick(p.jobId); return t; };

