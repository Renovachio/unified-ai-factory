import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readEvents } from "@factory/db";
import { loadPolicy } from "@factory/domain";
import { buildContextManifest, createIntakeHandler, registerIntakeSchema } from "@factory/intake";
import { agentTaskExecutor, builderTaskExecutor, composeExecutors, FileArtifactStore, mockPorts, Orchestrator, type BuilderRuntime } from "@factory/orchestrator";
import { enrollWorker, runOnce, type RunnerConfig } from "@factory/runner";
import { MockAdapter, SchemaRegistry, type AgentRunRequest } from "@factory/runtimes";
import { detectBackend } from "@factory/sandboxes";
import { candidateScm } from "@factory/scm";
import { createTestDb } from "../../db/src/testing";
import { createPolicyPort, createReviewPort, createSpecHandler, registerSpecSchemas, type Design, type Requirements, type Spec } from "../src/index";

const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...GIT_ENV, HOME: mkdtempSync(join(tmpdir(), "gh-")) } }).trim();
const { policy, digest: POLICY_DIGEST } = loadPolicy(join(import.meta.dir, "../../../config"));

let db: Awaited<ReturnType<typeof createTestDb>>;
let org = ""; let repo = ""; let remote = ""; let baseSha = ""; let n = 0;
const store = new FileArtifactStore(mkdtempSync(join(tmpdir(), "cas-")));
const wsRoot = mkdtempSync(join(tmpdir(), "pol-ws-"));
const schemas = registerSpecSchemas(registerIntakeSchema(new SchemaRegistry()));
const cfg = (): RunnerConfig => ({ sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" }, heartbeatMs: 1000 });

beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id;
  const root = mkdtempSync(join(tmpdir(), "pol-remote-"));
  remote = join(root, "remote.git"); const seed = join(root, "seed");
  mkdirSync(seed); sh(root, "init", "--bare", "-b", "main", remote); sh(seed, "init", "-b", "main");
  for (const [p, c] of Object.entries({ "README.md": "# d\n", "docs/a.md": "a\n", "src/search.ts": "v1\n", "package.json": "{}\n", ".github/workflows/ci.yml": "name: ci\n" })) { mkdirSync(dirname(join(seed, p)), { recursive: true }); writeFileSync(join(seed, p), c); }
  sh(seed, "add", "."); sh(seed, "commit", "-m", "base"); sh(seed, "push", remote, "main");
  baseSha = sh(seed, "rev-parse", "HEAD");
});
afterAll(async () => { await db.drop(); });

async function job(description: string) {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 'Change', ${description}) RETURNING id`;
  return (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repo}) RETURNING id`)[0]!.id as string;
}
const requirements = (): Requirements => ({ acceptance_criteria: [{ id: "AC-1", text: "x", observable: "y" }], assumptions: [], out_of_scope: [] });
const design = (files: string[]): Design => ({ approach: "a", files_affected: files.map((path) => ({ path, change: "modify" as const })), threat_notes: [], risks: [] });
const spec = (files: string[]): Spec => ({ tasks: [{ id: "T-1", title: "t", files, covers: ["AC-1"], checks: ["C-1"] }], checks: [{ id: "C-1", description: "d", covers: ["AC-1"], runs: { gate_step: "unit" } }], test_strategy: "" });

function rig(o: { files: string[]; script: string; intakeRisk?: string; policyOverride?: typeof policy }) {
  const out = (req: AgentRunRequest): unknown => {
    if (req.role.startsWith("review_")) return { reviewerRole: req.role.replace("review_", ""), candidateSha: req.candidateSha, verdict: "pass", findings: [] };
    switch (req.role) {
      case "intake": return { decision: "accept", summary: "ok", ...(o.intakeRisk ? { risk_hint: o.intakeRisk } : {}), acceptance_criteria: [{ id: "AC-1", text: "x" }] };
      case "analyst": return requirements();
      case "architect": return design(o.files);
      case "spec": return spec(o.files);
      default: return { artifactUri: `mock://${req.role}`, summary: "ok" };
    }
  };
  const adapter = new MockAdapter({ output: out, schemas });
  const agent = agentTaskExecutor({ sql: db.sql, adapter, store, modelFor: () => "m-builder", contextUri: (j, r) => buildContextManifest(db.sql, store, j, r) });
  const runtime: BuilderRuntime = { async edit(ctx, i) { if (i.role === "tester") return { ok: true }; const r = await ctx.run("/bin/sh", ["-c", o.script]); return { ok: r.exitCode === 0 }; } };
  const build = builderTaskExecutor({ sql: db.sql, store, runtime, remoteFor: async () => ({ url: remote, allowLocalRemote: true }) });
  const review = createReviewPort({ sql: db.sql, store, adapter, modelFor: () => "m-reviewer" });
  const pol = createPolicyPort({ sql: db.sql, store, policy: o.policyOverride ?? policy, policyDigest: POLICY_DIGEST, review });
  const base = mockPorts();
  const mk = () => new Orchestrator({
    sql: db.sql, ports: { ...base, review, policy: pol, scm: { ...base.scm, prepare: async () => ({ baseSha }), commitCandidate: candidateScm(db.sql).commitCandidate } },
    intake: createIntakeHandler({ sql: db.sql, store }), spec: createSpecHandler({ sql: db.sql, store }),
  });
  return { exec: composeExecutors(agent, build), mk };
}
async function drive(id: string, r: ReturnType<typeof rig>) {
  const w = await enrollWorker(cfg());
  const orch = r.mk();
  for (let i = 0; i < 300; i++) {
    const t = await orch.tick(id);
    if (["terminal", "awaiting-human", "awaiting-info"].includes(t.action)) return t;
    if (t.action === "enqueued" || t.action === "waiting") await runOnce(cfg(), w, r.exec);
  }
  throw new Error("did not settle");
}
const outcome = async (id: string) => {
  const [j] = await db.sql`SELECT state, risk, policy_digest FROM jobs WHERE id=${id}`;
  const [d] = await db.sql`SELECT risk, eligible, reasons FROM policy_decisions WHERE job_id=${id}`;
  const roles = (await db.sql`SELECT DISTINCT reviewer_role FROM review_results WHERE job_id=${id} ORDER BY reviewer_role`).map((r) => r.reviewer_role as string);
  return { job: j!, decision: d!, roles, reasons: (d!.reasons as string[]).join(" | ") };
};
const SAFE = "Update the documentation so that new contributors can find the setup instructions quickly.";

