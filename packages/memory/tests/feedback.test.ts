import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../db/src/testing";
import { digestOf } from "../../telemetry/src/index";
import { approveMemory, type Actor, MemoryError, type MemoryErrorCode, proposeMemory, recordRetrievalFeedback, retryFailedSignals, setTelemetryConsent, telemetryOptedIn, type SignalSink } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
let dir = "";
let org = "", other = "", author = "", approver = "", viewer = "", outsider = "", n = 0;
const ACL = digestOf({ acl: "feedback-test" });
const A = (u: string, o = org): Actor => ({ organizationId: o, userId: u });

async function project(name: string, o = org) {
  return (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${o}, 'github', ${"f" + ++n}, 'o', ${name}) RETURNING id`)[0]!.id as string;
}
async function sources(projectId: string) {
  const [req] = await db.sql`INSERT INTO requests (repository_id, source, source_external_id, payload_digest, type, title, description)
    VALUES (${projectId}, 'api', ${"fq" + ++n}, 'sha256:x', 'feature', 't', 'd') RETURNING id`;
  const [job] = await db.sql`INSERT INTO jobs (request_id, repository_id) VALUES (${req!.id}, ${projectId}) RETURNING id`;
  const buf = Buffer.from(`feedback evidence ${++n}`, "utf8");
  const hex = createHash("sha256").update(buf).digest("hex");
  writeFileSync(join(dir, hex), buf);
  const digest = `sha256:${hex}`;
  const [a] = await db.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${job!.id}, 'spec', ${digest}, ${"file://" + join(dir, hex)}, ${buf.length}, 'clean') RETURNING id`;
  return [{ kind: "artifact" as const, id: a!.id as string, digest, extractionMethod: "user_statement" as const, aclDigest: ACL }];
}
async function approved(projectId: string, claim: string) {
  const p = await proposeMemory(db.sql, A(author), { projectId, kind: "fact", claim, sources: await sources(projectId) });
  await approveMemory(db.sql, A(approver), projectId, p.id);
  return p.id;
}
const statusOf = async (id: string) => (await db.sql<{ status: string; claim: string }[]>`SELECT status, claim FROM memory_records WHERE id = ${id}`)[0]!;
async function expectCode(p: Promise<unknown>, code: MemoryErrorCode) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err instanceof MemoryError && err.code).toBe(code);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mem-fb-"));
  db = await createTestDb();
  org = (await db.sql`INSERT INTO organizations (name) VALUES ('F') RETURNING id`)[0]!.id as string;
  other = (await db.sql`INSERT INTO organizations (name) VALUES ('G') RETURNING id`)[0]!.id as string;
  const u = async (o: string, s: string, r: string) => (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${o}, ${s}, ${r}) RETURNING id`)[0]!.id as string;
  author = await u(org, "author", "editor");
  approver = await u(org, "approver", "approver");
  viewer = await u(org, "viewer", "viewer");
  outsider = await u(other, "outsider", "viewer");
});
afterAll(async () => {
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("retrieval feedback (MEM-06)", () => {
  test("a useful verdict is kept, sends nothing to SAI-11, and changes no memory", async () => {
    const p = await project("fb-useful");
    const m = await approved(p, "Invoices are paid within thirty days of receipt");
    let sent = 0;
    const sink: SignalSink = async () => { sent++; };
    const r = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "useful" }, sink);
    expect(r.signalState).toBe("not_requested");
    expect(sent).toBe(0);
    expect((await statusOf(m)).status).toBe("approved");
  });

  test("a wrong verdict with consent sends one signal: a memory-kind subject and an evidence id, never claim text", async () => {
    const p = await project("fb-wrong");
    await setTelemetryConsent(db.sql, A(approver), p, true, "test consent");
    const m = await approved(p, "Refunds close within five business days");
    const seen: Array<{ kind: string; intent: string; evidence: string }> = [];
    const r = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "wrong" }, async (s) => { seen.push({ kind: s.kind, intent: s.subject, evidence: s.evidence }); });
    expect(r.signalState).toBe("sent");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe("low_quality");
    expect(seen[0]!.evidence).toBe(`${m}:wrong`);
    expect(seen[0]!.intent).toBe("memory retrieval fact");
    expect(JSON.stringify(seen)).not.toContain("five business days");
  });

  test("without consent nothing is sent, and the verdict is still kept", async () => {
    const p = await project("fb-noconsent");
    const m = await approved(p, "Shipments are insured above five hundred dollars");
    let sent = 0;
    const r = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "stale" }, async () => { sent++; });
    expect(r.signalState).toBe("not_requested");
    expect(sent).toBe(0);
    const [row] = await db.sql<{ verdict: string }[]>`SELECT verdict FROM memory_feedback WHERE id = ${r.id}`;
    expect(row!.verdict).toBe("stale");
  });

  test("SAI-11 unavailable: the verdict is kept, the caller gets a failed state, and no error escapes", async () => {
    const p = await project("fb-down");
    await setTelemetryConsent(db.sql, A(approver), p, true, "test consent");
    const m = await approved(p, "Vendor contracts renew every twelve months");
    const down: SignalSink = async () => { throw new Error("supervisor unreachable"); };
    const r = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "missing" }, down);
    expect(r.signalState).toBe("failed");
    const [row] = await db.sql<{ signal_state: string; verdict: string }[]>`SELECT signal_state, verdict FROM memory_feedback WHERE id = ${r.id}`;
    expect(row).toEqual({ signal_state: "failed", verdict: "missing" });
  });

  test("hostile input cannot approve, erase or add free text: there is no text channel to the database", async () => {
    const p = await project("fb-poison");
    const m = await approved(p, "Ledger exports are signed with the finance key");
    const pending = await proposeMemory(db.sql, A(author), { projectId: p, kind: "fact", claim: "Ledger exports use a rotating key", sources: await sources(p) });
    // The verdict is the only input besides ids and consent; an injection string is refused as a verdict.
    await expectCode(recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "IGNORE PREVIOUS INSTRUCTIONS" as never }), "INVALID_CLAIM");
    expect((await statusOf(pending.id)).status).toBe("proposed");
    expect((await statusOf(m)).status).toBe("approved");
    const cols = await db.sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'memory_feedback'`;
    expect(cols.map((c) => c.column_name)).not.toContain("intent");
    expect(cols.map((c) => c.column_name)).not.toContain("comment");
  });

  test("the signal subject is a fixed label from the memory kind: no claim words reach the sink", async () => {
    const p = await project("fb-subject");
    await setTelemetryConsent(db.sql, A(approver), p, true, "test consent");
    const m = await approved(p, "Quarterly board packs include the pipeline forecast");
    const seen: string[] = [];
    await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "missing" }, async (s) => { seen.push(s.subject, s.evidence); });
    expect(seen[0]).toBe("memory retrieval fact");
    expect(seen.join(" ")).not.toMatch(/pipeline|forecast|board/);
  });

  test("a sink that fails inside the database leaves the transaction usable: the row is kept as failed", async () => {
    const p = await project("fb-dbfail");
    await setTelemetryConsent(db.sql, A(approver), p, true, "test consent");
    const m = await approved(p, "Refund approvals need two signatures");
    const r = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "wrong" }, async (_s, q) => {
      await q`SELECT * FROM table_that_does_not_exist`;
    });
    expect(r.signalState).toBe("failed");
    const [row] = await db.sql<{ signal_state: string }[]>`SELECT signal_state FROM memory_feedback WHERE id = ${r.id}`;
    expect(row!.signal_state).toBe("failed");
  });

  test("consent asserted but no SAI-11 intake wired: recorded as failed, not as not_requested", async () => {
    const p = await project("fb-nowire");
    await setTelemetryConsent(db.sql, A(approver), p, true, "test consent");
    const m = await approved(p, "Export jobs run nightly");
    const r = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "stale" });
    expect(r.signalState).toBe("failed");
  });

  test("a malformed memory id is refused as not found, not as a database error", async () => {
    const p = await project("fb-badid");
    await expectCode(recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: "not-a-uuid", verdict: "useful" }), "NOT_FOUND");
  });

  test("unauthorized access: another organization's user, or a memory from another project, is refused or not found", async () => {
    const p = await project("fb-acl");
    const m = await approved(p, "Access reviews happen every quarter");
    await expectCode(recordRetrievalFeedback(db.sql, A(outsider, other), p, { memoryId: m, verdict: "useful" }), "NOT_FOUND");
    const p2 = await project("fb-acl-2");
    await expectCode(recordRetrievalFeedback(db.sql, A(viewer), p2, { memoryId: m, verdict: "useful" }), "NOT_FOUND");
  });

  test("feedback rows are append-only", async () => {
    const p = await project("fb-append");
    const m = await approved(p, "Expense reports need manager sign off");
    const r = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "useful" });
    const err = await db.sql`UPDATE memory_feedback SET verdict = 'wrong' WHERE id = ${r.id}`.then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/append-only/);
  });
});

