import { mkdirSync } from "node:fs";
import { loadApprovedPool, matchCapabilities, type TaskRequirements } from "@factory/capabilities";
import type { Sql } from "@factory/db";
import { listProposals } from "@factory/improvements";
import { activate, decideApproval, emergencyDisable, importArchive, RegistryError, ReportSigner, requestApproval, submitCandidate, validateSkillTree, policyDigestOf, ArchiveRejected, InventoryError, type Operation, type ValidationPolicy } from "@factory/skills";
import { require_, type Actor } from "./auth";
import { readJson } from "./body";
import type { JsonResult } from "./jobs";
import { ApiProblem, problems } from "./problem";

export interface SkillsConfig {
  quarantineDir: string; scratchDir: string;
  policy: ValidationPolicy;
  /** Key that signs validation reports (server-held). */
  signer: ReportSigner;
  /** Max accepted archive upload. */
  maxArchiveBytes?: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["activate", "upgrade", "revoke", "rollback", "grant_permission"]);

/** Maps registry failures to RFC 9457 problems with the status semantics of CONTRACTS/v2.2/openapi.yaml (409 stale, 412 digest/policy/evidence changed). */
export function registryProblem(e: unknown): ApiProblem | null {
  if (e instanceof RegistryError) {
    const c = e.code;
    if (c === "STALE_REVISION" || c === "APPROVAL_CONSUMED" || c === "IDEMPOTENCY_CONFLICT") return problems.conflict(c.toLowerCase(), e.message);
    if (["DIGEST_MISMATCH", "POLICY_CHANGED", "EVIDENCE_MISMATCH", "EVIDENCE_EXPIRED", "APPROVAL_EXPIRED"].includes(c)) return new ApiProblem({ status: 412, code: c.toLowerCase(), title: "Precondition Failed", detail: e.message });
    if (c === "NOT_FOUND") return problems.notFound(e.message);
    if (c === "DB_REJECTED") {
      if (/self-approval|conflict of interest|not an enabled approver/i.test(e.message)) return problems.forbidden("approval refused: independent human approver required");
      if (/exact content/i.test(e.message)) return new ApiProblem({ status: 412, code: "digest-mismatch", title: "Precondition Failed", detail: "approval must name the exact content and permission digests" });
      if (/expired/i.test(e.message)) return new ApiProblem({ status: 412, code: "approval-expired", title: "Precondition Failed", detail: "approval request expired" });
      if (/duplicate key|already exists/i.test(e.message)) return problems.conflict("already-decided", "this request already has a decision");
      return problems.unprocessable("rejected by registry constraints");
    }
    return problems.unprocessable(e.message);
  }
  return null;
}

type Handler = (a: { req: Request; sql: Sql; actor: Actor; cfg: SkillsConfig | undefined; maxBody: number; mutating: () => void; key: () => string }) => Promise<JsonResult>;

async function body(req: Request, max: number): Promise<Record<string, unknown>> { const { value } = await readJson(req, max); if (!value || typeof value !== "object" || Array.isArray(value)) throw problems.unprocessable("body must be an object"); return value as Record<string, unknown>; }
const str = (b: Record<string, unknown>, k: string, re?: RegExp): string => { const v = b[k]; if (typeof v !== "string" || (re && !re.test(v))) throw problems.unprocessable(`${k} is missing or malformed`); return v; };

