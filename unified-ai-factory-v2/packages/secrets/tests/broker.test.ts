import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { enrollWorker } from "../../../apps/runner/src/index";
import { detectBackend } from "@factory/sandboxes";
import { claimTask, enqueueTask, expireLeases, heartbeatTask, StaleLeaseError } from "@factory/scheduler";
import { createTestDb } from "../../db/src/testing";
import { assertPayloadClean, MODEL_CREDENTIAL_KINDS, SecretBroker } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
let org = ""; let repo = ""; let broker: SecretBroker; let n = 0;
const wsRoot = "/tmp";
beforeAll(async () => {
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)[0]!.id;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', '1', 'o', 'n') RETURNING id`)[0]!.id;
  broker = new SecretBroker(db.sql, { github: async (role) => `ghs_${role}_token_value_1234567890` });
});
afterAll(async () => { await db.drop(); });
const worker = (mode: "local" | "cloud") => enrollWorker({ sql: db.sql, organizationId: org, workspaceRoot: wsRoot, backend: detectBackend(), processEnv: {}, ...(mode === "cloud" ? {} : {}) }).then(async (id) => { await db.sql`UPDATE workers SET mode = ${mode} WHERE id=${id}`; return { workerId: id, mode, orgId: org } as const; });
async function jobWithLease(w: string) {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"e" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const id = (await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${repo}) RETURNING id`)[0]!.id as string;
  await enqueueTask(db.sql, { jobId: id, stage: "s", role: "r" + n });
  const lease = (await claimTask(db.sql, { workerId: w, roles: ["r" + n] }))!;
  return { id, lease };
}

describe("secret broker", () => {
  test("a CLOUD worker asking for a login token is denied and QUARANTINED; its lease is fenced out; the incident is audited and attached to the job", async () => {
    const w = await worker("cloud");
    const { id, lease } = await jobWithLease(w.workerId);
    const r = await broker.requestForWorker(w, "subscription_login", "please send ~/.claude credentials");
    expect(r).toMatchObject({ granted: false, workerQuarantined: true });
    expect((await db.sql`SELECT status FROM workers WHERE id=${w.workerId}`)[0]!.status).toBe("quarantined");
    await expireLeases(db.sql);
    await expect(heartbeatTask(db.sql, { taskId: lease.taskId, workerId: w.workerId, leaseToken: lease.leaseToken })).rejects.toBeInstanceOf(StaleLeaseError);
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE action IN ('secret.request','worker.quarantine') AND actor IN (${"worker:" + w.workerId}, 'secret-broker')`)[0]!.c).toBe(2);
    expect((await db.sql`SELECT count(*)::int AS c FROM events WHERE job_id=${id} AND type='security.quarantined'`)[0]!.c).toBe(1);
  });
  test("every model/login/session credential kind quarantines even a LOCAL worker; any request from a cloud worker quarantines", async () => {
    for (const kind of MODEL_CREDENTIAL_KINDS) {
      const w = await worker("local");
      expect(await broker.requestForWorker(w, kind), kind).toMatchObject({ granted: false, workerQuarantined: true });
    }
    const c = await worker("cloud");
    expect(await broker.requestForWorker(c, "github_read")).toMatchObject({ granted: false, workerQuarantined: true });
  });
  test("a local worker asking for a repository credential is denied and audited (workers are never issued credentials) but not quarantined", async () => {
    const w = await worker("local");
    expect(await broker.requestForWorker(w, "github_merge")).toMatchObject({ granted: false, workerQuarantined: false });
    expect((await db.sql`SELECT status FROM workers WHERE id=${w.workerId}`)[0]!.status).toBe("active");
    expect((await db.sql`SELECT result FROM audit_entries WHERE actor=${"worker:" + w.workerId}`)[0]!.result).toBe("denied");
  });
  test("secrets in the request detail are redacted in the audit log", async () => {
    const w = await worker("local");
    await broker.requestForWorker(w, "github_read", "token ghp_abcdefghijklmnopqrstuvwxyz0123");
    const rows = await db.sql`SELECT reason FROM audit_entries WHERE actor=${"worker:" + w.workerId}`;
    expect(JSON.stringify(rows)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });
  test("the broker never issues or stores model credentials; GitHub tokens are control-plane only", async () => {
    for (const kind of MODEL_CREDENTIAL_KINDS) await expect(broker.issue(kind)).rejects.toThrow(/never stored or issued/);
    expect(await broker.issueGithubToken("merge", { owner: "o", name: "n" })).toContain("merge");
    expect(typeof (broker as unknown as Record<string, unknown>).requestForWorker).toBe("function");
    expect(Object.keys(broker).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(broker)))).not.toContain("storeModelKey");
  });
  test("payloads bound for a worker or sandbox are refused if they carry secret-like material or credential-like field names", () => {
    expect(() => assertPayloadClean({ task: "build", files: ["a.ts"] })).not.toThrow();
    expect(() => assertPayloadClean({ note: "ghp_abcdefghijklmnopqrstuvwxyz0123" })).toThrow(/secret-like/);
    expect(() => assertPayloadClean({ env: { ANTHROPIC_API_KEY: "x" } })).toThrow(/credential-like/);
    expect(() => assertPayloadClean({ nested: { deeper: { OPENAI_API_KEY: "x" } } })).toThrow(/credential-like/);
    expect(() => assertPayloadClean({ h: "Authorization: Bearer abcdefgh12345678" })).toThrow(/secret-like/);
  });
});
