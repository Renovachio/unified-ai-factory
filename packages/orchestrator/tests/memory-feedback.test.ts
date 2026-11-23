import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../db/src/client";
import { createTestDb } from "../../db/src/testing";
import { approveMemory, type Actor, proposeMemory, recordRetrievalFeedback, setTelemetryConsent, type SignalSink } from "@factory/memory";
import { digestOf } from "@factory/telemetry";
import { feedbackWithSignals, retryFeedbackSignals } from "../src/memory-feedback";

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let control: ReturnType<typeof connect>;
let dir = "";
let org = "", projA = "", viewer = "", approver = "", author = "", jobId = "", memoryId = "";
const ACL = digestOf({ acl: "orchestrator-feedback" });
const A = (u: string): Actor => ({ organizationId: org, userId: u });
const CLAIM = "Export files are signed with the finance key";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-fb-"));
  db = await createTestDb();
  const sql = db.sql;
  org = (await sql`INSERT INTO organizations (name) VALUES ('FB') RETURNING id`)[0]!.id as string;
  const u = async (s: string, r: string) => (await sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org}, ${s}, ${r}) RETURNING id`)[0]!.id as string;
  viewer = await u("v", "viewer");
  approver = await u("a", "approver");
  author = await u("e", "editor");
  projA = (await sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${org}, 'github', 'fbp', 'o', 'a') RETURNING id`)[0]!.id as string;
  const [req] = await sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description)
    VALUES (${projA}, 'api', 'fbr', 'sha256:x', 'feature', 't', 'd') RETURNING id`;
  jobId = (await sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${projA}) RETURNING id`)[0]!.id as string;
  const buf = Buffer.from("feedback orchestrator source");
  const hex = createHash("sha256").update(buf).digest("hex");
  writeFileSync(join(dir, hex), buf);
  const [art] = await sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${jobId}, 'spec', ${"sha256:" + hex}, ${"file://" + join(dir, hex)}, ${buf.length}, 'clean') RETURNING id`;
  const src = [{ kind: "artifact" as const, id: art!.id as string, digest: "sha256:" + hex, extractionMethod: "user_statement" as const, aclDigest: ACL }];
  const p = await proposeMemory(sql, A(author), { projectId: projA, kind: "fact", claim: CLAIM, sources: src });
  await approveMemory(sql, A(approver), projA, p.id);
  memoryId = p.id;
  // The app's control connection: the role that writes memory feedback and SAI-11 signals in production.
  await sql.unsafe("ALTER ROLE factory_control LOGIN");
  const cu = new URL(db.url);
  cu.username = "factory_control";
  control = connect(cu.toString());
});
afterAll(async () => {
  await control.end();
  await db.sql.unsafe("ALTER ROLE factory_control NOLOGIN");
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

const signalCount = async () => (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM improvement_signals WHERE organization_id = ${org}`)[0]!.n;

describe("memory feedback to SAI-11, as the control role (MEM-06)", () => {
  test("with consent, a wrong verdict writes one SAI-11 signal through the control role, in the project's own workspace, with no claim text", async () => {
    await setTelemetryConsent(db.sql, A(approver), projA, true, "pilot on");
    const before = await signalCount();
    const r = await feedbackWithSignals(control, A(viewer), projA, { memoryId, verdict: "wrong" });
    expect(r.signalState).toBe("sent");
    expect((await signalCount()) - before).toBe(1);
    const [s] = await db.sql<{ kind: string; workspace_id: string; intent_key: string; evidence_digest: string }[]>`SELECT kind, workspace_id, intent_key, evidence_digest FROM improvement_signals WHERE organization_id = ${org} ORDER BY occurred_at DESC LIMIT 1`;
    expect(s!.kind).toBe("low_quality");
    expect(s!.workspace_id).toBe(projA);
    expect(s!.intent_key).toBe("fact memory retrieval");
    expect(JSON.stringify(s)).not.toMatch(/finance|signed|export/i);
    const [mem] = await db.sql<{ status: string }[]>`SELECT status FROM memory_records WHERE id = ${memoryId}`;
    expect(mem!.status).toBe("approved");
  });

  test("without consent, nothing reaches SAI-11 and the verdict is still kept", async () => {
    await setTelemetryConsent(db.sql, A(approver), projA, false, "pilot off");
    const before = await signalCount();
    const r = await feedbackWithSignals(control, A(viewer), projA, { memoryId, verdict: "stale" });
    expect(r.signalState).toBe("not_requested");
    expect(await signalCount()).toBe(before);
  });

  test("an unknown memory is refused before any signal is sent", async () => {
    await setTelemetryConsent(db.sql, A(approver), projA, true, "pilot on");
    const before = await signalCount();
    await expect(feedbackWithSignals(control, A(viewer), projA, { memoryId: "00000000-0000-4000-8000-000000000000", verdict: "wrong" })).rejects.toThrow();
    expect(await signalCount()).toBe(before);
  });
  test("a signal that fails is retried through the control role into the real intake, once; a second retry has nothing to do", async () => {
    await setTelemetryConsent(db.sql, A(approver), projA, true, "pilot on");
    const failing: SignalSink = async (_s, q) => { await q`SELECT * FROM table_that_does_not_exist`; };
    const first = await recordRetrievalFeedback(control, A(viewer), projA, { memoryId, verdict: "missing" }, failing);
    expect(first.signalState).toBe("failed");
    const before = await signalCount();
    const rep = await retryFeedbackSignals(control, A(viewer), projA);
    expect(rep).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect((await signalCount()) - before).toBe(1);
    expect(await retryFeedbackSignals(control, A(viewer), projA)).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0 });
  });
});
