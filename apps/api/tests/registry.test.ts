import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { makeWritable, ReportSigner, type ValidationPolicy } from "@factory/skills";
import { createTestDb } from "../../../packages/db/src/testing";
import { makeZip } from "../../../packages/skills/tests/zip-helper";
import { CompositeAuthenticator, createApi, OidcAuthenticator } from "../src/index";

const ISS = "https://idp.example.test", AUD = "factory-api";
let db: Awaited<ReturnType<typeof createTestDb>>; let privateKey: CryptoKey; let api: (r: Request) => Promise<Response>;
const base = mkdtempSync(join(tmpdir(), "apiskills-"));
const POLICY: ValidationPolicy = { version: "p1", allowedLicenses: ["MIT"], deniedHosts: ["api.anthropic.com"] };
let orgA = "", orgB = "";
const MD = (name: string) => `---\nname: ${name}\ndescription: Write user stories from a PRD with acceptance criteria\nlicense: MIT\nruntimes: [local_model]\nallowed-tools: [Read]\ndomains: [product]\nproduces: [user stories]\n---\nSteps.\n`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Omit<Response, "json"> & { json(): Promise<any> };

beforeAll(async () => {
  db = await createTestDb();
  const kp = await generateKeyPair("RS256"); privateKey = kp.privateKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), alg: "RS256", use: "sig", kid: "k1" };
  api = createApi({ sql: db.sql, rateLimit: { capacity: 10000, refillPerSec: 10000 }, authenticator: new CompositeAuthenticator([new OidcAuthenticator({ issuer: ISS, audience: AUD, keys: createLocalJWKSet({ keys: [jwk] }) })]),
    skills: { quarantineDir: join(base, "q"), scratchDir: join(base, "s"), policy: POLICY, signer: new ReportSigner("api") } });
  orgA = (await db.sql`INSERT INTO organizations (name) VALUES ('A') RETURNING id`)[0]!.id; orgB = (await db.sql`INSERT INTO organizations (name) VALUES ('B') RETURNING id`)[0]!.id;
  for (const [org, sub, role] of [[orgA, "editor", "editor"], [orgA, "operator", "operator"], [orgA, "approver", "approver"], [orgA, "admin", "admin"], [orgA, "viewer", "viewer"], [orgB, "approverB", "approver"], [orgB, "operatorB", "operator"]] as const)
    await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${sub}, ${role})`;
});
afterAll(async () => { await db.drop(); makeWritable(join(base, "q")); rmSync(base, { recursive: true, force: true }); });

const tok = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setSubject(sub).setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(privateKey);
let n = 0;
async function call(sub: string | null, method: string, path: string, body?: unknown, o: { key?: string | null; zip?: Buffer } = {}): Promise<R> {
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${await tok(sub)}`;
  if (o.key !== null && method === "POST") headers["idempotency-key"] = o.key ?? `k-${++n}-${crypto.randomUUID()}`;
  let payload: string | Buffer | undefined;
  if (o.zip) { headers["content-type"] = "application/zip"; payload = o.zip; } else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  return api(new Request(`http://api.test/api/v2${path}`, { method, headers, ...(payload ? { body: payload } : {}) })) as Promise<R>;
}
async function importSkill(name: string, sub = "editor") { const r = await call(sub, "POST", "/skills/imports", undefined, { zip: makeZip([{ name: `${name}/SKILL.md`, data: MD(name) }]) }); return { r, j: await r.json() }; }

