import type { Sql } from "@factory/db";
import { digestOfJson } from "./digest";
import { verifyValidationReport, type SignedValidationReport, type SkillManifest } from "./validator";
import type { TreeEntry } from "./digest";

export class RegistryError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "RegistryError"; } }
export type Operation = "activate" | "upgrade" | "revoke" | "rollback" | "grant_permission";
type Tx = import("postgres").TransactionSql;
function fail(code: string, msg: string): never { throw new RegistryError(code, msg); }
const dbErr = (e: unknown): never => { const m = String((e as Error).message ?? e); throw new RegistryError("DB_REJECTED", m); };

export interface Scope { organizationId: string; workspaceId?: string }
const ws = (s: Scope) => s.workspaceId ?? "default";

/** Stores an immutable candidate in quarantine (state `quarantined`, then `validated` only with a passing, verified, unexpired report). Duplicate digests return the existing row and never overwrite. */
export async function submitCandidate(sql: Sql, i: Scope & { kind: "skill" | "agent"; manifest: Pick<SkillManifest, "slug" | "version" | "digest" | "origin">; files: readonly TreeEntry[]; createdBy: string; signed: SignedValidationReport; reportPublicKeyPem: string; policyDigest: string; now?: Date }): Promise<{ versionId: string; duplicate: boolean; state: string }> {
  const { manifest: m } = i;
  const existing = await sql`SELECT id, state FROM skill_versions WHERE organization_id = ${i.organizationId} AND workspace_id = ${ws(i)} AND kind = ${i.kind} AND slug = ${m.slug} AND digest = ${m.digest}`;
  if (existing[0]) return { versionId: existing[0].id as string, duplicate: true, state: existing[0].state as string };
  const permDigest = i.signed.report.permissionDigest ?? fail("NO_PERMISSION_DIGEST", "report has no permission digest");
  const check = verifyValidationReport(i.signed, i.reportPublicKeyPem, { digest: m.digest, policyDigest: i.policyDigest, ...(i.now ? { now: i.now } : {}) });
  return await sql.begin(async (tx) => {
    const [row] = await tx`INSERT INTO skill_versions (organization_id, workspace_id, kind, slug, version, digest, permission_digest, manifest, origin, file_manifest, meta, created_by)
      VALUES (${i.organizationId}, ${ws(i)}, ${i.kind}, ${m.slug}, ${m.version}, ${m.digest}, ${permDigest}, ${tx.json(m as never)}, ${tx.json(m.origin as never)}, ${tx.json(i.files as never)}, ${tx.json((i.signed.report.meta ?? {}) as never)}, ${i.createdBy}) RETURNING id`;
    const rowId = (row ?? fail("INSERT_FAILED", "no row")).id as string;
    const evidence = digestOfJson({ report: i.signed.report, signature: i.signed.signature });
    await tx`INSERT INTO skill_validations (version_id, candidate_digest, policy_digest, ok, report, signature, key_id, evidence_digest, expires_at)
      VALUES (${rowId}, ${i.signed.report.candidateDigest}, ${i.signed.report.policyDigest}, ${i.signed.report.ok}, ${tx.json(i.signed.report as never)}, ${i.signed.signature}, ${i.signed.keyId}, ${evidence}, ${i.signed.report.expiresAt})`;
    let state = "quarantined";
    if (check.ok) { await tx`UPDATE skill_versions SET state = 'validated' WHERE id = ${rowId}`; state = "validated"; }
    return { versionId: rowId, duplicate: false, state };
  }) as { versionId: string; duplicate: boolean; state: string };
}

async function loadVersion(tx: Tx, id: string) { const [v] = await tx`SELECT * FROM skill_versions WHERE id = ${id}`; return v ?? fail("NOT_FOUND", "no such version"); }
async function latestValidation(tx: Tx, versionId: string) { const [r] = await tx`SELECT * FROM skill_validations WHERE version_id = ${versionId} ORDER BY created_at DESC, id DESC LIMIT 1`; return r; }

