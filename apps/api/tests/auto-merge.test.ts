import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AutoMergeController } from "@factory/orchestrator";
import { loadThresholds, validatePilotReport } from "@factory/evals";
import { goodPilot } from "../../../packages/evals/tests/pilot-fixture";
import { createTestDb } from "../../../packages/db/src/testing";
import { createApi, ROLES } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
let api: (r: Request) => Promise<Response>;
let ctl: AutoMergeController;
let orgA = ""; let repoA = ""; let jobId = ""; let n = 0;
const thresholds = loadThresholds(join(import.meta.dir, "../../../config"));

beforeAll(async () => {
  db = await createTestDb();
  orgA = (await db.sql`INSERT INTO organizations (name) VALUES ('A') RETURNING id`)[0]!.id;
  const orgB = (await db.sql`INSERT INTO organizations (name) VALUES ('B') RETURNING id`)[0]!.id;
  for (const r of ROLES) await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${orgA}, ${"a-" + r}, ${r})`;
  await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${orgB}, 'b-admin', 'admin')`;
  repoA = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${orgA}, 'github', '1', 'o', 'a') RETURNING id`)[0]!.id;
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repoA}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  jobId = (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repoA}) RETURNING id`)[0]!.id;
  ctl = new AutoMergeController(db.sql, (r) => validatePilotReport(r, thresholds));
  api = createApi({ sql: db.sql, autoMerge: ctl, authenticator: { authenticate: async (r) => { const s = r.headers.get("x-test-subject"); return s ? { subject: s, via: "bearer" as const } : null; } } });
});
afterAll(async () => { await db.drop(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TR = Omit<Response, "json"> & { json(): Promise<any> };
const call = (method: string, path: string, who: string, body?: unknown): Promise<TR> =>
  api(new Request(`http://api.test/api/v1${path}`, { method, headers: { "x-test-subject": who, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));

describe("auto-merge controls over HTTP", () => {
  test("status is readable by operators/approvers/admins; the kill switch starts ENGAGED", async () => {
    for (const role of ROLES) expect((await call("GET", "/auto-merge", "a-" + role)).status, role).toBe(["viewer", "editor"].includes(role) ? 403 : 200);
    const st = await (await call("GET", "/auto-merge", "a-operator")).json();
    expect(st.global.killSwitch).toBe(true);
    expect(st.repositories).toEqual([]);
    expect((await call("GET", "/auto-merge", "b-admin")).status).toBe(200);
  });

  test("any operator can ENGAGE the kill switch; only admin/security officer can DISARM or configure repositories", async () => {
    expect((await call("POST", "/auto-merge/disarm", "a-operator", { reason: "go" })).status).toBe(403);
    expect((await call("POST", "/auto-merge/disarm", "a-approver", { reason: "go" })).status).toBe(403);
    expect((await call("POST", "/auto-merge/disarm", "a-admin", { reason: "pilot passed, signed off" })).status).toBe(202);
    expect((await (await call("GET", "/auto-merge", "a-operator")).json()).global.killSwitch).toBe(false);
    expect((await call("POST", "/auto-merge/kill", "a-viewer", { reason: "x" })).status).toBe(403);
    expect((await call("POST", "/auto-merge/kill", "a-operator", { reason: "" })).status).toBe(422);
    expect((await call("POST", "/auto-merge/kill", "a-operator", { reason: "incident" })).status).toBe(202);
    expect((await (await call("GET", "/auto-merge", "a-operator")).json()).global).toMatchObject({ killSwitch: true, reason: "incident", setBy: expect.any(String) });
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE action IN ('auto_merge.kill','auto_merge.disarm')`)[0]!.c).toBe(2); // one disarm + one kill; refused attempts leave no audit row
  });

  test("enabling a repository needs a valid signed pilot report (422 with reasons otherwise), admin/security officer only, within the caller's organisation", async () => {
    const path = `/repositories/${repoA}/auto-merge`;
    expect((await call("POST", path, "a-operator", { action: "enable", reason: "x", pilotReport: goodPilot() })).status).toBe(403);
    const bad = goodPilot(); bad.pilot.escapedDefects = 1;
    const r = await call("POST", path, "a-admin", { action: "enable", reason: "rollout", pilotReport: bad });
    expect(r.status).toBe(422);
    expect((await r.json()).reasons.join(" ")).toMatch(/escaped defects/);
    expect((await call("POST", path, "a-admin", { action: "enable", reason: "rollout", pilotReport: { nope: 1 } })).status).toBe(422);
    expect((await call("POST", path, "b-admin", { action: "enable", reason: "rollout", pilotReport: goodPilot() })).status).toBe(404); // other tenant
    expect((await call("POST", path, "a-admin", { action: "enable", reason: "rollout", pilotReport: goodPilot(), allowedPathGlobs: ["**"] })).status).toBe(422);
    expect((await call("POST", path, "a-admin", { action: "nonsense", reason: "x" })).status).toBe(422);
    const ok = await call("POST", path, "a-security_officer", { action: "enable", reason: "rollout approved", pilotReport: goodPilot(), allowedPathGlobs: ["docs/**"], maxPerDay: 2, cooldownMinutes: 15 });
    expect(ok.status).toBe(202);
    expect((await ok.json()).signoffDigest).toMatch(/^sha256:/);
    const st = await (await call("GET", "/auto-merge", "a-admin")).json();
    expect(st.repositories[0]).toMatchObject({ enabled: true, maxPerDay: 2, cooldownMinutes: 15, allowedPathGlobs: ["docs/**"], tripped: false });
    expect(await ((await call("POST", path, "a-admin", { action: "disable", reason: "pause" })).json())).toEqual({ enabled: false });
    expect(await ((await call("POST", path, "a-admin", { action: "rearm", reason: "ok" })).json())).toEqual({ tripped: false });
    expect((await call("POST", "/repositories/not-a-uuid/auto-merge", "a-admin", { action: "disable", reason: "x" })).status).toBe(404);
  });

  test("an operator or approver can place ONE job on hold (human approval required); viewers cannot; other tenants get 404", async () => {
    expect((await call("POST", `/jobs/${jobId}/hold-auto-merge`, "a-viewer", { reason: "x" })).status).toBe(403);
    expect((await call("POST", `/jobs/${jobId}/hold-auto-merge`, "a-approver", { reason: "" })).status).toBe(422);
    expect((await call("POST", `/jobs/${jobId}/hold-auto-merge`, "b-admin", { reason: "x" })).status).toBe(404);
    expect((await call("POST", `/jobs/${jobId}/hold-auto-merge`, "a-approver", { reason: "I want to read this myself" })).status).toBe(202);
    expect((await db.sql`SELECT count(*)::int AS c FROM events WHERE job_id=${jobId} AND type='auto_merge.hold'`)[0]!.c).toBe(1);
    const gate = await ctl.evaluate({ id: jobId, repositoryId: repoA, headSha: "a".repeat(40), risk: "LOW", changedFiles: ["docs/a.md"] });
    expect(gate.reasons.join(" ")).toMatch(/operator placed this job on hold/);
  });

  test("when the controller is not configured the endpoints say so instead of failing open", async () => {
    const bare = createApi({ sql: db.sql, authenticator: { authenticate: async () => ({ subject: "a-admin", via: "bearer" as const }) } });
    const r = await bare(new Request("http://api.test/api/v1/auto-merge"));
    expect(r.status).toBe(503);
  });
});
