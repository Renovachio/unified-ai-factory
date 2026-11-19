import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../packages/db/src/testing";
import { createApi, ROLES, PERMISSIONS } from "../src/index";

const H = "a".repeat(40); const B = "b".repeat(40);
const POLICY = "sha256:" + "c".repeat(64);
let db: Awaited<ReturnType<typeof createTestDb>>;
let api: (r: Request) => Promise<Response>;
let orgA = ""; let orgB = ""; let repoA = ""; let n = 0;
const U: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
  orgA = (await db.sql`INSERT INTO organizations (name) VALUES ('A') RETURNING id`)[0]!.id;
  orgB = (await db.sql`INSERT INTO organizations (name) VALUES ('B') RETURNING id`)[0]!.id;
  for (const r of ROLES) U[r] = (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${orgA}, ${"a-" + r}, ${r}) RETURNING id`)[0]!.id;
  await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${orgB}, 'b-approver', 'approver')`;
  repoA = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${orgA}, 'github', '1', 'o', 'a') RETURNING id`)[0]!.id;
  api = createApi({
    sql: db.sql, review: { requiredRoles: async () => ["code"] },
    authenticator: { authenticate: async (req) => { const s = req.headers.get("x-test-subject"); return s ? { subject: s, via: "bearer" as const } : null; } },
  });
});
afterAll(async () => { await db.drop(); });

/** A job parked in AWAITING_HUMAN with a complete evidence binding (head, base, passing gate, policy digest). */
async function parked(opts: { risk?: string; createdBy?: string } = {}) {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repoA}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const id = (await db.sql`INSERT INTO jobs (request_id, repository_id, created_by) VALUES (${req!.id}, ${repoA}, ${opts.createdBy ?? null}) RETURNING id`)[0]!.id as string;
  await db.sql`ALTER TABLE jobs DISABLE TRIGGER jobs_enforce_transition`;
  await db.sql`UPDATE jobs SET state='AWAITING_HUMAN', version=9, head_sha=${H}, base_sha=${B}, policy_digest=${POLICY}, risk=${opts.risk ?? "MEDIUM"} WHERE id=${id}`;
  await db.sql`ALTER TABLE jobs ENABLE TRIGGER jobs_enforce_transition`;
  await db.sql`INSERT INTO gate_results (job_id, head_sha, base_sha, gate_config_digest, verdict, results_digest) VALUES (${id}, ${H}, ${B}, 'sha256:g', 'pass', 'sha256:r')`;
  return id;
}
const body = (over: Record<string, unknown> = {}) => ({ decision: "approve", headSha: H, baseSha: B, policyDigest: POLICY, expectedVersion: 9, ...over });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TR = Omit<Response, "json"> & { json(): Promise<any> };
const post = (id: string, who: string, b: unknown, key: string | null = crypto.randomUUID()): Promise<TR> =>
  api(new Request(`http://api.test/api/v1/jobs/${id}/decisions`, { method: "POST", headers: { "content-type": "application/json", "x-test-subject": who, ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(b) }));

