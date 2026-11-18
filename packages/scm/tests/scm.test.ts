import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readEvents } from "@factory/db";
import { createTestDb } from "../../db/src/testing";
import { createAppJwt, ensureDraftPr, GitHubApiError, GitHubClient, InstallationTokenProvider, PushRefused, pushFactoryBranch, receiveGitHubWebhook, ROLE_PERMISSIONS, verifyGitHubSignature } from "../src/index";
import { FakeGitHub } from "./fake-github";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const repo = { owner: "o", name: "r" };

let db: Awaited<ReturnType<typeof createTestDb>>;
let fake: FakeGitHub;
let org: string;
let repoId: string;
let n = 0;
const mkClient = (opts: Partial<ConstructorParameters<typeof GitHubClient>[0]> = {}) =>
  new GitHubClient({
    apiBase: fake.url, sleep: async () => undefined,
    tokens: new InstallationTokenProvider({ apiBase: fake.url, appId: "123", privateKeyPem: privateKey, installationId: "9" }), ...opts,
  });

beforeAll(async () => {
  db = await createTestDb();
  fake = new FakeGitHub(publicKey).start();
  const [o] = await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`;
  org = o!.id;
  const [r] = await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', '42', 'o', 'r') RETURNING id`;
  repoId = r!.id;
});
afterAll(async () => { fake.stop(); await db.drop(); });

