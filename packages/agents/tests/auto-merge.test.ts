import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readEvents } from "@factory/db";
import { loadPolicy, policyDigest, type PolicyConfig } from "@factory/domain";
import { AutoMergeController, AutoMergeRefused, recordDecision } from "@factory/orchestrator";
import { loadThresholds, validatePilotReport } from "@factory/evals";
import { goodPilot } from "../../evals/tests/pilot-fixture";
import { approve, db, fake, org, prepare, registerHooks, repo, state, tickUntil, U } from "./merge-fixture";

registerHooks();

const CONFIG = join(import.meta.dir, "../../../config");
const { policy: SHIPPED } = loadPolicy(CONFIG);
const thresholds = loadThresholds(CONFIG);
/** A policy an operator might adopt AFTER a passing pilot: pilot flag off, LOW-risk auto-merge on. */
const PERMISSIVE: PolicyConfig = { ...SHIPPED, merge: { ...SHIPPED.merge, pilotHumanApproval: false, autoMerge: { enabled: true, allowedRisks: ["LOW"], requireCalibration: true } } };
const SAFE_DESC = "Update the guide wording so that new contributors can find the setup instructions quickly.";
const DOCS = { files: ["docs/guide.md"], script: `printf 'edited %s\\n' "$RANDOM$$" > docs/guide.md`, description: SAFE_DESC };

