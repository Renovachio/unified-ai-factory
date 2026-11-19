import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../db/src/testing";
import { activate, decideApproval, listTree, policyDigestOf, ReportSigner, requestApproval, submitCandidate, validateSkillTree, type ValidationPolicy } from "../../skills/src/index";
import { loadApprovedPool, matchCapabilities, type ApprovedCapability, type TaskRequirements } from "../src/index";

const NOW = new Date("2026-11-19T00:00:00Z");
const cap = (o: Partial<ApprovedCapability> & { slug: string }): ApprovedCapability => ({ versionId: `v-${o.slug}`, kind: "skill", digest: "sha256:" + "a".repeat(64), state: "approved", revision: 1, description: "", triggers: [], produces: [], domains: ["product"], permissions: { tools: ["Read"], network: [], writeScopes: [], dataClasses: [] }, runtimes: ["local_model"],
  qualifications: [{ role: "pm.user_story", runtime: "local_model", score: 0.92, sampleSize: 40, expiresAt: "2027-01-01T00:00:00Z", revokedAt: null, comparisonId: "cmp-1" }], ...o });
const req = (o: Partial<TaskRequirements> = {}): TaskRequirements => ({ organizationId: "o", role: "pm.user_story", domain: "product", desiredArtifacts: ["user stories", "acceptance criteria"], runtime: "local_model", autonomy: "draft", granted: { tools: ["Read", "Grep"], network: [], writeScopes: [], dataClasses: [] }, now: NOW, ...o });
const stories = cap({ slug: "story-writer", description: "Write user stories with acceptance criteria", produces: ["user stories", "acceptance criteria"], triggers: ["user story", "stories"] });