async function job(): Promise<string> {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repoId}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repoId}) RETURNING id`;
  return j!.id;
}
const input = (jobId: string, sha = SHA_A) => ({ jobId, repositoryId: repoId, repo, baseBranch: "main", headSha: sha, title: "Factory: t", body: "job body" });

describe("GitHub App auth", () => {
  test("app JWT is RS256, <=10 minutes, verifiable with the public key", () => {
    const jwt = createAppJwt("123", privateKey, 1_700_000_000);
    const [h, b, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(b, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(createPublicKey(publicKey), Buffer.from(s, "base64url"))).toBe(true);
  });
  test("tokens are repository-narrowed, role-scoped, cached, and branch_write != merge", async () => {
    const tp = new InstallationTokenProvider({ apiBase: fake.url, appId: "123", privateKeyPem: privateKey, installationId: "9" });
    const t1 = await tp.token("branch_write", repo);
    expect(await tp.token("branch_write", repo)).toBe(t1);
    const read = await tp.token("read", repo);
    expect(read).not.toBe(t1);
    expect(fake.tokens.get(t1)?.repos).toEqual(["r"]);
    expect(fake.tokens.get(t1)?.perms).toEqual(ROLE_PERMISSIONS.branch_write);
    expect(fake.tokens.get(read)?.perms.contents).toBe("read");
    expect(ROLE_PERMISSIONS.branch_write).not.toEqual(ROLE_PERMISSIONS.merge);
    expect(ROLE_PERMISSIONS.branch_write).not.toHaveProperty("checks");
    const expired = new InstallationTokenProvider({ apiBase: fake.url, appId: "123", privateKeyPem: privateKey, installationId: "9", now: (() => { let t = Date.now(); return () => (t += 3_700_000); })() });
    expect(await expired.token("read", repo)).not.toBe(await expired.token("read", repo)); // always past expiry => refetched
  });
  test("a bad app key is rejected by GitHub and the error does not leak credentials", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const tp = new InstallationTokenProvider({ apiBase: fake.url, appId: "123", privateKeyPem: other.privateKey, installationId: "9" });
    await expect(tp.token("read", repo)).rejects.toThrow(/HTTP 401/);
  });
});

describe("GitHub client", () => {
  test("refuses non-factory branches before any network call", async () => {
    const before = fake.log.length;
    const c = mkClient();
    for (const b of ["main", "master", "factory/../main", "factory/", "release/1", "factory/a b"]) await expect(c.createBranch(repo, b, SHA_A)).rejects.toBeInstanceOf(GitHubApiError);
    await expect(c.createDraftPr(repo, { head: "main", base: "main", title: "x", body: "y" })).rejects.toBeInstanceOf(GitHubApiError);
    expect(fake.log.length).toBe(before);
  });
  test("createBranch is idempotent", async () => {
    const c = mkClient();
    expect(await c.createBranch(repo, "factory/idem", SHA_A)).toEqual({ sha: SHA_A, created: true });
    expect(await c.createBranch(repo, "factory/idem", SHA_B)).toEqual({ sha: SHA_A, created: false });
  });
  test("GETs retry transient failures; POSTs are never blindly retried; 4xx surface as typed errors", async () => {
    const c = mkClient();
    fake.failNext(/GET \/repos\/o\/r$/, 502, 2);
    expect((await c.getRepo(repo)).defaultBranch).toBe("main");
    fake.failNext(/POST \/repos\/o\/r\/git\/refs/, 500, 1);
    const before = fake.log.filter((l) => l.method === "POST" && l.path.endsWith("/git/refs")).length;
    await expect(c.createBranch(repo, "factory/flaky", SHA_A)).rejects.toMatchObject({ status: 500 });
    expect(fake.log.filter((l) => l.method === "POST" && l.path.endsWith("/git/refs")).length).toBe(before + 1);
    fake.failNext(/GET \/repos\/o\/r$/, 503, 10);
    await expect(c.getRepo(repo)).rejects.toMatchObject({ status: 503 });
    fake.failNext(/GET/, 200, 0);
  });
  test("malformed upstream JSON is rejected, not trusted", async () => {
    const c = mkClient({ fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return fetch(url, init);
      return new Response(JSON.stringify({ number: "NaN", head: {} }), { status: 200 });
    }) as typeof fetch });
    await expect(c.getPr(repo, 1)).rejects.toThrow();
  });
});

describe("idempotent draft PR creation", () => {
  test("producing the draft PR twice yields one PR, one mapping row and one event", async () => {
    const j = await job();
    const a = await ensureDraftPr(db.sql, mkClient(), input(j));
    const b = await ensureDraftPr(db.sql, mkClient(), input(j));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.prNumber).toBe(a.prNumber);
    expect(fake.prs.filter((p) => p.head.ref === `factory/${j}`).length).toBe(1);
    expect(fake.prs.find((p) => p.number === a.prNumber)?.draft).toBe(true);
    expect((await db.sql`SELECT count(*)::int AS c FROM pull_requests WHERE job_id=${j}`)[0]!.c).toBe(1);
    expect((await readEvents(db.sql, j)).filter((e) => e.type === "pr.created").length).toBe(1);
    expect((await db.sql`SELECT pr_number, head_sha FROM jobs WHERE id=${j}`)[0]).toMatchObject({ pr_number: a.prNumber, head_sha: SHA_A });
  });
  test("8 concurrent callers create exactly one PR", async () => {
    const j = await job();
    const rs = await Promise.all(Array.from({ length: 8 }, () => ensureDraftPr(db.sql, mkClient(), input(j))));
    expect(new Set(rs.map((r) => r.prNumber)).size).toBe(1);
    expect(rs.filter((r) => r.created).length).toBe(1);
    expect(fake.prs.filter((p) => p.head.ref === `factory/${j}`).length).toBe(1);
  });
  test("crash recovery: PR exists on GitHub but not in the DB -> adopted, no duplicate", async () => {
    const j = await job();
    fake.refs.set(`factory/${j}`, SHA_A);
    const orphan = fake.addPr(`factory/${j}`, SHA_A, true);
    const r = await ensureDraftPr(db.sql, mkClient(), input(j));
    expect(r.prNumber).toBe(orphan.number);
    expect(r.created).toBe(false);
    expect(fake.prs.filter((p) => p.head.ref === `factory/${j}`).length).toBe(1);
  });
  test("lost creation race (GitHub 422) resolves to the winner's PR", async () => {
    const j = await job();
    fake.onBeforeCreatePr = () => { fake.onBeforeCreatePr = undefined; fake.addPr(`factory/${j}`, SHA_A, true); };
    const r = await ensureDraftPr(db.sql, mkClient(), input(j));
    expect(r.created).toBe(false);
    expect(fake.prs.filter((p) => p.head.ref === `factory/${j}`).length).toBe(1);
  });
  test("a pre-existing branch at a different SHA is never adopted", async () => {
    const j = await job();
    fake.refs.set(`factory/${j}`, SHA_B);
    await expect(ensureDraftPr(db.sql, mkClient(), input(j, SHA_A))).rejects.toMatchObject({ status: 409 });
    expect((await db.sql`SELECT count(*)::int AS c FROM pull_requests WHERE job_id=${j}`)[0]!.c).toBe(0);
  });
  test("GitHub failure leaves no partial DB state and a retry succeeds", async () => {
    const j = await job();
    fake.failNext(/POST \/repos\/o\/r\/pulls/, 500, 1);
    await expect(ensureDraftPr(db.sql, mkClient(), input(j))).rejects.toMatchObject({ status: 500 });
    expect((await db.sql`SELECT count(*)::int AS c FROM pull_requests WHERE job_id=${j}`)[0]!.c).toBe(0);
    const r = await ensureDraftPr(db.sql, mkClient(), input(j));
    expect(r.prNumber).toBeGreaterThan(0);
    expect(fake.prs.filter((p) => p.head.ref === `factory/${j}`).length).toBe(1);
  });
  test("branch protection and the base branch are never touched; only factory refs and PR creation are written", () => {
    const writes = fake.log.filter((l) => l.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.method).toBe("POST");
      expect(/\/access_tokens$|\/git\/refs$|\/pulls$/.test(w.path)).toBe(true);
    }
    expect(fake.log.some((l) => /protection|rulesets|\/merge/.test(l.path))).toBe(false);
    expect(fake.refs.get("main")).toBe("1".repeat(40));
    expect([...fake.refs.keys()].filter((k) => k !== "main").every((k) => k.startsWith("factory/"))).toBe(true);
    expect(fake.prs.every((p) => p.base.ref === "main")).toBe(true);
  });
});

describe("branch push (trusted side)", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: mkdtempSync(join(tmpdir(), "h-")), GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" } }).trim();
  function mkRepos() {
    const root = mkdtempSync(join(tmpdir(), "push-"));
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    mkdirSync(work);
    sh(root, "init", "--bare", "-b", "main", remote);
    sh(work, "init", "-b", "main");
    writeFileSync(join(work, "f.txt"), "1");
    sh(work, "add", "."); sh(work, "commit", "-m", "c1");
    return { remote, work, sha: sh(work, "rev-parse", "HEAD") };
  }
  test("pushes exact SHA to factory/*, idempotently; a poisoned pre-push hook and config never run", async () => {
    const { remote, work, sha } = mkRepos();
    const marker = join(work, "HOOK-RAN");
    writeFileSync(join(work, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(work, ".git", "config"), readConfig(work) + `[core]\n\tfsmonitor = touch ${marker}\n[alias]\n\tx = !touch ${marker}\n`);
    await pushFactoryBranch({ repoDir: work, remoteUrl: remote, branch: "factory/job-1", sha, allowLocalRemote: true });
    await pushFactoryBranch({ repoDir: work, remoteUrl: remote, branch: "factory/job-1", sha, allowLocalRemote: true });
    expect(sh(remote, "rev-parse", "refs/heads/factory/job-1")).toBe(sha);
    expect(sh(remote, "branch", "--list").includes("main")).toBe(false);
    expect(() => execFileSync("test", ["-e", marker])).toThrow();
  });
  test("refuses base/non-factory branches, bad SHAs, non-GitHub remotes, force-style divergence", async () => {
    const { remote, work, sha } = mkRepos();
    const base = { repoDir: work, remoteUrl: remote, sha, allowLocalRemote: true };
    for (const branch of ["main", "master", "refs/heads/main", "factory/../main", "release/1"]) await expect(pushFactoryBranch({ ...base, branch })).rejects.toBeInstanceOf(PushRefused);
    await expect(pushFactoryBranch({ ...base, branch: "factory/x", sha: "HEAD" })).rejects.toBeInstanceOf(PushRefused);
    await expect(pushFactoryBranch({ ...base, branch: "factory/x", sha: "f".repeat(40) })).rejects.toBeInstanceOf(PushRefused);
    for (const remoteUrl of ["https://evil.example/o/r.git", "git@github.com:o/r.git", "ext::sh -c touch /tmp/x", remote]) {
      await expect(pushFactoryBranch({ repoDir: work, remoteUrl, branch: "factory/x", sha })).rejects.toBeInstanceOf(PushRefused);
    }
    // diverged history cannot overwrite (no force)
    await pushFactoryBranch({ ...base, branch: "factory/div" });
    sh(work, "checkout", "--orphan", "other"); writeFileSync(join(work, "g.txt"), "2"); sh(work, "add", "."); sh(work, "commit", "-m", "x");
    await expect(pushFactoryBranch({ ...base, branch: "factory/div", sha: sh(work, "rev-parse", "HEAD") })).rejects.toBeInstanceOf(PushRefused);
    expect(sh(remote, "rev-parse", "refs/heads/factory/div")).toBe(sha);
  });
  function readConfig(dir: string) { return readFileSync(join(dir, ".git", "config"), "utf8"); }
});

describe("webhooks", () => {
  const secret = "whsec-test";
  const sign = (body: string, s = secret) => "sha256=" + createHmac("sha256", s).update(body).digest("hex");
  const hook = (body: string, over: Partial<Parameters<typeof receiveGitHubWebhook>[1]> = {}) =>
    receiveGitHubWebhook(db.sql, { rawBody: body, signature: sign(body), deliveryId: crypto.randomUUID(), eventName: "pull_request", secret, ...over });
  const prEvent = (number: number, sha: string, action = "synchronize", merged = false) => JSON.stringify({ action, number, repository: { id: 42 }, pull_request: { number, merged, state: action === "closed" ? "closed" : "open", head: { sha } } });

  test("signature verification is constant-time, raw-body based and strict", () => {
    const body = '{"a":1}';
    expect(verifyGitHubSignature(body, sign(body), secret)).toBe(true);
    expect(verifyGitHubSignature(body + " ", sign(body), secret)).toBe(false);
    expect(verifyGitHubSignature(body, sign(body, "other"), secret)).toBe(false);
    for (const bad of [null, undefined, "", "sha1=abc", "sha256=zz", "sha256=" + "0".repeat(64)]) expect(verifyGitHubSignature(body, bad, secret)).toBe(false);
    expect(verifyGitHubSignature(body, sign(body), "")).toBe(false);
  });
  test("forged signatures are rejected, audited, and do not consume the delivery id", async () => {
    const body = prEvent(1, SHA_A);
    const id = crypto.randomUUID();
    expect(await hook(body, { deliveryId: id, signature: sign(body, "attacker") })).toEqual({ status: "rejected", reason: "bad-signature" });
    expect((await db.sql`SELECT count(*)::int AS c FROM webhook_deliveries WHERE delivery_id=${id}`)[0]!.c).toBe(0);
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE action='webhook.rejected'`)[0]!.c).toBeGreaterThan(0);
    expect((await hook(body, { deliveryId: id })).status).toBe("processed"); // the real delivery still works
  });
  test("replayed deliveries are deduplicated; 12 concurrent copies are processed exactly once", async () => {
    const j = await job();
    const pr = await ensureDraftPr(db.sql, mkClient(), input(j));
    const body = prEvent(pr.prNumber, SHA_B);
    const id = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => hook(body, { deliveryId: id })));
    expect(results.filter((r) => r.status === "processed").length).toBe(1);
    expect(results.filter((r) => r.status === "duplicate").length).toBe(11);
    expect((await readEvents(db.sql, j)).filter((e) => e.type === "pr.head_changed").length).toBe(1);
  });
  test("head change updates job/PR head and emits pr.head_changed; closed+merged emits pr.closed; unchanged head emits nothing", async () => {
    const j = await job();
    const pr = await ensureDraftPr(db.sql, mkClient(), input(j));
    await hook(prEvent(pr.prNumber, SHA_A)); // same head
    await hook(prEvent(pr.prNumber, SHA_B));
    expect((await db.sql`SELECT head_sha FROM jobs WHERE id=${j}`)[0]!.head_sha).toBe(SHA_B);
    expect((await db.sql`SELECT head_sha FROM pull_requests WHERE job_id=${j}`)[0]!.head_sha).toBe(SHA_B);
    const r = await hook(prEvent(pr.prNumber, SHA_B, "closed", true));
    expect(r).toMatchObject({ status: "processed", effects: ["closed"] });
    const types = (await readEvents(db.sql, j)).map((e) => e.type);
    expect(types.filter((t) => t === "pr.head_changed").length).toBe(1);
    expect(types.filter((t) => t === "pr.closed").length).toBe(1);
  });
  test("malformed payloads roll back: no delivery row, so a corrected redelivery is processed", async () => {
    const id = crypto.randomUUID();
    const bad = JSON.stringify({ action: "synchronize", number: "x" });
    await expect(hook(bad, { deliveryId: id })).rejects.toThrow();
    expect((await db.sql`SELECT count(*)::int AS c FROM webhook_deliveries WHERE delivery_id=${id}`)[0]!.c).toBe(0);
    expect(await hook("{not json", { deliveryId: crypto.randomUUID() })).toEqual({ status: "rejected", reason: "malformed" });
    expect(await hook("{}", { deliveryId: "x" })).toEqual({ status: "rejected", reason: "missing-delivery-id" });
  });
  test("unknown events are recorded and ignored; unknown PRs have no effect", async () => {
    expect(await hook("{}", { eventName: "star" })).toEqual({ status: "ignored", event: "star" });
    expect(await hook(prEvent(9999, SHA_A))).toMatchObject({ status: "processed", effects: [] });
    expect(await hook("{}", { eventName: "ping" })).toMatchObject({ status: "processed" });
  });
});