export const registryRoutes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  { method: "GET", pattern: /^\/skills$/, handler: async ({ sql, actor }) => {
    require_(actor, "skill:read");
    const rows = await sql`SELECT v.id, v.kind, v.slug, v.version, v.digest, v.state, v.created_at, (a.active_version_id = v.id) AS active FROM skill_versions v LEFT JOIN registry_active a ON a.organization_id = v.organization_id AND a.workspace_id = v.workspace_id AND a.kind = v.kind AND a.slug = v.slug WHERE v.organization_id = ${actor.orgId} ORDER BY v.created_at DESC LIMIT 200`;
    return { status: 200, body: { items: rows.map((r) => ({ id: r.id, kind: r.kind, slug: r.slug, version: r.version, digest: r.digest, state: r.state, active: r.active === true, createdAt: new Date(r.created_at as string).toISOString() })) } };
  } },
  { method: "POST", pattern: /^\/skills\/imports$/, handler: async ({ req, sql, actor, cfg, mutating, key, maxBody }) => {
    require_(actor, "skill:import"); mutating(); key();
    if (!cfg) throw new ApiProblem({ status: 503, code: "not-configured", title: "Skill registry is not configured" });
    if ((req.headers.get("content-type") ?? "").split(";")[0] !== "application/zip") throw new ApiProblem({ status: 415, code: "unsupported-media-type", title: "Unsupported Media Type", detail: "Content-Type must be application/zip" });
    const limit = cfg.maxArchiveBytes ?? 5 * 1024 * 1024; void maxBody;
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength > limit) throw problems.tooLarge(limit);
    mkdirSync(cfg.quarantineDir, { recursive: true }); mkdirSync(cfg.scratchDir, { recursive: true });
    try {
      const imp = importArchive(buf, cfg.quarantineDir, cfg.scratchDir, actor.userId);
      const report = validateSkillTree({ root: imp.quarantineDir, origin: { uri: `upload://${actor.userId}`, type: "upload" }, policy: cfg.policy });
      if (!report.manifest) return { status: 422, body: { code: "validation-failed", digest: imp.digest, findings: report.findings.map((f) => ({ code: f.code, severity: f.severity, file: f.file })) } };
      const signed = cfg.signer.sign(report);
      const out = await submitCandidate(sql, { organizationId: actor.orgId, kind: "skill", manifest: report.manifest, files: imp.files, createdBy: actor.userId, signed, reportPublicKeyPem: cfg.signer.publicKeyPem, policyDigest: policyDigestOf(cfg.policy) });
      return { status: 202, body: { versionId: out.versionId, state: out.state, duplicate: out.duplicate, digest: imp.digest, ok: report.ok, findings: report.findings.filter((f) => f.severity !== "info").map((f) => ({ code: f.code, severity: f.severity, file: f.file })), note: "quarantined; nothing was executed or activated" } };
    } catch (e) {
      if (e instanceof ArchiveRejected) throw new ApiProblem({ status: 422, code: `archive-${e.code}`, title: "Archive rejected", detail: e.message });
      if (e instanceof InventoryError) throw problems.unprocessable(e.message);
      throw e;
    }
  } },
  { method: "POST", pattern: /^\/capabilities\/match$/, handler: async ({ req, sql, actor, maxBody, key, mutating }) => {
    require_(actor, "capability:match"); mutating(); key();
    const b = await body(req, maxBody);
    const g = b.granted as TaskRequirements["granted"] | undefined;
    const lists = ["tools", "network", "writeScopes", "dataClasses"] as const;
    if (!g || typeof g !== "object" || lists.some((k) => !Array.isArray(g[k]) || (g[k] as unknown[]).some((x) => typeof x !== "string"))) throw problems.unprocessable("granted must list tools, network, writeScopes, dataClasses");
    const runtime = str(b, "runtime", /^(claude_code_cli|codex_cli|local_model)$/) as TaskRequirements["runtime"];
    const autonomy = str(b, "autonomy", /^(suggest|draft|act_with_gate)$/) as TaskRequirements["autonomy"];
    const req2: TaskRequirements = { organizationId: actor.orgId, role: str(b, "role", /^[a-z][a-z0-9_.]{2,60}$/), domain: str(b, "domain"), desiredArtifacts: Array.isArray(b.desiredArtifacts) ? (b.desiredArtifacts as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 20) : [], runtime, autonomy, granted: g, ...(typeof b.minQuality === "number" ? { minQuality: b.minQuality } : {}) };
    const pool = await loadApprovedPool(sql, actor.orgId);   // tenant-scoped: the organisation comes from the session, never from the body
    return { status: 200, body: matchCapabilities(req2, pool) };
  } },
  { method: "POST", pattern: /^\/approvals$/, handler: async ({ req, sql, actor, cfg, maxBody, key, mutating }) => {
    require_(actor, "approval:request"); mutating(); const k = key();
    const b = await body(req, maxBody);
    const op = str(b, "operation");
    if (!OPS.has(op)) throw problems.unprocessable("operation must be one of activate|upgrade|revoke|rollback|grant_permission");
    if (!cfg) throw new ApiProblem({ status: 503, code: "not-configured", title: "Skill registry is not configured" });
    try {
      const r = await requestApproval(sql, { organizationId: actor.orgId, versionId: str(b, "versionId", uuid), operation: op as Operation, requestedBy: actor.userId, idempotencyKey: `${actor.userId}:${k}`, policyDigest: policyDigestOf(cfg.policy), ...(typeof b.ttlSeconds === "number" && b.ttlSeconds > 0 && b.ttlSeconds <= 7 * 86400 ? { ttlMs: b.ttlSeconds * 1000 } : {}) });
      return { status: 201, body: r };
    } catch (e) { const p = registryProblem(e); if (p) throw p; throw e; }
  } },
  { method: "POST", pattern: /^\/approvals\/[^/]+\/decision$/, handler: async ({ req, sql, actor, maxBody, key, mutating }) => {
    require_(actor, "approval:decide"); mutating(); key();
    const id = new URL(req.url).pathname.split("/")[4] as string;
    if (!uuid.test(id)) throw problems.notFound("approval request not found");
    const [r] = await sql`SELECT id FROM approval_requests WHERE id = ${id} AND organization_id = ${actor.orgId}`;
    if (!r) throw problems.notFound("approval request not found");  // tenant isolation: other orgs' requests are indistinguishable from absent
    const b = await body(req, maxBody);
    const decision = str(b, "decision", /^(approved|rejected)$/) as "approved" | "rejected";
    try {
      await decideApproval(sql, { requestId: id, approverId: actor.userId, decision, presentedDigest: str(b, "digest"), presentedPermissionDigest: str(b, "permissionDigest"), ...(typeof b.note === "string" ? { note: b.note.slice(0, 500) } : {}) });
      return { status: 200, body: { requestId: id, decision } };
    } catch (e) { const p = registryProblem(e); if (p) throw p; throw e; }
  } },
  { method: "POST", pattern: /^\/activations$/, handler: async ({ req, sql, actor, cfg, maxBody, key, mutating }) => {
    require_(actor, "activation:write"); mutating(); const k = key();
    if (!cfg) throw new ApiProblem({ status: 503, code: "not-configured", title: "Skill registry is not configured" });
    const b = await body(req, maxBody);
    if (!Number.isInteger(b.expectedRevision) || (b.expectedRevision as number) < 0) throw problems.unprocessable("expectedRevision (integer >= 0) is required");
    const approvalId = str(b, "approvalId", uuid);
    const [r] = await sql`SELECT id FROM approval_requests WHERE id = ${approvalId} AND organization_id = ${actor.orgId}`;
    if (!r) throw problems.notFound("approval request not found");
    try {
      const out = await activate(sql, { organizationId: actor.orgId, requestId: approvalId, expectedRevision: b.expectedRevision as number, actor: actor.userId, idempotencyKey: `${actor.userId}:${k}`, policyDigest: policyDigestOf(cfg.policy) });
      return { status: 200, body: out, headers: { etag: `"${out.revision}"`, ...(out.replayed ? { "idempotency-replayed": "true" } : {}) } };
    } catch (e) { const p = registryProblem(e); if (p) throw p; throw e; }
  } },
  { method: "POST", pattern: /^\/skills\/disable$/, handler: async ({ req, sql, actor, maxBody, key, mutating }) => {
    require_(actor, "skill:disable"); mutating(); const k = key();
    const b = await body(req, maxBody);
    const kind = str(b, "kind", /^(skill|agent)$/) as "skill" | "agent";
    try { const out = await emergencyDisable(sql, { organizationId: actor.orgId, kind, slug: str(b, "slug", /^[a-z][a-z0-9-]{2,63}$/), actor: actor.userId, reason: str(b, "reason").slice(0, 500), idempotencyKey: `${actor.userId}:${k}` }); return { status: 200, body: out }; }
    catch (e) { const p = registryProblem(e); if (p) throw p; throw e; }
  } },
  { method: "GET", pattern: /^\/improvements$/, handler: async ({ sql, actor }) => {
    require_(actor, "improvement:read");
    const items = await listProposals(sql, actor.orgId);
    // redacted view: no raw signal ids or evidence, only what a reviewer needs
    return { status: 200, body: { items: items.map((p) => ({ id: p.id, state: p.state, action: p.requestedAction, risk: p.risk, problem: p.problem, hypothesis: p.hypothesis, targetDigest: p.targetDigest, candidateDigest: p.candidateDigest, comparisonId: p.comparisonId, rollbackRule: p.rollbackRule, rank: p.rankScore })) } };
  } },
  { method: "POST", pattern: /^\/improvements\/[^/]+\/experiment$/, handler: async ({ req, sql, actor, mutating, key }) => {
    require_(actor, "improvement:experiment"); mutating(); const k = key();
    const id = new URL(req.url).pathname.split("/")[3] as string;
    if (!uuid.test(id)) throw problems.notFound("proposal not found");
    const [p] = await sql`SELECT id, state FROM improvement_proposals WHERE id = ${id} AND organization_id = ${actor.orgId}`;
    if (!p) throw problems.notFound("proposal not found");
    if (!["planned", "candidate_ready", "triaged"].includes(p.state as string)) throw problems.conflict("wrong-state", `proposal is ${p.state}`);
    await sql`INSERT INTO experiment_ledger (organization_id, proposal_id, event, detail) VALUES (${actor.orgId}, ${id}, 'experiment_requested', ${sql.json({ by: actor.userId, key: k } as never)})`;
    return { status: 202, body: { id, status: "queued", note: "an experiment is staged only; it never activates anything" } };
  } },
];