describe("v2.2 API: import → approve → activate over HTTP (T-07, T-08, T-25)", () => {
  let version = ""; let req: { requestId: string; targetDigest: string; permissionDigest: string };
  test("authentication first; idempotency key required; wrong media type refused", async () => {
    expect((await call(null, "GET", "/skills")).status).toBe(401);
    expect((await call("editor", "POST", "/skills/imports", undefined, { key: null, zip: makeZip([{ name: "a/SKILL.md", data: "x" }]) })).status).toBe(400);
    expect((await call("editor", "POST", "/skills/imports", { not: "zip" })).status).toBe(415);
    expect((await call("viewer", "GET", "/skills")).status).toBe(403);
    expect((await call("editor", "GET", "/nope")).status).toBe(404);
    expect((await call("editor", "DELETE", "/skills")).status).toBe(405);
  });
  test("a valid archive is staged in quarantine (202), validated, and NOT active; hostile archives get 422", async () => {
    const { r, j } = await importSkill("story-writer");
    expect(r.status).toBe(202); expect(j).toMatchObject({ state: "validated", ok: true, duplicate: false });
    version = j.versionId;
    const dup = await importSkill("story-writer"); expect(dup.j).toMatchObject({ duplicate: true, versionId: version });
    const evil = await call("editor", "POST", "/skills/imports", undefined, { zip: makeZip([{ name: "../../etc/x", data: "x" }]) });
    expect(evil.status).toBe(422); expect((await evil.json()).type).toMatch(/archive-traversal/);
    const list = await (await call("editor", "GET", "/skills")).json();
    expect(list.items.find((i: { id: string }) => i.id === version)).toMatchObject({ state: "validated", active: false });
  });
  test("RBAC: only operators/admins request approvals; only approvers/admins/security officers decide; editors do neither", async () => {
    expect((await call("editor", "POST", "/approvals", { versionId: version, operation: "activate" })).status).toBe(403);
    const ok = await call("operator", "POST", "/approvals", { versionId: version, operation: "activate" });
    expect(ok.status).toBe(201); req = await ok.json();
    expect((await call("operator", "POST", `/approvals/${req.requestId}/decision`, { decision: "approved", digest: req.targetDigest, permissionDigest: req.permissionDigest })).status).toBe(403);
    expect((await call("editor", "POST", `/approvals/${req.requestId}/decision`, { decision: "approved", digest: req.targetDigest, permissionDigest: req.permissionDigest })).status).toBe(403);
  });
  test("a decision naming a different digest gets 412; another tenant's approver gets 404 (indistinguishable from absent)", async () => {
    const wrong = await call("approver", "POST", `/approvals/${req.requestId}/decision`, { decision: "approved", digest: "sha256:" + "0".repeat(64), permissionDigest: req.permissionDigest });
    expect(wrong.status).toBe(412);
    expect((await call("approverB", "POST", `/approvals/${req.requestId}/decision`, { decision: "approved", digest: req.targetDigest, permissionDigest: req.permissionDigest })).status).toBe(404);
  });
  test("no self-approval: an admin who requested cannot decide their own request (403)", async () => {
    const { j } = await importSkill("self-approve-skill");
    const mine = await (await call("admin", "POST", "/approvals", { versionId: j.versionId, operation: "activate" })).json();
    const self = await call("admin", "POST", `/approvals/${mine.requestId}/decision`, { decision: "approved", digest: mine.targetDigest, permissionDigest: mine.permissionDigest });
    expect(self.status).toBe(403); expect((await self.json()).detail).toMatch(/independent human/);
  });
  test("activation needs a decision (409), is CAS-checked (409 stale), then succeeds atomically and is idempotent", async () => {
    const early = await call("operator", "POST", "/activations", { approvalId: req.requestId, expectedRevision: 0 });
    expect(early.status).toBeGreaterThanOrEqual(400); // no decision yet
    expect((await call("approver", "POST", `/approvals/${req.requestId}/decision`, { decision: "approved", digest: req.targetDigest, permissionDigest: req.permissionDigest })).status).toBe(200);
    expect((await call("approver", "POST", `/approvals/${req.requestId}/decision`, { decision: "approved", digest: req.targetDigest, permissionDigest: req.permissionDigest })).status).toBe(409); // already decided
    expect((await call("operator", "POST", "/activations", { approvalId: req.requestId, expectedRevision: 5 })).status).toBe(409); // stale revision
    const key = "activate-once-1234";
    const act = await call("operator", "POST", "/activations", { approvalId: req.requestId, expectedRevision: 0 }, { key });
    expect(act.status).toBe(200); expect(await act.json()).toMatchObject({ revision: 1, versionId: version, replayed: false });
    const replay = await call("operator", "POST", "/activations", { approvalId: req.requestId, expectedRevision: 0 }, { key });
    expect(replay.status).toBe(200); expect(replay.headers.get("idempotency-replayed")).toBe("true");
    const again = await call("operator", "POST", "/activations", { approvalId: req.requestId, expectedRevision: 1 });
    expect(again.status).toBe(409); // single use
    const list = await (await call("editor", "GET", "/skills")).json();
    expect(list.items.find((i: { id: string }) => i.id === version)).toMatchObject({ state: "approved", active: true });
  });
  test("tenant isolation: org B sees none of org A's skills, cannot activate with A's approval, and matching only sees its own pool", async () => {
    expect((await (await call("approverB", "GET", "/skills")).json()).items).toEqual([]);
    expect((await call("operatorB", "POST", "/activations", { approvalId: req.requestId, expectedRevision: 0 })).status).toBe(404);
    const body = { role: "pm.user_story", domain: "product", desiredArtifacts: ["user stories"], runtime: "local_model", autonomy: "draft", granted: { tools: ["Read"], network: [], writeScopes: [], dataClasses: [] } };
    const a = await (await call("editor", "POST", "/capabilities/match", body)).json();
    expect(a.status).toBe("blocked"); expect(a.rejected[0]).toMatchObject({ code: "UNQUALIFIED" }); // approved+active but no role qualification -> not routable
    const b = await (await call("approverB", "POST", "/capabilities/match", body)).json();
    expect(b).toMatchObject({ status: "blocked", rejected: [] });
    expect((await call("editor", "POST", "/capabilities/match", { ...body, granted: "all" })).status).toBe(422);
  });
  test("emergency disable turns the version off; the registry reports it inactive", async () => {
    expect((await call("editor", "POST", "/skills/disable", { kind: "skill", slug: "story-writer", reason: "x" })).status).toBe(403);
    const r = await call("operator", "POST", "/skills/disable", { kind: "skill", slug: "story-writer", reason: "incident 42" });
    expect(r.status).toBe(200);
    const list = await (await call("editor", "GET", "/skills")).json();
    expect(list.items.find((i: { id: string }) => i.id === version)).toMatchObject({ active: false });
  });
  test("improvement backlog is redacted and experiments only stage; nothing is activated", async () => {
    expect((await call("viewer", "GET", "/improvements")).status).toBe(403);
    const list = await call("editor", "GET", "/improvements"); expect(list.status).toBe(200); expect((await list.json()).items).toEqual([]);
    expect((await call("operator", "POST", "/improvements/00000000-0000-0000-0000-000000000000/experiment")).status).toBe(404);
  });
});