describe("policy inside the orchestrator", () => {
  test("docs-only change is LOW but is STILL not eligible for auto-merge under the pilot policy; code reviewer only", async () => {
    const id = await job(SAFE);
    expect((await drive(id, rig({ files: ["README.md"], script: `printf 'edited\\n' > README.md`, intakeRisk: "LOW" }))).action).toBe("awaiting-human");
    const o = await outcome(id);
    expect(o.job).toMatchObject({ state: "AWAITING_HUMAN", risk: "LOW", policy_digest: POLICY_DIGEST });
    expect(o.decision).toMatchObject({ risk: "LOW", eligible: false });
    expect(o.reasons).toMatch(/pilot/);
    expect(o.roles).toEqual(["code"]);
    expect((await db.sql`SELECT count(*)::int AS c FROM merge_intents WHERE job_id=${id}`)[0]!.c).toBe(0);
  });

  test("protected paths raise the risk from the ACTUAL candidate BEFORE reviewers are routed (package.json => HIGH => security reviewer)", async () => {
    const id = await job(SAFE);
    await drive(id, rig({ files: ["package.json"], script: `printf '{"name":"x"}\\n' > package.json` }));
    const o = await outcome(id);
    expect(o.job.risk).toBe("HIGH");
    expect(o.decision).toMatchObject({ risk: "HIGH", eligible: false });
    expect(o.roles).toEqual(["code", "security"]);
    expect(o.reasons).toContain("package.json");
    expect((await readEvents(db.sql, id, 0, 500)).find((e) => e.type === "review.routed")!.payload).toMatchObject({ roles: ["code", "security"] });
  });

  test("workflow changes are CRITICAL: code + security + performance reviewers, two-person approval flagged, never eligible", async () => {
    const id = await job(SAFE);
    await drive(id, rig({ files: [".github/workflows/ci.yml"], script: `printf 'name: changed\\n' > .github/workflows/ci.yml` }));
    const o = await outcome(id);
    expect(o.job.risk).toBe("CRITICAL");
    expect(o.decision.eligible).toBe(false);
    expect(o.roles).toEqual(["code", "performance", "security"]);
    expect(o.reasons).toMatch(/CRITICAL: \.github\/workflows\/ci\.yml/);
  });

  test("uncertain classification escalates: a symlink in a docs path cannot keep the change at LOW", async () => {
    const id = await job(SAFE);
    await drive(id, rig({ files: ["docs/link.md"], script: `ln -s a.md docs/link.md` }));
    const o = await outcome(id);
    expect(o.job.risk).toBe("HIGH");
    expect(o.reasons).toMatch(/uncertain classification \(symlink\)/);
    expect(o.roles).toContain("security");
  });

  test("a model/intake proposal can only raise: LOW docs change with an intake hint of CRITICAL ends CRITICAL; a HIGH path with a LOW hint stays HIGH", async () => {
    const a = await job(SAFE);
    await drive(a, rig({ files: ["README.md"], script: `printf 'x\\n' > README.md`, intakeRisk: "CRITICAL" }));
    expect((await outcome(a)).job.risk).toBe("CRITICAL");
    const b = await job(SAFE);
    const rb = await drive(b, rig({ files: ["package.json"], script: `printf '{"lowhint":1}\\n' > package.json`, intakeRisk: "LOW" }));
    expect(rb.action).toBe("awaiting-human");
    expect((await outcome(b)).job.risk).toBe("HIGH");
  });

  test("even a (hypothetical) policy that enables auto-merge for LOW cannot make HIGH/CRITICAL eligible; the DB also refuses it", async () => {
    const permissive = structuredClone(policy);
    permissive.merge.pilotHumanApproval = false;
    permissive.merge.autoMerge = { enabled: true, allowedRisks: ["LOW"], requireCalibration: false };
    const id = await job(SAFE);
    await drive(id, rig({ files: ["package.json"], script: `printf '{"a":1}\\n' > package.json`, policyOverride: permissive }));
    const o = await outcome(id);
    expect(o.decision).toMatchObject({ risk: "HIGH", eligible: false });
    expect(o.job.state).toBe("AWAITING_HUMAN");
    await expect(db.sql`INSERT INTO policy_decisions (job_id, head_sha, policy_digest, risk, eligible) VALUES (${id}, ${"a".repeat(40)}, 'p', 'CRITICAL', true)`).rejects.toThrow(/check/);
  });

  test("a different policy has a different digest, so approvals bound to the old policy are stale", async () => {
    const changed = structuredClone(policy); changed.minimumRisk.unmatchedPathLevel = "HIGH";
    const { policyDigest } = await import("@factory/domain");
    expect(policyDigest(changed)).not.toBe(POLICY_DIGEST);
  });
});