describe("POST /jobs/:id/decisions", () => {
  test("only approver/admin may decide; everyone else is 403", async () => {
    const id = await parked();
    for (const role of ROLES) {
      if (PERMISSIONS[role].has("job:decide")) continue;
      expect((await post(id, "a-" + role, body())).status, role).toBe(403);
    }
    expect((await db.sql`SELECT count(*)::int AS c FROM approvals WHERE job_id=${id}`)[0]!.c).toBe(0);
    const ok = await post(id, "a-approver", body());
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ state: "PREMERGE", version: 10 });
    expect((await post(await parked(), "a-admin", body())).status).toBe(202);
  });
  test("records a decision bound to the exact head/base/policy; persists the full binding; does not merge", async () => {
    const id = await parked();
    const r = await post(id, "a-approver", body());
    const j = await r.json();
    expect(r.headers.get("etag")).toBe('"10"');
    const [a] = await db.sql`SELECT head_sha, base_sha, policy_digest, decision, binding FROM approvals WHERE id=${j.decisionId}`;
    expect(a).toMatchObject({ head_sha: H, base_sha: B, policy_digest: POLICY, decision: "approve" });
    expect(a!.binding).toMatchObject({ headSha: H, baseSha: B, policyDigest: POLICY, gateConfigDigest: "sha256:g" });
    expect((await db.sql`SELECT state FROM jobs WHERE id=${id}`)[0]!.state).toBe("PREMERGE");
    expect((await db.sql`SELECT count(*)::int AS c FROM merge_intents WHERE job_id=${id}`)[0]!.c).toBe(0);
  });
  test("stale evidence / stale version / wrong state / bad bodies are refused and NOTHING is stored", async () => {
    const id = await parked();
    for (const [over, status, code] of [[{ headSha: "d".repeat(40) }, 409, "stale-evidence"], [{ baseSha: "d".repeat(40) }, 409, "stale-evidence"], [{ policyDigest: "sha256:" + "d".repeat(64) }, 409, "stale-evidence"], [{ expectedVersion: 3 }, 409, "version-conflict"], [{ decision: "reject" }, 422, "validation-failed"], [{ extra: 1 }, 422, "validation-failed"], [{ headSha: "nope" }, 422, "validation-failed"], [{ decision: "merge" }, 422, "validation-failed"]] as const) {
      const r = await post(id, "a-approver", body(over));
      expect(r.status, JSON.stringify(over)).toBe(status);
      expect((await r.json()).type).toContain(code);
    }
    expect((await db.sql`SELECT count(*)::int AS c FROM approvals WHERE job_id=${id}`)[0]!.c).toBe(0);
    expect((await post(id, "a-approver", body(), null)).status).toBe(400); // Idempotency-Key required
    await post(id, "a-approver", body());
    expect((await (await post(id, "a-approver", body({ expectedVersion: 10 }))).json()).type).toContain("not-awaiting-approval");
  });
  test("idempotency: same key + body replays; same key + different body is 409", async () => {
    const id = await parked();
    const key = crypto.randomUUID();
    const a = await post(id, "a-approver", body(), key);
    const b = await post(id, "a-approver", body(), key);
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect((await b.json()).decisionId).toBe((await a.json()).decisionId);
    expect((await db.sql`SELECT count(*)::int AS c FROM approvals WHERE job_id=${id}`)[0]!.c).toBe(1);
    expect((await post(id, "a-approver", body({ decision: "reject", reason: "x" }), key)).status).toBe(409);
  });
  test("reject needs a reason and ends the job; rework sends it back with the human's feedback", async () => {
    const r1 = await parked();
    expect((await post(r1, "a-approver", body({ decision: "reject" }))).status).toBe(422);
    expect(await (await post(r1, "a-approver", body({ decision: "reject", reason: "not wanted" }))).json()).toMatchObject({ state: "REJECTED" });
    const r2 = await parked();
    expect(await (await post(r2, "a-approver", body({ decision: "rework", reason: "handle empty input" }))).json()).toMatchObject({ state: "REWORK" });
    expect((await db.sql`SELECT payload_redacted FROM events WHERE job_id=${r2} AND type='human.changes_requested'`)[0]!.payload_redacted).toMatchObject({ message: "handle empty input" });
  });
  test("separation of duties and tenancy: the requester cannot self-approve HIGH; another organisation sees 404", async () => {
    const high = await parked({ risk: "HIGH", createdBy: U.approver as string });
    expect((await post(high, "a-approver", body())).status).toBe(403);
    expect((await post(high, "a-admin", body())).status).toBe(202); // a different approver may
    const low = await parked({ createdBy: U.approver as string });
    expect((await post(low, "a-approver", body())).status).toBe(202); // below HIGH the requester may approve in this policy
    const other = await parked();
    expect((await post(other, "b-approver", body())).status).toBe(404);
    expect((await db.sql`SELECT count(*)::int AS c FROM approvals WHERE job_id=${other}`)[0]!.c).toBe(0);
  });
  test("every decision is audited", async () => {
    const id = await parked();
    await post(id, "a-approver", body());
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE resource=${"job:" + id} AND action='approval.approve'`)[0]!.c).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS c FROM events WHERE job_id=${id} AND type='approval.recorded'`)[0]!.c).toBe(1);
  });
});