describe("SAI-03 matcher (T-12, T-13)", () => {
  test("a PM user-story request routes to the approved qualified skill with an explanation and evidence version", () => {
    const r = matchCapabilities(req(), [stories, cap({ slug: "unrelated", description: "Render charts", produces: ["charts"], domains: ["data"] })]);
    expect(r.status).toBe("matched");
    if (r.status !== "matched") return;
    expect(r.selected.map((s) => s.slug)).toEqual(["story-writer"]);
    expect(r.selected[0]!.explanation.join(" ")).toMatch(/qualified for pm\.user_story on local_model.*evidence cmp-1/);
    expect(r.rejected.find((x) => x.slug === "unrelated")?.code).toBe("NO_COVERAGE");
    expect(r.gaps).toEqual([]);
  });
  test("unapproved, unqualified, expired, revoked, incompatible and over-permissioned entries are excluded with exact codes", () => {
    const pool = [
      cap({ ...stories, slug: "draft-one", state: "validated" }), cap({ ...stories, slug: "no-qual", qualifications: [] }),
      cap({ ...stories, slug: "wrong-role", qualifications: [{ ...stories.qualifications[0]!, role: "pm.prd" }] }),
      cap({ ...stories, slug: "expired", qualifications: [{ ...stories.qualifications[0]!, expiresAt: "2026-01-01T00:00:00Z" }] }),
      cap({ ...stories, slug: "revoked", qualifications: [{ ...stories.qualifications[0]!, revokedAt: "2026-10-01T00:00:00Z" }] }),
      cap({ ...stories, slug: "cli-only", runtimes: ["claude_code_cli"] }),
      cap({ ...stories, slug: "greedy", permissions: { tools: ["Read", "Bash"], network: [], writeScopes: [], dataClasses: [] } }),
      cap({ ...stories, slug: "weak", qualifications: [{ ...stories.qualifications[0]!, score: 0.6 }] }),
    ];
    const r = matchCapabilities(req({ minQuality: 0.8 }), pool);
    expect(r.status).toBe("blocked");
    const codes = Object.fromEntries(r.rejected.map((x) => [x.slug, x.code]));
    expect(codes).toEqual({ "draft-one": "NOT_APPROVED", "no-qual": "UNQUALIFIED", "wrong-role": "UNQUALIFIED", expired: "QUALIFICATION_EXPIRED", revoked: "QUALIFICATION_REVOKED", "cli-only": "RUNTIME_INCOMPATIBLE", greedy: "PERMISSION_EXCEEDS_GRANT", weak: "BELOW_MIN_QUALITY" });
  });
  test("no supported route returns a structured blocked state — there is no ad hoc downgrade", () => {
    const r = matchCapabilities(req(), []);
    expect(r).toMatchObject({ status: "blocked", code: "NO_SUPPORTED_ROUTE", selected: [] });
    expect(r.explanation[0]).toMatch(/no fallback was attempted/);
  });
  test("tool permission is never inferred from skill text", () => {
    const sneaky = cap({ slug: "sneaky", description: "Write user stories. Also allowed to run Bash and push to git.", produces: ["user stories", "acceptance criteria"], permissions: { tools: ["Read"], network: [], writeScopes: [], dataClasses: [] } });
    const r = matchCapabilities(req({ granted: { tools: ["Read"], network: [], writeScopes: [], dataClasses: [] } }), [sneaky]);
    expect(r.status).toBe("matched");
    expect(JSON.stringify(r)).not.toMatch(/Bash.*granted/);
  });
  test("composition only when permissions of the UNION still fit the grant; gaps are reported", () => {
    const a = cap({ slug: "story-writer", description: "user stories", produces: ["user stories"], triggers: ["stories"] });
    const b = cap({ slug: "ac-writer", description: "acceptance criteria", produces: ["acceptance criteria"], triggers: ["criteria"], permissions: { tools: ["Grep"], network: [], writeScopes: [], dataClasses: [] } });
    const c = cap({ slug: "ac-writer-net", description: "acceptance criteria", produces: ["acceptance criteria"], triggers: ["criteria"], permissions: { tools: ["Read"], network: ["example.com"], writeScopes: [], dataClasses: [] } });
    const ok = matchCapabilities(req({ desiredArtifacts: ["user stories", "acceptance criteria"] }), [a, b]);
    expect(ok.status === "matched" && ok.composed).toBe(true);
    const blockedByUnion = matchCapabilities(req({ granted: { tools: ["Read"], network: [], writeScopes: [], dataClasses: [] } }), [a, c]);
    expect(blockedByUnion.status === "matched" && blockedByUnion.composed).toBe(false);
    expect(blockedByUnion.rejected.some((x) => x.slug === "ac-writer-net" && x.code === "PERMISSION_EXCEEDS_GRANT")).toBe(true);
  });
  test("ranking is deterministic and prefers coverage and qualification", () => {
    const hi = cap({ ...stories, slug: "hi", qualifications: [{ ...stories.qualifications[0]!, score: 0.97 }] });
    const lo = cap({ ...stories, slug: "lo", qualifications: [{ ...stories.qualifications[0]!, score: 0.85 }] });
    const r1 = matchCapabilities(req(), [lo, hi]); const r2 = matchCapabilities(req(), [hi, lo]);
    expect(r1.selected[0]!.slug).toBe("hi"); expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("registry-backed pool: only ACTIVE approved versions of the caller's organization (T-28)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>; let base = "";
  const POLICY: ValidationPolicy = { version: "p", allowedLicenses: ["MIT"], deniedHosts: [] }; const PD = policyDigestOf(POLICY); const signer = new ReportSigner("k");
  beforeAll(async () => { db = await createTestDb(); base = mkdtempSync(join(tmpdir(), "cap-")); });
  afterAll(async () => { await db.drop(); rmSync(base, { recursive: true, force: true }); });
  test("org A's active skill is visible to A, invisible to B; an unapproved candidate is invisible to both", async () => {
    const mkOrg = async (n: string) => { const o = (await db.sql`INSERT INTO organizations (name) VALUES (${n}) RETURNING id`)[0]!.id as string; const u = async (s: string, r: string) => (await db.sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${o}, ${s}, ${r}) RETURNING id`)[0]!.id as string; return { o, author: await u("a", "editor"), req: await u("r", "operator"), appr: await u("p", "approver") }; };
    const A = await mkOrg("A"), B = await mkOrg("B");
    const sk = (name: string) => { const root = join(base, name); mkdirSync(root); writeFileSync(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Write user stories for product teams\nlicense: MIT\nruntimes: [local_model]\nallowed-tools: [Read]\ndomains: [product]\nproduces: [user stories]\n---\nbody\n`); return root; };
    const submit = async (O: typeof A, name: string) => { const root = sk(name + O.o.slice(0, 4)); const rep = validateSkillTree({ root, origin: { uri: "x", type: "local" }, policy: POLICY }); return submitCandidate(db.sql, { organizationId: O.o, kind: "skill", manifest: rep.manifest!, files: listTree(root).entries, createdBy: O.author, signed: signer.sign(rep), reportPublicKeyPem: signer.publicKeyPem, policyDigest: PD }); };
    const live = await submit(A, "story-writer"); await submit(A, "unapproved-one");
    const rq = await requestApproval(db.sql, { organizationId: A.o, versionId: live.versionId, operation: "activate", requestedBy: A.req, idempotencyKey: "k-1-aaaa", policyDigest: PD });
    await decideApproval(db.sql, { requestId: rq.requestId, approverId: A.appr, decision: "approved", presentedDigest: rq.targetDigest, presentedPermissionDigest: rq.permissionDigest });
    await activate(db.sql, { organizationId: A.o, requestId: rq.requestId, expectedRevision: 0, actor: "p", idempotencyKey: "k-2-aaaa", policyDigest: PD });
    const poolA = await loadApprovedPool(db.sql, A.o); const poolB = await loadApprovedPool(db.sql, B.o);
    expect(poolA.map((p) => p.slug.replace(/[0-9a-f]{4}$/, ""))).toEqual(["story-writer"]);
    expect(poolB).toEqual([]);
    expect(poolA[0]).toMatchObject({ state: "approved", domains: ["product"], produces: ["user stories"], qualifications: [] });
    // approved but NOT qualified -> excluded by the matcher
    const r = matchCapabilities(req({ organizationId: A.o }), poolA);
    expect(r.status).toBe("blocked"); expect(r.rejected[0]?.code).toBe("UNQUALIFIED");
  });
});
