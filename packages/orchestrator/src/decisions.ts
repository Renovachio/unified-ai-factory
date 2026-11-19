import { createHash } from "node:crypto";
import { appendEvent, ConflictError, transitionJob, type Sql } from "@factory/db";
import { requiresHumanApproval, type EvidenceBinding, type RiskLevel } from "@factory/domain";
import { canonicalJson, digestOf, redactString } from "@factory/telemetry";
import type { ReviewPort } from "./ports";
import { currentEvidenceBinding } from "./snapshot";

export type DecisionCode = "validation" | "not-found" | "not-awaiting-approval" | "version-conflict" | "stale-evidence" | "self-approval" | "idempotency-conflict" | "idempotency-in-flight";
export class DecisionRejected extends Error {
  constructor(readonly code: DecisionCode, message: string, readonly detail?: Record<string, unknown>) { super(message); this.name = "DecisionRejected"; }
}

export interface DecisionInput {
  jobId: string;
  orgId: string;
  actorId: string;
  idempotencyKey: string;
  decision: "approve" | "reject" | "rework";
  headSha: string;
  baseSha: string;
  policyDigest: string;
  expectedVersion: number;
  reason?: string | undefined;
}
export interface DecisionResult { decisionId: string; state: string; version: number; replayed: boolean }

const SHA = /^[a-f0-9]{40}$/;

/**
 * Persists a bounded, SHA-bound human authorization. It does NOT merge: it records the approval together with the FULL evidence binding
 * (head, base, policy digest, gate config, reviewer set, spec, ...) and moves the job AWAITING_HUMAN -> PREMERGE; the privileged merge
 * coordinator re-validates everything freshly. Evidence that no longer matches is refused (409), never stored.
 */