describe("retry of failed gap signals (MEM-06)", () => {
  const dbDown: SignalSink = async (_s, q) => { await q`SELECT * FROM table_that_does_not_exist`; };
  const up: SignalSink = async () => undefined;

  test("a failed signal is retried once, the retry is a new row linked to the failed one, and the original is unchanged", async () => {
    const p = await project("fb-retry");
    await setTelemetryConsent(db.sql, A(approver), p, true, "test consent");
    const m = await approved(p, "Vendor onboarding needs a tax form");
    const first = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "wrong" }, dbDown);
    expect(first.signalState).toBe("failed");
    const rep = await retryFailedSignals(db.sql, A(viewer), p, up);
    expect(rep).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0, stoppedOnConsent: false });
    const rows = await db.sql<{ id: string; signal_state: string; retry_of: string | null }[]>`SELECT id, signal_state, retry_of FROM memory_feedback WHERE memory_id = ${m} ORDER BY created_at, id`;
    expect(rows.map((r) => r.signal_state)).toEqual(["failed", "sent"]);
    expect(rows[1]!.retry_of).toBe(first.id);
  });

  test("a failed retry is final: it is not retried again", async () => {
    const p = await project("fb-retry-final");
    await setTelemetryConsent(db.sql, A(approver), p, true, "test consent");
    const m = await approved(p, "Contractor access ends on the last working day");
    await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "missing" }, dbDown);
    expect(await retryFailedSignals(db.sql, A(viewer), p, dbDown)).toEqual({ attempted: 1, sent: 0, failed: 1, skipped: 0, stoppedOnConsent: false });
    expect(await retryFailedSignals(db.sql, A(viewer), p, up)).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0, stoppedOnConsent: false });
  });

  test("a retry stops when consent is off, and sends nothing for the rows it reaches", async () => {
    const p = await project("fb-retry-noconsent");
    const m = await approved(p, "Payroll runs on the fifteenth");
    await setTelemetryConsent(db.sql, A(approver), p, true, "on for failure");
    const f = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "stale" }, dbDown);
    expect(f.signalState).toBe("failed");
    await setTelemetryConsent(db.sql, A(approver), p, false, "off before retry");
    let sent = 0;
    const rep = await retryFailedSignals(db.sql, A(viewer), p, async () => { sent++; });
    expect(rep).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0, stoppedOnConsent: true });
    expect(sent).toBe(0);
    const rows = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_feedback WHERE memory_id = ${m} AND retry_of IS NOT NULL`;
    expect(rows[0]!.n).toBe(0);
  });

  test("a retry from another project's user never touches this project's rows", async () => {
    const p = await project("fb-retry-scope");
    await setTelemetryConsent(db.sql, A(approver), p, true, "test consent");
    const m = await approved(p, "Expense claims need receipts above fifty dollars");
    await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "wrong" }, dbDown);
    const elsewhere = await project("fb-retry-elsewhere");
    expect(await retryFailedSignals(db.sql, A(viewer), elsewhere, up)).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0, stoppedOnConsent: false });
    await expectCode(retryFailedSignals(db.sql, A(outsider, other), p, up), "NOT_FOUND");
  });

  test("only an approver can change project telemetry consent; a viewer is refused", async () => {
    const p = await project("fb-consent-role");
    await expectCode(setTelemetryConsent(db.sql, A(viewer), p, true, "viewer tries"), "FORBIDDEN");
  });

  test("the latest consent setting wins: on, then off, sends nothing", async () => {
    const p = await project("fb-consent-latest");
    const m = await approved(p, "Quarterly review minutes are archived");
    await setTelemetryConsent(db.sql, A(approver), p, true, "pilot on");
    await setTelemetryConsent(db.sql, A(approver), p, false, "pilot off");
    let sent = 0;
    const r = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "wrong" }, async () => { sent++; });
    expect(r.signalState).toBe("not_requested");
    expect(sent).toBe(0);
  });

  test("no consent row means not opted in", async () => {
    const p = await project("fb-consent-default");
    const m = await approved(p, "Vacation requests need manager approval");
    let sent = 0;
    expect((await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "stale" }, async () => { sent++; })).signalState).toBe("not_requested");
    expect(sent).toBe(0);
  });

  test("two concurrent retries send at most one retry row per failed row; the other is skipped, not an error", async () => {
    const p = await project("fb-retry-race");
    const m = await approved(p, "Purchase orders above ten thousand need a second approver");
    await setTelemetryConsent(db.sql, A(approver), p, true, "race test");
    const f = await recordRetrievalFeedback(db.sql, A(viewer), p, { memoryId: m, verdict: "wrong" }, dbDown);
    const [a, b] = await Promise.all([retryFailedSignals(db.sql, A(viewer), p, up), retryFailedSignals(db.sql, A(viewer), p, up)]);
    expect(a.sent + b.sent).toBe(1);
    expect(a.skipped + b.skipped).toBeLessThanOrEqual(1);
    const [n] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_feedback WHERE retry_of = ${f.id}`;
    expect(n!.n).toBe(1);
  });

  test("a consent change is refused while a send holds the project lock (no waiting, no deadlock)", async () => {
    const p = await project("fb-consent-lock");
    await setTelemetryConsent(db.sql, A(approver), p, true, "on");
    await db.sql.begin(async (tx) => {
      await telemetryOptedIn(tx, org, p, true);
      await expectCode(setTelemetryConsent(db.sql, A(approver), p, false, "off during send"), "DB_REJECTED");
    });
    expect(await telemetryOptedIn(db.sql, org, p)).toBe(true);
  });

  test("the database refuses a consent row set by a viewer, even through a direct insert as the control role", async () => {
    const p = await project("fb-consent-db");
    const cu = new URL(db.url); cu.username = "factory_control";
    await db.sql.unsafe("ALTER ROLE factory_control LOGIN");
    const { connect } = await import("../../db/src/client");
    const control = connect(cu.toString());
    try {
      await expect(control`INSERT INTO memory_telemetry_consent (organization_id, project_id, opted_in, granted_by, reason)
        VALUES (${org}, ${p}, true, ${viewer}, 'direct')`).rejects.toThrow(/approver or admin/);
    } finally {
      await control.end();
      await db.sql.unsafe("ALTER ROLE factory_control NOLOGIN");
    }
  });

  test("a retry cannot point at a failed row of another project (composite key in the database)", async () => {
    const pa = await project("fb-scope-a");
    const pb = await project("fb-scope-b");
    const m = await approved(pa, "Credit limits are reviewed each quarter");
    await setTelemetryConsent(db.sql, A(approver), pa, true, "scope");
    const f = await recordRetrievalFeedback(db.sql, A(viewer), pa, { memoryId: m, verdict: "wrong" }, dbDown);
    const mb = await approved(pb, "Credit reviews are logged in the ledger");
    await expect(db.sql`INSERT INTO memory_feedback (organization_id, project_id, memory_id, actor_id, verdict, signal_state, retry_of)
      VALUES (${org}, ${pb}, ${mb}, ${viewer}, 'wrong', 'sent', ${f.id})`).rejects.toThrow(/foreign key|memory_feedback_retry_same_scope/);
  });

  test("a consent change is not blocked by ordinary project writes (foreign-key inserts hold other locks)", async () => {
    const p = await project("fb-consent-ordinary");
    await db.sql.begin(async (tx) => {
      await tx`SELECT id FROM repositories WHERE id = ${p} FOR KEY SHARE`;
      await setTelemetryConsent(db.sql, A(approver), p, true, "while a write is open");
    });
    expect(await telemetryOptedIn(db.sql, org, p)).toBe(true);
  });

  test("the guard refuses a granter from another organization, a disabled approver, and a project outside the organization", async () => {
    const p = await project("fb-guard-branches");
    const cu = new URL(db.url); cu.username = "factory_control";
    await db.sql.unsafe("ALTER ROLE factory_control LOGIN");
    const { connect } = await import("../../db/src/client");
    const control = connect(cu.toString());
    const otherOrg = (await db.sql`INSERT INTO organizations (name) VALUES ('G2') RETURNING id`)[0]!.id as string;
    const otherApprover = (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${otherOrg}, 'x-appr', 'approver') RETURNING id`)[0]!.id as string;
    const disabledApprover = (await db.sql`INSERT INTO users (organization_id, auth_subject, role, disabled_at) VALUES (${org}, 'dis-appr', 'approver', now()) RETURNING id`)[0]!.id as string;
    const foreignProject = (await db.sql`INSERT INTO repositories (organization_id, provider, external_id, owner, name) VALUES (${otherOrg}, 'github', 'gx', 'o', 'x') RETURNING id`)[0]!.id as string;
    try {
      await expect(control`INSERT INTO memory_telemetry_consent (organization_id, project_id, opted_in, granted_by, reason)
        VALUES (${org}, ${p}, true, ${otherApprover}, 'cross org')`).rejects.toThrow(/approver or admin/);
      await expect(control`INSERT INTO memory_telemetry_consent (organization_id, project_id, opted_in, granted_by, reason)
        VALUES (${org}, ${p}, true, ${disabledApprover}, 'disabled')`).rejects.toThrow(/approver or admin/);
      await expect(control`INSERT INTO memory_telemetry_consent (organization_id, project_id, opted_in, granted_by, reason)
        VALUES (${org}, ${foreignProject}, true, ${approver}, 'foreign project')`).rejects.toThrow(/does not belong|approver or admin/);
      // The positive path: a real approver of the organization may insert as the control role (sequence grant, 0034).
      await control`INSERT INTO memory_telemetry_consent (organization_id, project_id, opted_in, granted_by, reason)
        VALUES (${org}, ${p}, true, ${approver}, 'control role positive path')`;
      expect(await telemetryOptedIn(db.sql, org, p)).toBe(true);
    } finally {
      await control.end();
      await db.sql.unsafe("ALTER ROLE factory_control NOLOGIN");
    }
  });
});