export async function requestApproval(sql: Sql, i: { organizationId: string; versionId: string; operation: Operation; requestedBy: string; idempotencyKey: string; policyDigest: string; ttlMs?: number }): Promise<{ requestId: string; targetDigest: string; permissionDigest: string; evidenceDigest: string; expiresAt: string }> {
  return await sql.begin(async (tx) => {
    const prior = await tx`SELECT * FROM approval_requests WHERE organization_id = ${i.organizationId} AND idempotency_key = ${i.idempotencyKey}`;
    if (prior[0]) { if (prior[0].version_id !== i.versionId || prior[0].operation !== i.operation) fail("IDEMPOTENCY_CONFLICT", "idempotency key reused for a different request"); return pack(prior[0]); }
    const v = await loadVersion(tx, i.versionId);
    if (v.organization_id !== i.organizationId) fail("NOT_FOUND", "no such version");
    const val = await latestValidation(tx, i.versionId);
    if (i.operation === "activate" || i.operation === "upgrade" || i.operation === "grant_permission") {
      if (v.state !== "validated" && v.state !== "awaiting_approval") fail("NOT_VALIDATED", `version is ${v.state}; only validated candidates can be submitted for approval`);
      if (!val || !val.ok) fail("NO_PASSING_EVIDENCE", "no passing validation evidence");
      if (val.policy_digest !== i.policyDigest) fail("POLICY_CHANGED", "evidence was produced under a different policy");
      if (Date.parse(val.expires_at) <= Date.now()) fail("EVIDENCE_EXPIRED", "validation evidence expired; re-validate");
    } else if (v.state !== "approved") fail("NOT_APPROVED", `operation ${i.operation} targets an approved version`);
    const expires = new Date(Date.now() + (i.ttlMs ?? 24 * 3_600_000));
    const evidence = val?.evidence_digest ?? digestOfJson({ none: true });
    const [r] = await tx`INSERT INTO approval_requests (organization_id, version_id, operation, target_digest, permission_digest, policy_digest, evidence_digest, requested_by, idempotency_key, expires_at)
      VALUES (${i.organizationId}, ${i.versionId}, ${i.operation}, ${v.digest}, ${v.permission_digest}, ${i.policyDigest}, ${evidence}, ${i.requestedBy}, ${i.idempotencyKey}, ${expires}) RETURNING *`;
    if (v.state === "validated" && i.operation !== "revoke" && i.operation !== "rollback") await tx`UPDATE skill_versions SET state = 'awaiting_approval' WHERE id = ${i.versionId}`;
    return pack(r ?? fail("INSERT_FAILED", "no row"));
  }) as never;
}
const pack = (r: Record<string, unknown>) => ({ requestId: r.id as string, targetDigest: r.target_digest as string, permissionDigest: r.permission_digest as string, evidenceDigest: r.evidence_digest as string, expiresAt: new Date(r.expires_at as string).toISOString() });