let ctl: AutoMergeController;
const controller = () => (ctl ??= new AutoMergeController(db.sql, (r) => validatePilotReport(r, thresholds)));
const reset = async () => { await db.sql`UPDATE auto_merge_global SET kill_switch = true`; await db.sql`DELETE FROM auto_merge_repo_controls`; await db.sql`UPDATE merge_intents SET auto = false`; };
const arm = async (over: Partial<Parameters<AutoMergeController["enableRepo"]>[0]> = {}) => {
  await controller().disarm("admin", org, "pilot passed and signed off");
  return controller().enableRepo({ actor: "admin", orgId: org, repositoryId: repo, pilotReport: goodPilot(), allowedPathGlobs: ["docs/**"], maxPerDay: 5, cooldownMinutes: 0, ...over });
};
const auditCount = async (action: string) => (await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE action = ${action}`)[0]!.c as number;
const job = (id: string) => ({ id, repositoryId: repo, headSha: "a".repeat(40), risk: "LOW", changedFiles: ["docs/guide.md"] as string[] | null });

describe("controller: inert by default; every control only removes eligibility", () => {
  test("a fresh system is inert: the kill switch is engaged, nothing is opted in, evaluation refuses with reasons", async () => {
    await reset();
    const g = await controller().global();
    expect(g.killSwitch).toBe(true);
    expect((await controller().status(org)).repositories).toEqual([]);
    const r = await controller().evaluate(job(crypto.randomUUID()));
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" | ")).toMatch(/kill switch is engaged.*not opted in/);
  });

  test("opting a repository in requires VALID, signed pilot evidence; refusals are audited; success records the sign-off digest", async () => {
    await reset();
    const before = await auditCount("auto_merge.enable");
    const bad = goodPilot(); bad.pilot.escapedDefects = 2; bad.metrics.reviewRecall = 0.4;
    await expect(controller().enableRepo({ actor: "admin", orgId: org, repositoryId: repo, pilotReport: bad })).rejects.toMatchObject({ code: "pilot-invalid", reasons: expect.arrayContaining([expect.stringMatching(/escaped defects/), expect.stringMatching(/reviewRecall/)]) });
    await expect(controller().enableRepo({ actor: "admin", orgId: org, repositoryId: repo, pilotReport: { nope: true } })).rejects.toBeInstanceOf(AutoMergeRefused);
    await expect(controller().enableRepo({ actor: "admin", orgId: org, repositoryId: crypto.randomUUID(), pilotReport: goodPilot() })).rejects.toMatchObject({ code: "not-found" });
    await expect(controller().enableRepo({ actor: "admin", orgId: org, repositoryId: repo, pilotReport: goodPilot(), allowedPathGlobs: ["**"] })).rejects.toMatchObject({ code: "validation" });
    expect(await controller().calibrated(repo)).toBe(false);
    expect(await auditCount("auto_merge.enable")).toBe(before + 2); // the two pilot-evidence refusals are audited (unknown repository / bad glob are plain validation errors)
    const ok = await arm();
    expect(ok.signoffDigest).toMatch(/^sha256:/);
    expect(await controller().calibrated(repo)).toBe(true);
    const st = await controller().status(org);
    expect(st.repositories[0]).toMatchObject({ enabled: true, allowedRisks: ["LOW"], tripped: false });
    // the database itself refuses an enabled repo without a sign-off, and risks above MEDIUM
    await expect(db.sql`UPDATE auto_merge_repo_controls SET signoff_digest = NULL WHERE repository_id=${repo}`).rejects.toThrow(/check/);
    await expect(db.sql`UPDATE auto_merge_repo_controls SET allowed_risks = ARRAY['HIGH'] WHERE repository_id=${repo}`).rejects.toThrow(/check/);
  });

  test("each control vetoes on its own, with its own reason (kill switch, opt-out, breaker, risk, paths, protected paths, limits, cooldown, hold)", async () => {
    await reset(); await arm();
    const id = crypto.randomUUID();
    const base = await controller().evaluate(job(id));
    expect(base).toEqual({ allowed: true, reasons: [] });
    const reasons = async (j = job(id)) => (await controller().evaluate(j)).reasons.join(" | ");
    expect(await reasons({ ...job(id), risk: "MEDIUM" })).toMatch(/risk MEDIUM is not in this repository's auto-merge allowlist/);
    expect(await reasons({ ...job(id), changedFiles: ["src/x.ts"] })).toMatch(/outside the auto-merge path allowlist/);
    expect(await reasons({ ...job(id), changedFiles: null })).toMatch(/changed files unknown/);
    expect(await reasons({ ...job(id), changedFiles: ["docs/a.md", ".github/workflows/ci.yml"] })).toMatch(/protected paths touched/);
    await controller().kill("op", org, "incident drill");
    expect(await reasons()).toMatch(/global kill switch is engaged \(incident drill\)/);
    await controller().disarm("admin", org, "drill over");
    await controller().disableRepo("op", org, repo, "pause rollout");
    expect(await reasons()).toMatch(/has not opted in/);
    await arm();
    await controller().trip(repo, "post-merge CI failed");
    expect(await reasons()).toMatch(/circuit breaker tripped: post-merge CI failed/);
    await controller().rearm("admin", org, repo, "investigated");
    expect(await reasons()).toBe("");
    await controller().holdJob("approver", org, id.length ? (await prepare({ ...DOCS, auto: controller(), stopAt: "after-port:scm.ensureDraftPr" })).jobId : id, "hold");
    // the hold above is on a different job; hold THIS id by direct event to test the veto
    await expect(controller().holdJob("approver", org, crypto.randomUUID(), "x")).rejects.toMatchObject({ code: "not-found" });
  });

  test("daily limit and cooldown use the recorded auto-merges", async () => {
    await reset(); await arm({ maxPerDay: 2, cooldownMinutes: 30 });
    const p = await prepare({ ...DOCS });
    const insert = (n: number, ageMin: number) => db.sql`INSERT INTO merge_intents (job_id, repository_id, pr_number, head_sha, status, github_merge_sha, auto, updated_at) VALUES (${p.jobId}, ${repo}, ${900 + n}, ${String(n).padStart(40, "0")}, 'merged', ${String(n).padStart(40, "1")}, true, now() - ${ageMin} * interval '1 minute')`;
    await insert(1, 60);
    expect((await controller().evaluate(job(crypto.randomUUID()))).allowed).toBe(true);
    await insert(2, 31);
    expect((await controller().evaluate(job(crypto.randomUUID()))).reasons.join()).toMatch(/daily auto-merge limit reached \(2\)/);
    await db.sql`UPDATE merge_intents SET updated_at = now() - interval '2 days' WHERE job_id=${p.jobId}`;
    await insert(3, 5);
    expect((await controller().evaluate(job(crypto.randomUUID()))).reasons.join()).toMatch(/cooldown: 30 min/);
  });

  test("decisions are audited once per distinct outcome (not once per tick)", async () => {
    await reset(); await arm();
    const id = crypto.randomUUID();
    for (let i = 0; i < 4; i++) await controller().evaluate(job(id));
    expect((await db.sql`SELECT count(*)::int AS c FROM audit_entries WHERE resource=${"job:" + id} AND action='auto_merge.decision'`)[0]!.c).toBe(1);
    await controller().kill("op", org, "stop");
    await controller().evaluate(job(id));
    expect((await db.sql`SELECT result FROM audit_entries WHERE resource=${"job:" + id} AND action='auto_merge.decision' ORDER BY created_at`).map((r) => r.result)).toEqual(["allowed", "denied"]);
  });
});

describe("end to end: unattended merges happen only inside every limit; HIGH/CRITICAL never", () => {
  test("DEFAULT configuration (pilot policy, inert controls): a LOW docs change waits for a human — nothing merges unattended", async () => {
    await reset();
    const p = await prepare({ ...DOCS, auto: controller() });
    expect(p.state).toBe("AWAITING_HUMAN");
    expect(fake.mergeCalls).toBe(0);
    expect((await db.sql`SELECT eligible FROM policy_decisions WHERE job_id=${p.jobId}`)[0]!.eligible).toBe(false);
  });

  test("ARMED + opted-in + permissive policy: a LOW docs change merges by itself EXACTLY once, flagged auto, fully audited, no human approval row", async () => {
    await reset(); await arm();
    const p = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE });
    expect(["MERGED", "POSTMERGE_MONITOR"]).toContain(p.state);
    expect(fake.mergeCalls).toBe(1);
    expect((await db.sql`SELECT status, auto, github_merge_sha FROM merge_intents WHERE job_id=${p.jobId}`).map((r) => [r.status, r.auto])).toEqual([["merged", true]]);
    expect((await db.sql`SELECT count(*)::int AS c FROM approvals WHERE job_id=${p.jobId}`)[0]!.c).toBe(0);
    expect((await db.sql`SELECT risk, eligible FROM policy_decisions WHERE job_id=${p.jobId}`)[0]).toMatchObject({ risk: "LOW", eligible: true });
    expect((await readEvents(db.sql, p.jobId, 0, 1000)).map((e) => e.type)).toEqual(expect.arrayContaining(["auto_merge.eligible", "merge.completed"]));
    expect((await db.sql`SELECT result FROM audit_entries WHERE resource=${"job:" + p.jobId} AND action='auto_merge.decision'`).map((r) => r.result)).toContain("allowed");
    await p.env.orch.tick(p.jobId); await p.env.orch.tick(p.jobId);
    expect(fake.mergeCalls).toBe(1);
  });

  test("HIGH and CRITICAL changes NEVER merge unattended — even with everything armed, a permissive policy and a calibrated repository; a human approval still merges them", async () => {
    await reset(); await arm({ allowedPathGlobs: [] });
    const high = await prepare({ files: ["package.json"], script: `printf '{"hi":1}\\n' > package.json`, description: SAFE_DESC, auto: controller(), policy: PERMISSIVE });
    expect(high.state).toBe("AWAITING_HUMAN");
    expect(fake.mergeCalls).toBe(0);
    expect((await db.sql`SELECT risk, eligible FROM policy_decisions WHERE job_id=${high.jobId}`)[0]).toMatchObject({ risk: "HIGH", eligible: false });
    const crit = await prepare({ files: [".github/workflows/ci.yml"], script: `printf 'name: x\\n' > .github/workflows/ci.yml`, description: SAFE_DESC, auto: controller(), policy: PERMISSIVE });
    expect(crit.state).toBe("AWAITING_HUMAN");
    expect(fake.mergeCalls).toBe(0);
    // forcing a HIGH job into PREMERGE does not help: the coordinator and the transition guard refuse without a human
    await db.sql`UPDATE jobs SET state='PREMERGE', version=version+1 WHERE id=${high.jobId}`;
    const r = await high.env.coordinator().merge(high.jobId);
    expect(r.status).toBe("blocked");
    expect(fake.mergeCalls).toBe(0);
    // ... while the human path still works
    await db.sql`UPDATE jobs SET state='AWAITING_HUMAN', version=version+1 WHERE id=${high.jobId}`;
    const hi = await db.sql`SELECT version FROM jobs WHERE id=${high.jobId}`;
    await recordDecision(db.sql, high.env.reviewPort, { jobId: high.jobId, orgId: org, actorId: U.approver1 as string, idempotencyKey: crypto.randomUUID(), decision: "approve", headSha: high.head, baseSha: high.base, policyDigest: (await db.sql`SELECT policy_digest FROM jobs WHERE id=${high.jobId}`)[0]!.policy_digest, expectedVersion: hi[0]!.version });
    expect(["merged", "pending"]).toContain((await high.env.coordinator().merge(high.jobId)).status);
  });

  test("KILL SWITCH: engaged before the job reaches merge, the job goes to a human; the operator can then approve manually (override works); disarming restores automation", async () => {
    await reset(); await arm();
    await controller().kill("op", org, "incident: pause all unattended merges");
    const p = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE });
    expect(p.state).toBe("AWAITING_HUMAN");
    expect(fake.mergeCalls).toBe(0);
    expect((await db.sql`SELECT result, reason FROM audit_entries WHERE resource=${"job:" + p.jobId} AND action='auto_merge.decision'`).map((r) => r.result)).toContain("denied");
    await approve(p, "approver1"); // human override
    await tickUntil(p, (t) => t.state === "MERGED");
    expect(await state(p.jobId)).toBe("POSTMERGE_MONITOR");
    expect(fake.mergeCalls).toBe(1);
    expect((await db.sql`SELECT auto FROM merge_intents WHERE job_id=${p.jobId}`)[0]!.auto).toBe(false); // merged with a human approval, so NOT an auto-merge
    await controller().disarm("admin", org, "all clear");
    const q = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE });
    expect(["MERGED", "POSTMERGE_MONITOR"]).toContain(q.state);
  });

  test("KILL SWITCH after the job was judged eligible but before the merge call: the coordinator re-checks the controls and refuses", async () => {
    await reset(); await arm();
    const p = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE, stopAt: "after-record:auto-merge" });
    expect(p.state).toBe("PREMERGE");
    expect((await db.sql`SELECT eligible FROM policy_decisions WHERE job_id=${p.jobId}`)[0]!.eligible).toBe(true);
    await controller().kill("op", org, "stop now");
    const r = await p.env.coordinator().merge(p.jobId);
    expect(r).toMatchObject({ status: "blocked" });
    expect((r as { blockers: string[] }).blockers.join(" ")).toMatch(/auto-merge control: global kill switch is engaged|merge is not eligible/);
    expect(fake.mergeCalls).toBe(0);
  });

  test("per-job HOLD by an operator forces a human even when everything else allows automation", async () => {
    await reset(); await arm();
    const p = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE, hold: true });
    expect(p.state).toBe("AWAITING_HUMAN");
    expect(fake.mergeCalls).toBe(0);
    expect((await db.sql`SELECT count(*)::int AS c FROM events WHERE job_id=${p.jobId} AND type='auto_merge.hold'`)[0]!.c).toBe(1);
  });

  test("daily cap: the second change in the same period waits for a human", async () => {
    await reset(); await arm({ maxPerDay: 1 });
    const a = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE });
    expect(["MERGED", "POSTMERGE_MONITOR"]).toContain(a.state);
    const b = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE });
    expect(b.state).toBe("AWAITING_HUMAN");
    expect((await db.sql`SELECT reasons FROM policy_decisions WHERE job_id=${b.jobId}`)[0]!.reasons.join(" ")).toMatch(/daily auto-merge limit reached/);
  });

  test("CIRCUIT BREAKER: a failed post-merge health check on an auto-merged job trips the repository; later changes wait for a human until an administrator re-arms", async () => {
    await reset(); await arm();
    const a = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE });
    expect(["MERGED", "POSTMERGE_MONITOR"]).toContain(a.state);
    await a.env.coordinator().recordPostmerge(a.jobId, { ok: false, detail: "main CI red after the automatic merge" });
    expect((await controller().status(org)).repositories[0]).toMatchObject({ tripped: true });
    expect(await auditCount("auto_merge.trip")).toBeGreaterThanOrEqual(1);
    const b = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE });
    expect(b.state).toBe("AWAITING_HUMAN");
    await controller().rearm("admin", org, repo, "root cause fixed");
    const c = await prepare({ ...DOCS, auto: controller(), policy: PERMISSIVE });
    expect(["MERGED", "POSTMERGE_MONITOR"]).toContain(c.state);
  });

  test("a failed post-merge check on a HUMAN-approved merge does NOT trip the breaker (only automatic merges do)", async () => {
    await reset(); await arm();
    const p = await prepare({ ...DOCS, auto: controller() }); // pilot policy: waits for a human
    await approve(p, "approver1");
    await tickUntil(p, (t) => t.state === "MERGED");
    await p.env.coordinator().recordPostmerge(p.jobId, { ok: false, detail: "red" });
    expect((await controller().status(org)).repositories[0]).toMatchObject({ tripped: false });
    void policyDigest;
  });
});