export async function recordDecision(sql: Sql, review: Pick<ReviewPort, "requiredRoles">, i: DecisionInput): Promise<DecisionResult> {
  if (!SHA.test(i.headSha) || !SHA.test(i.baseSha) || !/^sha256:[a-f0-9]{64}$/.test(i.policyDigest) || !Number.isInteger(i.expectedVersion) || i.expectedVersion < 1)
    throw new DecisionRejected("validation", "headSha/baseSha must be 40-hex, policyDigest sha256:<64-hex>, expectedVersion a positive integer");
  if ((i.decision === "reject" || i.decision === "rework") && (!i.reason || i.reason.length < 1 || i.reason.length > 1000)) throw new DecisionRejected("validation", "a reason (1..1000 chars) is required for reject and rework");
  const route = `POST /jobs/${i.jobId}/decisions`;
  const requestHash = createHash("sha256").update(canonicalJson({ d: i.decision, h: i.headSha, b: i.baseSha, p: i.policyDigest, v: i.expectedVersion, r: i.reason ?? null })).digest("hex");

  // Idempotency: the key row is claimed first, in its own short transaction, so a concurrent duplicate waits on the unique key.
  const claim = await sql.begin(async (tx) => {
    const [fresh] = await tx<{ id: string }[]>`INSERT INTO idempotency_keys (actor_id, route, idempotency_key, request_hash) VALUES (${i.actorId}, ${route}, ${i.idempotencyKey}, ${requestHash}) ON CONFLICT (actor_id, route, idempotency_key) DO NOTHING RETURNING id`;
    if (fresh) return { fresh: true as const, id: fresh.id };
    const [prior] = await tx<{ request_hash: string; response_body: DecisionResult | null }[]>`SELECT request_hash, response_body FROM idempotency_keys WHERE actor_id = ${i.actorId} AND route = ${route} AND idempotency_key = ${i.idempotencyKey}`;
    if (!prior || prior.request_hash !== requestHash) throw new DecisionRejected("idempotency-conflict", "Idempotency-Key was already used with a different decision");
    if (!prior.response_body) throw new DecisionRejected("idempotency-in-flight", "a request with this Idempotency-Key is still being processed");
    return { fresh: false as const, replay: { ...prior.response_body, replayed: true } };
  });
  if (!claim.fresh) return claim.replay;

  try {
    const { binding, job } = await currentEvidenceBinding(sql, review, i.jobId);
    const [scope] = await sql<{ org: string }[]>`SELECT r.organization_id AS org FROM jobs j JOIN repositories r ON r.id = j.repository_id WHERE j.id = ${i.jobId}`;
    if (!scope || scope.org !== i.orgId) throw new DecisionRejected("not-found", "job not found");
    if (job.state !== "AWAITING_HUMAN") throw new DecisionRejected("not-awaiting-approval", `job is ${job.state}, not AWAITING_HUMAN`);
    if (job.version !== i.expectedVersion) throw new DecisionRejected("version-conflict", `job version is ${job.version}, expected ${i.expectedVersion}`);
    if (!binding) throw new DecisionRejected("stale-evidence", "the job has no complete evidence binding (gate/head/base) to approve");
    const diff = ([["headSha", i.headSha, binding.headSha], ["baseSha", i.baseSha, binding.baseSha], ["policyDigest", i.policyDigest, binding.policyDigest]] as const).filter(([, given, cur]) => given !== cur).map(([f]) => f);
    if (diff.length) throw new DecisionRejected("stale-evidence", `the approval refers to evidence that no longer matches: ${diff.join(", ")}`, { mismatched: diff });
    if (i.decision === "approve" && requiresHumanApproval(job.risk as RiskLevel) && job.created_by === i.actorId) throw new DecisionRejected("self-approval", "the requester cannot approve their own HIGH/CRITICAL change");

    const next = i.decision === "approve" ? "PREMERGE" : i.decision === "reject" ? "REJECTED" : "REWORK";
    let decisionId = "";
    const out = await transitionJob(sql, {
      jobId: i.jobId, expectedVersion: i.expectedVersion, next, actor: i.actorId, reason: i.reason ?? `human ${i.decision}`, evidence: { decision: i.decision, head: i.headSha },
      guard: async (_row, tx) => {
        const [row] = await tx<{ id: string }[]>`INSERT INTO approvals (job_id, head_sha, base_sha, policy_digest, actor_id, decision, reason, binding) VALUES (${i.jobId}, ${i.headSha}, ${i.baseSha}, ${i.policyDigest}, ${i.actorId}, ${i.decision}, ${i.reason ? redactString(i.reason) : null}, ${tx.json(binding as unknown as never)}) RETURNING id`;
        decisionId = (row as { id: string }).id;
        await appendEvent(tx, { jobId: i.jobId, type: "approval.recorded", source: "api", actorId: i.actorId, payload: { decision: i.decision, head_sha: i.headSha, base_sha: i.baseSha, policy_digest: i.policyDigest, decision_id: decisionId } });
        if (i.decision === "rework") await appendEvent(tx, { jobId: i.jobId, type: "human.changes_requested", source: "api", actorId: i.actorId, payload: { head_sha: i.headSha, message: redactString(i.reason ?? "") } });
        await tx`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest) VALUES (${i.orgId}, ${i.actorId}, ${`approval.${i.decision}`}, ${`job:${i.jobId}`}, 'ok', ${i.reason ? redactString(i.reason).slice(0, 500) : null}, ${digestOf({ job: i.jobId, decision: i.decision, head: i.headSha, base: i.baseSha, binding })})`;
      },
    });
    const result: DecisionResult = { decisionId, state: next, version: out.version, replayed: false };
    await sql`UPDATE idempotency_keys SET response_status = 202, response_body = ${sql.json(result as unknown as never)}, job_id = ${i.jobId} WHERE id = ${claim.id}`;
    return result;
  } catch (e) {
    // A rejected attempt releases its key so the caller can retry with corrected evidence.
    await sql`DELETE FROM idempotency_keys WHERE id = ${claim.id} AND response_status IS NULL`;
    if (e instanceof ConflictError) throw new DecisionRejected("version-conflict", e.message);
    throw e;
  }
}

export type { EvidenceBinding };
