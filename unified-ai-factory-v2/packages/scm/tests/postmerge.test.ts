import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../db/src/testing";
import { watchPostmerge, type CiState } from "../src/postmerge";

let db: Awaited<ReturnType<typeof createTestDb>>; let repo = ""; let n = 0;
beforeAll(async () => {
  db = await createTestDb();
  const [org] = await db.sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`;
  repo = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org!.id}, 'github', 'r', 'o', 'n') RETURNING id`)[0]!.id;
});
afterAll(async () => { await db.drop(); });
async function monitored(sha: string | null, ageMin = 1): Promise<string> {
  const [rq] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description) VALUES (${repo}, 'api', ${"p" + n++}, 'x', 'feature', 't', 'd') RETURNING id`;
  const [j] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${rq!.id}, ${repo}) RETURNING id`;
  await db.sql`ALTER TABLE jobs DISABLE TRIGGER USER`; // test setup only: place the job directly in the monitored state
  await db.sql`UPDATE jobs SET state = 'POSTMERGE_MONITOR', updated_at = now() - ${ageMin + " minutes"}::interval WHERE id = ${j!.id}`;
  await db.sql`ALTER TABLE jobs ENABLE TRIGGER USER`;
  if (sha) await db.sql`INSERT INTO merge_intents (job_id, repository_id, pr_number, head_sha, status, github_merge_sha) VALUES (${j!.id}, ${repo}, ${n}, ${sha}, 'merged', ${sha})`;
  return j!.id;
}
const run = async (ci: (sha: string) => CiState | "throw", timeoutMinutes = 60) => {
  const calls: Array<{ id: string; ok: boolean; detail: string }> = [];
  const r = await watchPostmerge(db.sql, { timeoutMinutes, ci: { combinedStatus: async (_r, sha) => { const s = ci(sha); if (s === "throw") throw new Error("api down"); return s; } }, coordinator: { recordPostmerge: async (id, x) => { calls.push({ id, ...x }); await db.sql`ALTER TABLE jobs DISABLE TRIGGER USER`; await db.sql`UPDATE jobs SET state = ${x.ok ? "DONE" : "FAILED"} WHERE id = ${id}`; await db.sql`ALTER TABLE jobs ENABLE TRIGGER USER`; } } });
  return { r, calls };
};

describe("post-merge CI watcher (ACT-07)", () => {
  test("green records a healthy result once; the job is not examined again", async () => {
    const id = await monitored("a".repeat(40));
    const { r, calls } = await run(() => "success");
    expect(r.healthy).toContain(id); expect(calls.find((c) => c.id === id)).toMatchObject({ ok: true });
    expect((await run(() => "success")).calls.find((c) => c.id === id)).toBeUndefined();
  });
  test("red records a failed post-merge; pending within the window waits; unavailable never counts as healthy", async () => {
    const red = await monitored("b".repeat(40)); const pend = await monitored("c".repeat(40)); const down = await monitored("d".repeat(40));
    const { r, calls } = await run((sha) => (sha[0] === "b" ? "failure" : sha[0] === "c" ? "pending" : "throw"));
    expect(calls.find((c) => c.id === red)).toMatchObject({ ok: false });
    expect(r.waiting).toEqual(expect.arrayContaining([pend, down])); expect(calls.some((c) => c.id === pend || c.id === down)).toBe(false);
  });
  test("no conclusive status past the timeout fails closed (also when the merge sha is unknown)", async () => {
    const stale = await monitored("e".repeat(40), 120); const nosha = await monitored(null, 120);
    const { calls } = await run(() => "pending", 60);
    expect(calls.find((c) => c.id === stale)).toMatchObject({ ok: false, detail: expect.stringMatching(/no conclusive CI status/) });
    expect(calls.find((c) => c.id === nosha)).toMatchObject({ ok: false });
  });
});