describe("v2.2 PM artifacts over HTTP: draft → review → independent approval → engineering handoff (T-17, T-18, T-28, T-30 gate)", () => {
  let repo = ""; let art: { id: string; digest: string };
  const prd = { problem: "bulk invite", stories: [{ title: "Invite via CSV", body: "As an admin..." }] };
  test("drafts require provenance; an invented-participant meeting is 422", async () => {
    repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${orgA}, 'github', 'pm1', 'o', 'n') RETURNING id`)[0]!.id;
    const bad = await call("editor", "POST", "/product/workspaces/pm/artifacts", { kind: "meeting", title: "Sync", body: { summary: "s", participants: ["Nobody Real"], decisions: [], actions: [] }, sourceIds: ["t1"], authorizedParticipants: ["Ana Silva"] });
    expect(bad.status).toBe(422); expect((await bad.json()).type).toMatch(/invented_participant/);
    expect((await call("viewer", "POST", "/product/workspaces/pm/artifacts", { kind: "prd", title: "x", body: {}, sourceIds: [] })).status).toBe(403);
    const ok = await call("editor", "POST", "/product/workspaces/pm/artifacts", { kind: "prd", title: "Bulk invite", body: prd, sourceIds: ["S1"], assumptions: ["a"], openQuestions: ["q"] });
    expect(ok.status).toBe(201); art = await ok.json(); expect(art.digest).toMatch(/^sha256:/);
  });
  test("handoff before approval is 423; approval needs the exact digest and an approver (not the author)", async () => {
    expect((await call("operator", "POST", `/product/artifacts/${art.id}/handoff`, { repositoryId: repo })).status).toBe(423);
    expect((await call("editor", "POST", `/product/artifacts/${art.id}/review`)).status).toBe(200);
    expect((await call("editor", "POST", `/product/artifacts/${art.id}/approve`, { digest: art.digest })).status).toBe(403); // editors cannot approve
    expect((await call("approver", "POST", `/product/artifacts/${art.id}/approve`, { digest: "sha256:" + "0".repeat(64) })).status).toBe(412);
    expect((await call("approverB", "POST", `/product/artifacts/${art.id}/approve`, { digest: art.digest })).status).toBe(404); // other tenant
    const ok = await call("approver", "POST", `/product/artifacts/${art.id}/approve`, { digest: art.digest });
    expect(ok.status).toBe(200); expect(await ok.json()).toMatchObject({ state: "approved" });
  });
  test("after approval the artifact enters the EXISTING engineering intake as a job; a second handoff is deduplicated; other tenants get 404", async () => {
    const jobsBefore = Number((await db.sql`SELECT count(*) AS n FROM jobs`)[0]!.n);
    const r = await call("operator", "POST", `/product/artifacts/${art.id}/handoff`, { repositoryId: repo });
    expect(r.status).toBe(202); const j = await r.json();
    expect(j).toMatchObject({ state: expect.any(String), artifactDigest: art.digest });
    expect(Number((await db.sql`SELECT count(*) AS n FROM jobs`)[0]!.n)).toBe(jobsBefore + 1);
    const [rq] = await db.sql`SELECT source_external_id, title FROM requests WHERE repository_id = ${repo}`;
    expect(rq!.source_external_id).toBe(`product-artifact:${art.id}:${art.digest.slice(7, 23)}`);
    const again = await call("operator", "POST", `/product/artifacts/${art.id}/handoff`, { repositoryId: repo });
    expect(again.status).toBe(409); expect(Number((await db.sql`SELECT count(*) AS n FROM jobs`)[0]!.n)).toBe(jobsBefore + 1);
    expect((await call("operatorB", "POST", `/product/artifacts/${art.id}/handoff`, { repositoryId: repo })).status).toBe(404);
  });
});
