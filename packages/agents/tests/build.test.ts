import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "@factory/db";
import { buildContextManifest, createIntakeHandler, registerIntakeSchema } from "@factory/intake";
import { agentTaskExecutor, builderTaskExecutor, composeExecutors, FileArtifactStore, mockPorts, Orchestrator, type BuilderRuntime, type MockPortOptions } from "@factory/orchestrator";
import { enrollWorker, runOnce, type RunnerConfig } from "@factory/runner";
import { MockAdapter, SchemaRegistry, type AgentRunRequest } from "@factory/runtimes";
import { detectBackend } from "@factory/sandboxes";
import { candidateScm, commitCandidate, CandidateRejected, fetchWorkspaceRepo } from "@factory/scm";
import { createTestDb } from "../../db/src/testing";
import { createSpecHandler, registerSpecSchemas, type Design, type Requirements, type Spec } from "../src/index";

const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...GIT_ENV, HOME: mkdtempSync(join(tmpdir(), "gh-")) } }).trim();

const requirements = (): Requirements => ({ acceptance_criteria: [{ id: "AC-1", text: "status filter", observable: "list shows only that status" }], assumptions: [], out_of_scope: [] });
const design = (): Design => ({ approach: "filter", files_affected: [{ path: "src/search.ts", change: "modify" }, { path: "tests/search.test.ts", change: "add" }], threat_notes: [], risks: [] });
const spec = (): Spec => ({
  tasks: [{ id: "T-1", title: "filter", files: ["src/search.ts", "tests/search.test.ts"], covers: ["AC-1"], checks: ["C-1"] }],
  checks: [{ id: "C-1", description: "tests", covers: ["AC-1"], runs: { test_file: "tests/search.test.ts" } }], test_strategy: "unit",
});

let db: Awaited<ReturnType<typeof createTestDb>>;
let org: string; let repo: string; let n = 0;
let remote: string; let baseSha: string;
const store = new FileArtifactStore(mkdtempSync(join(tmpdir(), "cas-")));
const wsRoot = mkdtempSync(join(tmpdir(), "bld-ws-"));
const schemas = registerSpecSchemas(registerIntakeSchema(new SchemaRegistry()));
const cfg = (): RunnerConfig => ({ sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: { PATH: "/usr/bin" }, heartbeatMs: 1000 });

beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id;
  const root = mkdtempSync(join(tmpdir(), "bld-remote-"));
  remote = join(root, "remote.git");
  const seed = join(root, "seed");
  mkdirSync(seed);
  sh(root, "init", "--bare", "-b", "main", remote);
  sh(seed, "init", "-b", "main");
  mkdirSync(join(seed, "src"));
  writeFileSync(join(seed, "src/search.ts"), "export const search = () => 'v1';\n");
  writeFileSync(join(seed, "README.md"), "# demo\n");
  sh(seed, "add", "."); sh(seed, "commit", "-m", "base");
  sh(seed, "push", remote, "main");
  baseSha = sh(seed, "rev-parse", "HEAD");
});
afterAll(async () => { await db.drop(); });