/** Records an independent human decision. The approver must present the exact digests; the DB trigger enforces role, no self-approval, no author approval, expiry. */
export async function decideApproval(sql: Sql, i: { requestId: string; approverId: string; decision: "approved" | "rejected"; presentedDigest: string; presentedPermissionDigest: string; note?: string }): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO approval_decisions (request_id, decision, decided_by, presented_digest, presented_permission_digest, note) VALUES (${i.requestId}, ${i.decision}, ${i.approverId}, ${i.presentedDigest}, ${i.presentedPermissionDigest}, ${i.note ?? null})`;
      if (i.decision === "rejected") await tx`UPDATE skill_versions SET state = 'rejected' WHERE id = (SELECT version_id FROM approval_requests WHERE id = ${i.requestId}) AND state IN ('validated','awaiting_approval')`;
    });
  } catch (e) { return dbErr(e); }
}

export async function activate(sql: Sql, i: Scope & { requestId: string; expectedRevision: number; actor: string; idempotencyKey: string; policyDigest: string }): Promise<{ revision: number; versionId: string; replayed: boolean }> {
  return await sql.begin(async (tx) => {
    const prior = await tx`SELECT * FROM registry_log WHERE organization_id = ${i.organizationId} AND idempotency_key = ${i.idempotencyKey}`;
    if (prior[0]) { if (prior[0].approval_request_id !== i.requestId) fail("IDEMPOTENCY_CONFLICT", "idempotency key reused"); return { revision: prior[0].revision as number, versionId: prior[0].to_version_id as string, replayed: true }; }
    const [req] = await tx`SELECT * FROM approval_requests WHERE id = ${i.requestId} AND organization_id = ${i.organizationId}`;
    if (!req) return fail("NOT_FOUND", "no such approval request");
    if (!["activate", "upgrade", "rollback"].includes(req.operation)) fail("WRONG_OPERATION", `request is for ${req.operation}`);
    const [dec] = await tx`SELECT * FROM approval_decisions WHERE request_id = ${i.requestId} FOR UPDATE`;
    if (!dec || dec.decision !== "approved") fail("NOT_APPROVED", "no approving decision");
    if (dec.consumed_at) fail("APPROVAL_CONSUMED", "approval was already used");
    if (Date.parse(req.expires_at) <= Date.now()) fail("APPROVAL_EXPIRED", "approval expired before activation");
    const v = await loadVersion(tx, req.version_id);
    if (v.digest !== req.target_digest || v.digest !== dec.presented_digest || v.permission_digest !== req.permission_digest || v.permission_digest !== dec.presented_permission_digest) fail("DIGEST_MISMATCH", "package or permissions differ from what was approved");
    if (req.policy_digest !== i.policyDigest) fail("POLICY_CHANGED", "policy changed since approval");
    if (v.state === "revoked" || v.state === "rejected") fail("VERSION_UNUSABLE", `version is ${v.state}`);
    if (req.operation !== "rollback") {
      const val = await latestValidation(tx, v.id);
      if (!val || !val.ok || val.evidence_digest !== req.evidence_digest) fail("EVIDENCE_MISMATCH", "validation evidence changed since approval");
      if (Date.parse(val.expires_at) <= Date.now()) fail("EVIDENCE_EXPIRED", "validation evidence expired");
    } else if (v.state !== "approved") fail("VERSION_UNUSABLE", "rollback target must be a previously approved version");
    await tx`INSERT INTO registry_active (organization_id, workspace_id, kind, slug) VALUES (${v.organization_id}, ${v.workspace_id}, ${v.kind}, ${v.slug}) ON CONFLICT DO NOTHING`;
    const [act0] = await tx`SELECT * FROM registry_active WHERE organization_id = ${v.organization_id} AND workspace_id = ${v.workspace_id} AND kind = ${v.kind} AND slug = ${v.slug} FOR UPDATE`;
    const act = act0 ?? fail("NOT_FOUND", "registry row missing");
    if (act.revision !== i.expectedRevision) fail("STALE_REVISION", `registry is at revision ${act.revision}, caller expected ${i.expectedRevision}`);
    const rev = act.revision + 1;
    if (v.state !== "approved") await tx`UPDATE skill_versions SET state = 'approved' WHERE id = ${v.id}`;
    await tx`UPDATE registry_active SET active_version_id = ${v.id}, revision = ${rev}, disabled_reason = NULL, updated_at = now() WHERE organization_id = ${v.organization_id} AND workspace_id = ${v.workspace_id} AND kind = ${v.kind} AND slug = ${v.slug}`;
    await tx`UPDATE approval_decisions SET consumed_at = now() WHERE request_id = ${i.requestId}`;
    await tx`INSERT INTO registry_log (organization_id, workspace_id, kind, slug, operation, from_version_id, to_version_id, revision, approval_request_id, actor, idempotency_key)
      VALUES (${v.organization_id}, ${v.workspace_id}, ${v.kind}, ${v.slug}, ${req.operation === "rollback" ? "rollback" : act.active_version_id ? "upgrade" : "activate"}, ${act.active_version_id}, ${v.id}, ${rev}, ${i.requestId}, ${i.actor}, ${i.idempotencyKey})`;
    return { revision: rev, versionId: v.id as string, replayed: false };
  }) as never;
}

/** Safe-direction action: turn a skill/agent OFF now. Never enables anything, so it needs no second approver. */
export async function emergencyDisable(sql: Sql, i: Scope & { kind: "skill" | "agent"; slug: string; actor: string; reason: string; idempotencyKey: string }): Promise<{ revision: number }> {
  return await sql.begin(async (tx) => {
    const [act] = await tx`SELECT * FROM registry_active WHERE organization_id = ${i.organizationId} AND workspace_id = ${ws(i)} AND kind = ${i.kind} AND slug = ${i.slug} FOR UPDATE`;
    if (!act) return fail("NOT_FOUND", "nothing is active under that name");
    const done = await tx`SELECT revision FROM registry_log WHERE organization_id = ${i.organizationId} AND idempotency_key = ${i.idempotencyKey}`;
    if (done[0]) return { revision: done[0].revision as number };
    const rev = act.revision + 1;
    await tx`UPDATE registry_active SET active_version_id = NULL, revision = ${rev}, disabled_reason = ${i.reason}, updated_at = now() WHERE organization_id = ${i.organizationId} AND workspace_id = ${ws(i)} AND kind = ${i.kind} AND slug = ${i.slug}`;
    await tx`INSERT INTO registry_log (organization_id, workspace_id, kind, slug, operation, from_version_id, to_version_id, revision, actor, idempotency_key, reason) VALUES (${i.organizationId}, ${ws(i)}, ${i.kind}, ${i.slug}, 'emergency_disable', ${act.active_version_id}, NULL, ${rev}, ${i.actor}, ${i.idempotencyKey}, ${i.reason})`;
    return { revision: rev };
  }) as never;
}

/** Revocation of a version: it can never be activated again; if it is active it is turned off in the same transaction. */
export async function revokeVersion(sql: Sql, i: { organizationId: string; versionId: string; actor: string; reason: string; idempotencyKey: string }): Promise<void> {
  await sql.begin(async (tx) => {
    const v = await loadVersion(tx, i.versionId);
    if (v.state !== "approved") fail("NOT_APPROVED", "only approved versions can be revoked");
    const [act] = await tx`SELECT * FROM registry_active WHERE organization_id = ${v.organization_id} AND workspace_id = ${v.workspace_id} AND kind = ${v.kind} AND slug = ${v.slug} FOR UPDATE`;
    await tx`UPDATE skill_versions SET state = 'revoked' WHERE id = ${v.id}`;
    if (act && act.active_version_id === v.id) {
      const rev = act.revision + 1;
      await tx`UPDATE registry_active SET active_version_id = NULL, revision = ${rev}, disabled_reason = ${'revoked: ' + i.reason}, updated_at = now() WHERE organization_id = ${v.organization_id} AND workspace_id = ${v.workspace_id} AND kind = ${v.kind} AND slug = ${v.slug}`;
      await tx`INSERT INTO registry_log (organization_id, workspace_id, kind, slug, operation, from_version_id, to_version_id, revision, actor, idempotency_key, reason) VALUES (${v.organization_id}, ${v.workspace_id}, ${v.kind}, ${v.slug}, 'revoke', ${v.id}, NULL, ${rev}, ${i.actor}, ${i.idempotencyKey}, ${i.reason})`;
    }
  });
}

/** The last previously-approved, non-revoked version before the current one (rollback target). */
export async function lastApprovedBefore(sql: Sql, s: Scope & { kind: "skill" | "agent"; slug: string }): Promise<string | null> {
  const rows = await sql`SELECT DISTINCT ON (l.to_version_id) l.to_version_id AS id, l.id AS lid FROM registry_log l JOIN skill_versions v ON v.id = l.to_version_id
    JOIN registry_active a ON a.organization_id = l.organization_id AND a.workspace_id = l.workspace_id AND a.kind = l.kind AND a.slug = l.slug
    WHERE l.organization_id = ${s.organizationId} AND l.workspace_id = ${ws(s)} AND l.kind = ${s.kind} AND l.slug = ${s.slug} AND l.operation IN ('activate','upgrade','rollback') AND v.state = 'approved' AND l.to_version_id IS DISTINCT FROM a.active_version_id
    ORDER BY l.to_version_id, l.id DESC`;
  rows.sort((a, b) => Number(b.lid) - Number(a.lid));
  return (rows[0]?.id as string | undefined) ?? null;
}

export async function getActive(sql: Sql, s: Scope & { kind: "skill" | "agent"; slug: string }): Promise<{ versionId: string; digest: string; revision: number } | null> {
  const [r] = await sql`SELECT v.id, v.digest, a.revision FROM registry_active a JOIN skill_versions v ON v.id = a.active_version_id WHERE a.organization_id = ${s.organizationId} AND a.workspace_id = ${ws(s)} AND a.kind = ${s.kind} AND a.slug = ${s.slug} AND v.state = 'approved'`;
  return r ? { versionId: r.id as string, digest: r.digest as string, revision: r.revision as number } : null;
}
export async function revisionOf(sql: Sql, s: Scope & { kind: "skill" | "agent"; slug: string }): Promise<number> {
  const [r] = await sql`SELECT revision FROM registry_active WHERE organization_id = ${s.organizationId} AND workspace_id = ${ws(s)} AND kind = ${s.kind} AND slug = ${s.slug}`;
  return (r?.revision as number | undefined) ?? 0;
}
/** Pins the CURRENT active version to a job; the job keeps using that exact digest even if the registry later changes. */
export async function pinForJob(sql: Sql, jobId: string, s: Scope & { kind: "skill" | "agent"; slug: string }): Promise<{ versionId: string; digest: string }> {
  const a = (await getActive(sql, s)) ?? fail("NOT_ACTIVE", "no approved active version to pin");
  await sql`INSERT INTO job_skill_pins (job_id, version_id, digest) VALUES (${jobId}, ${a.versionId}, ${a.digest}) ON CONFLICT DO NOTHING`;
  return { versionId: a.versionId, digest: a.digest };
}
export async function pinnedVersion(sql: Sql, jobId: string, slug: string): Promise<{ versionId: string; digest: string } | null> {
  const [r] = await sql`SELECT p.version_id, p.digest FROM job_skill_pins p JOIN skill_versions v ON v.id = p.version_id WHERE p.job_id = ${jobId} AND v.slug = ${slug}`;
  return r ? { versionId: r.version_id as string, digest: r.digest as string } : null;
}