async function job(maxRounds = 3): Promise<string> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 'Status filter', 'Users can filter the job list by status and the page updates without a reload.') RETURNING id`;
  return (await db.sql`INSERT INTO jobs (request_id, repository_id, max_rounds) VALUES (${req!.id}, ${repo}, ${maxRounds}) RETURNING id`)[0]!.id as string;
}

/** Scripted code-writing agent: runs shell commands INSIDE the sandbox, exactly like a real builder CLI would. */
const scripted = (script: (role: "builder" | "tester", round: number) => string): BuilderRuntime => ({
  async edit(ctx, i) { const r = await ctx.run("/bin/sh", ["-c", script(i.role, i.round)]); return { ok: r.exitCode === 0, note: r.stderr.slice(0, 200) }; },
});
const goodScript = (role: "builder" | "tester", round: number) =>
  role === "builder" ? `mkdir -p src && printf "export const search = () => 'round ${round}';\\n" > src/search.ts` : `mkdir -p tests && printf "// test r${round}\\n" > tests/search.test.ts`;

function rig(o: { runtime?: BuilderRuntime; ports?: MockPortOptions; limits?: { maxFileBytes?: number } } = {}) {
  const out = (req: AgentRunRequest): unknown => {
    switch (req.role) {
      case "intake": return { decision: "accept", summary: "ok", acceptance_criteria: [{ id: "AC-1", text: "status filter" }] };
      case "analyst": return requirements();
      case "architect": return design();
      case "spec": return spec();
      default: return { artifactUri: `mock://${req.role}`, summary: "ok" };
    }
  };
  const agent = agentTaskExecutor({ sql: db.sql, adapter: new MockAdapter({ output: out, schemas }), store, modelFor: () => "mock", contextUri: (j, r) => buildContextManifest(db.sql, store, j, r) });
  const build = builderTaskExecutor({ sql: db.sql, store, runtime: o.runtime ?? scripted(goodScript), remoteFor: async () => ({ url: remote, allowLocalRemote: true }), ...(o.limits ? { limits: o.limits } : {}) });
  const exec = composeExecutors(agent, build);
  const base = mockPorts(o.ports);
  const mk = () => new Orchestrator({
    sql: db.sql, ports: { ...base, scm: { ...base.scm, prepare: async () => ({ baseSha }), commitCandidate: candidateScm(db.sql).commitCandidate } },
    intake: createIntakeHandler({ sql: db.sql, store }), spec: createSpecHandler({ sql: db.sql, store }),
  });
  return { exec, mk };
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
const remoteSha = (branch: string) => sh(remote, "rev-parse", `refs/heads/${branch}`);

describe("candidate commits", () => {
  test("pipeline produces builder+tester candidates: chained parents, branch pushed, SHA recorded on the job, base branch untouched", async () => {
    const id = await job();
    expect((await drive(id, rig())).action).toBe("awaiting-human");
    const cands = await db.sql`SELECT round, role, parent_sha, head_sha FROM candidates WHERE job_id=${id} ORDER BY role`;
    expect(cands.map((c) => c.role)).toEqual(["builder", "tester"]);
    const b = cands.find((c) => c.role === "builder")!;
    const t = cands.find((c) => c.role === "tester")!;
    expect(b.parent_sha).toBe(baseSha);
    expect(t.parent_sha).toBe(b.head_sha);
    const [j] = await db.sql`SELECT head_sha, base_sha FROM jobs WHERE id=${id}`;
    expect(j).toMatchObject({ head_sha: t.head_sha, base_sha: baseSha });
    expect(remoteSha(`factory/${id}`)).toBe(t.head_sha);
    expect(remoteSha("main")).toBe(baseSha);
    expect(sh(remote, "log", "--format=%H", `refs/heads/factory/${id}`).split("\n")).toEqual([t.head_sha, b.head_sha, baseSha]);
    expect(sh(remote, "show", `refs/heads/factory/${id}:src/search.ts`)).toContain("round 0");
    // evidence is bound to the recorded candidate SHA
    expect((await db.sql`SELECT head_sha FROM gate_results WHERE job_id=${id}`).map((g) => g.head_sha)).toEqual([t.head_sha]);
    expect((await db.sql`SELECT head_sha FROM review_results WHERE job_id=${id}`).every((r) => r.head_sha === t.head_sha)).toBe(true);
    // descriptors and patches are durable, content-addressed, integrity-checked artifacts
    const [d] = await db.sql`SELECT digest FROM artifacts WHERE job_id=${id} AND kind='build.r0.json'`;
    const desc = JSON.parse(store.get(d!.digest).toString());
    expect(desc).toMatchObject({ schema: "factory.candidate/1", headSha: b.head_sha, parentSha: baseSha, role: "builder" });
    expect(desc.files.map((f: { path: string }) => f.path)).toEqual(["src/search.ts"]);
    const [p] = await db.sql`SELECT digest FROM artifacts WHERE job_id=${id} AND kind='patch.builder.r0'`;
    expect(store.get(p!.digest).toString()).toContain("+export const search = () => 'round 0';");
    expect(readdirSync(wsRoot)).toEqual([]); // workspaces torn down
  });

  test("candidate SHAs are reproducible: identical base + edits + metadata => identical commit", async () => {
    const make = async () => {
      const dir = join(mkdtempSync(join(tmpdir(), "repro-")), "repo");
      await fetchWorkspaceRepo({ repoDir: dir, remoteUrl: remote, sha: baseSha, allowLocalRemote: true });
      writeFileSync(join(dir, "src/search.ts"), "export const search = () => 'same';\n");
      return commitCandidate({ repoDir: dir, parentSha: baseSha, allowedPaths: ["src/search.ts"], message: "m", dateIso: "2026-11-19T00:00:00.000Z" });
    };
    const [a, b] = [await make(), await make()];
    expect(a.headSha).toBe(b.headSha);
    expect(a.treeSha).toBe(b.treeSha);
    expect(a.patchDigest).toBe(b.patchDigest);
    const dir = join(mkdtempSync(join(tmpdir(), "repro-")), "repo");
    await fetchWorkspaceRepo({ repoDir: dir, remoteUrl: remote, sha: baseSha, allowLocalRemote: true });
    writeFileSync(join(dir, "src/search.ts"), "export const search = () => 'different';\n");
    expect((await commitCandidate({ repoDir: dir, parentSha: baseSha, allowedPaths: ["src/search.ts"], message: "m", dateIso: "2026-11-19T00:00:00.000Z" })).headSha).not.toBe(a.headSha);
  });

  test("the builder cannot touch files outside the approved design, nor use forbidden/escaping/oversized files: the task fails and no candidate exists", async () => {
    const attacks: Array<[string, string, string]> = [
      ["file outside design", `echo hacked > src/other.ts`, "path-outside-scope"],
      ["gitattributes (filter drivers)", `printf '* filter=evil\\n' > .gitattributes && echo x > src/search.ts`, "forbidden-file"],
      ["symlink escaping the repo", `ln -sf /etc/passwd src/search.ts`, "symlink-escape"],
      ["oversized file", `head -c 5000 /dev/zero | tr '\\0' 'a' > src/search.ts`, "too-large"],
      ["workflow / protected path outside scope", `mkdir -p .github/workflows && echo x > .github/workflows/ci.yml`, "path-outside-scope"],
      ["no changes at all", `true`, "empty"],
    ];
    for (const [name, script, code] of attacks) {
      const id = await job();
      const res = await drive(id, rig({ runtime: scripted(() => script), limits: { maxFileBytes: 1000 } }));
      expect(res.state, name).toBe("FAILED");
      expect((await db.sql`SELECT count(*)::int AS c FROM candidates WHERE job_id=${id}`)[0]!.c, name).toBe(0);
      const [t] = await db.sql`SELECT status FROM tasks WHERE job_id=${id} AND role='builder'`;
      expect(t!.status, name).toBe("failed");
      const failed = (await readEvents(db.sql, id, 0, 500)).find((e) => e.type === "task.failed");
      expect(failed?.payload, name).toMatchObject({ error: "candidate-rejected", code });
      expect(() => remoteSha(`factory/${id}`), name).toThrow(); // nothing was pushed
    }
    // the rejection codes themselves
    const dir = join(mkdtempSync(join(tmpdir(), "rej-")), "repo");
    await fetchWorkspaceRepo({ repoDir: dir, remoteUrl: remote, sha: baseSha, allowLocalRemote: true });
    writeFileSync(join(dir, "src/other.ts"), "x");
    await expect(commitCandidate({ repoDir: dir, parentSha: baseSha, allowedPaths: ["src/search.ts"], message: "m", dateIso: "2026-11-19T00:00:00.000Z" })).rejects.toMatchObject({ code: "path-outside-scope" });
    await expect(commitCandidate({ repoDir: dir, parentSha: "f".repeat(40), allowedPaths: ["src/other.ts"], message: "m", dateIso: "2026-11-19T00:00:00.000Z" })).rejects.toBeInstanceOf(CandidateRejected);
  });

  test("a planted hook / poisoned config in the worktree never runs and cannot influence the commit", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "mark-")), "RAN");
    const dir = join(mkdtempSync(join(tmpdir(), "hook-")), "repo");
    await fetchWorkspaceRepo({ repoDir: dir, remoteUrl: remote, sha: baseSha, allowLocalRemote: true });
    writeFileSync(join(dir, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(dir, ".git/hooks/post-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(dir, ".git/config"), readFileSync(join(dir, ".git/config"), "utf8") + `[core]\n\tfsmonitor = touch ${marker}\n[alias]\n\tcommit-tree = !touch ${marker}\n[user]\n\tname = Mallory\n`);
    writeFileSync(join(dir, "src/search.ts"), "export const search = () => 'ok';\n");
    const c = await commitCandidate({ repoDir: dir, parentSha: baseSha, allowedPaths: ["src/search.ts"], message: "m", dateIso: "2026-11-19T00:00:00.000Z" });
    expect(existsSync(marker)).toBe(false);
    expect(sh(dir, "log", "-1", "--format=%an <%ae>", c.headSha)).toBe("AI Factory <factory@invalid.example>");
  });

  test("credentials never land in the workspace; unsafe remotes and SHAs are refused", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cred-")), "repo");
    await fetchWorkspaceRepo({ repoDir: dir, remoteUrl: remote, sha: baseSha, token: "ghs_supersecrettokenvalue1234567890", allowLocalRemote: true });
    const g = spawnSync("grep", ["-r", "-l", "supersecrettoken", dir], { encoding: "utf8" });
    expect(g.status).toBe(1); // grep exit 1 = no match anywhere in the worktree or .git
    expect(g.stdout).toBe("");
    await expect(fetchWorkspaceRepo({ repoDir: join(dir, "x"), remoteUrl: "https://evil.example/o/r.git", sha: baseSha })).rejects.toBeInstanceOf(CandidateRejected);
    await expect(fetchWorkspaceRepo({ repoDir: join(dir, "y"), remoteUrl: "git@github.com:o/r.git", sha: baseSha })).rejects.toBeInstanceOf(CandidateRejected);
    await expect(fetchWorkspaceRepo({ repoDir: join(dir, "z"), remoteUrl: remote, sha: "HEAD", allowLocalRemote: true })).rejects.toBeInstanceOf(CandidateRejected);
  });

  test("candidates are immutable and unique per (job, round, role); a retried task reuses the recorded candidate", async () => {
    const id = await job();
    await drive(id, rig());
    await expect(db.sql`UPDATE candidates SET head_sha = ${"a".repeat(40)} WHERE job_id=${id}`).rejects.toThrow(/append-only/);
    await expect(db.sql`DELETE FROM candidates WHERE job_id=${id}`).rejects.toThrow(/append-only/);
    const [c] = await db.sql`SELECT head_sha FROM candidates WHERE job_id=${id} AND role='builder'`;
    await expect(db.sql`INSERT INTO candidates (job_id, round, role, parent_sha, head_sha, tree_sha, patch_digest, descriptor_digest, files_changed) VALUES (${id}, 0, 'builder', ${baseSha}, ${"b".repeat(40)}, ${"c".repeat(40)}, ${"sha256:" + "d".repeat(64)}, ${"sha256:" + "e".repeat(64)}, 1)`).rejects.toThrow(/duplicate key/);
    // simulate "attempt 2" of the builder task after a crash: nothing new is created
    const w = await enrollWorker(cfg());
    await db.sql`INSERT INTO tasks (job_id, stage, role, status) VALUES (${id}, 'BUILDING:builder:r0', 'builder-retry-probe', 'pending')`;
    const exec = rig().exec;
    const lease = { taskId: "t", jobId: id, stage: "BUILDING:builder:r0", role: "builder", attempt: 2, leaseToken: 1, expiresAt: new Date() };
    const out = await exec({ lease, workspace: { id: "x", root: wsRoot, repoDir: join(wsRoot, "repo"), homeDir: wsRoot, tmpDir: wsRoot }, signal: new AbortController().signal, run: async () => { throw new Error("must not run"); }, report: async () => undefined });
    expect(out).toMatchObject({ ok: true, payload: { head_sha: c!.head_sha, reused: true } });
    expect((await db.sql`SELECT count(*)::int AS c FROM candidates WHERE job_id=${id}`)[0]!.c).toBe(2);
    void w;
  });
});

describe("rework loop and bounded retries", () => {
  test("gate failure -> rework builds on the PREVIOUS candidate (new round, new SHA); branch fast-forwards; evidence per SHA; feedback reaches the builder", async () => {
    const id = await job();
    let seenFeedback: unknown[] = [];
    const runtime: BuilderRuntime = { async edit(ctx, i) { if (i.role === "builder" && i.round === 1) seenFeedback = i.feedback; const r = await ctx.run("/bin/sh", ["-c", goodScript(i.role, i.round)]); return { ok: r.exitCode === 0 }; } };
    expect((await drive(id, rig({ runtime, ports: { gateFailRounds: [0] } }))).action).toBe("awaiting-human");
    const c = await db.sql`SELECT round, role, parent_sha, head_sha FROM candidates WHERE job_id=${id} ORDER BY round, role`;
    expect(c.map((x) => `${x.round}:${x.role}`)).toEqual(["0:builder", "0:tester", "1:builder", "1:tester"]);
    expect(c.find((x) => x.round === 1 && x.role === "builder")!.parent_sha).toBe(c.find((x) => x.round === 0 && x.role === "tester")!.head_sha);
    expect(remoteSha(`factory/${id}`)).toBe(c.find((x) => x.round === 1 && x.role === "tester")!.head_sha);
    expect(sh(remote, "log", "--format=%H", `refs/heads/factory/${id}`).split("\n").length).toBe(5); // base + 4 candidate commits
    const gates = await db.sql`SELECT head_sha, verdict FROM gate_results WHERE job_id=${id} ORDER BY created_at`;
    expect(gates.map((g) => g.verdict)).toEqual(["fail", "pass"]);
    expect(gates[0]!.head_sha).toBe(c.find((x) => x.round === 0 && x.role === "tester")!.head_sha);
    expect(gates[1]!.head_sha).toBe(c.find((x) => x.round === 1 && x.role === "tester")!.head_sha);
    expect(seenFeedback).toEqual([expect.objectContaining({ type: "gate.failed", class: "unit", round: 0 })]);
  });

  test("at most 2 automated fixes per failure class: the 3rd failure of the same class escalates to a human (bounded retries)", async () => {
    const id = await job(10);
    const res = await drive(id, rig({ ports: { gateFailRounds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] } }));
    expect(res.action).toBe("awaiting-human");
    expect((await db.sql`SELECT count(DISTINCT round)::int AS c FROM candidates WHERE job_id=${id}`)[0]!.c).toBe(3); // initial build + 2 fixes
    expect((await db.sql`SELECT count(*)::int AS c FROM gate_results WHERE job_id=${id} AND verdict='fail'`)[0]!.c).toBe(3);
    expect((await db.sql`SELECT count(*)::int AS c FROM merge_intents WHERE job_id=${id}`)[0]!.c).toBe(0);
    const t = await db.sql`SELECT from_state, to_state FROM job_transitions WHERE job_id=${id} ORDER BY version DESC LIMIT 2`;
    expect(t.map((x) => `${x.from_state}>${x.to_state}`)).toEqual(["REWORK>AWAITING_HUMAN", "GATING>REWORK"]);
  });

  test("overall round budget also bounds rework", async () => {
    const id = await job(1);
    const res = await drive(id, rig({ ports: { gateFailRounds: [0, 1, 2] } }));
    expect(res.action).toBe("awaiting-human");
    expect((await db.sql`SELECT count(DISTINCT round)::int AS c FROM candidates WHERE job_id=${id}`)[0]!.c).toBe(2);
  });
});
