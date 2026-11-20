import { digestOf } from "@factory/telemetry";
import type { Q, Sql } from "@factory/db";
import {
  APPROVER_ROLES,
  assertTransition,
  claimHash,
  isUsable,
  MEMORY_SENSITIVITIES,
  MemoryError,
  PROPOSER_ROLES,
  READER_ROLES,
  STEWARD_ROLES,
  validateClaim,
  type MemoryKind,
  type MemorySensitivity,
  type MemoryStatus,
} from "./domain";

/**
 * Canonical memory lifecycle (MEM-01). Every operation: authenticates the actor's role inside the organization, scopes
 * every row to organization AND project, writes the status change, its append-only transition and an audit entry in ONE
 * transaction, and fails closed on any doubt. Nothing here calls a model: approval is a human action.
 */

export interface Actor {
  organizationId: string;
  userId: string;
}

export type SourceKind = "artifact" | "event";
export interface SourceRef {
  kind: SourceKind;
  /** artifacts.id or events.id */
  id: string;
  /** Must equal the digest stored on the artifact/event: a caller cannot cite content it does not match. */
  digest: string;
  extractionMethod: "user_statement" | "deterministic" | "candidate_llm";
  aclDigest: string;
  span?: Record<string, unknown>;
}

export interface ProposeInput {
  projectId: string;
  kind: MemoryKind;
  claim: string;
  sources: SourceRef[];
  sensitivity?: MemorySensitivity;
}

export interface MemorySourceView {
  id: string;
  sourceKind: SourceKind;
  sourceId: string;
  digest: string;
  extractionMethod: string;
  aclDigest: string;
  revoked: boolean;
}

export interface MemoryView {
  id: string;
  organizationId: string;
  projectId: string;
  kind: MemoryKind;
  claim: string;
  status: MemoryStatus;
  sensitivity: MemorySensitivity;
  recordVersion: number;
  supersedesId: string | null;
  supersededBy: string | null;
  createdBy: string;
  approvedBy: string | null;
  validFrom: Date;
  validTo: Date | null;
  sourceDigest: string;
  createdAt: Date;
  sources: MemorySourceView[];
  /** True only for an approved memory whose sources are all still valid. Retrieval (MEM-03) must use this, not status alone. */
  usable: boolean;
}

type Row = Record<string, unknown>;

/** First element or a loud internal error; used where the database guarantees a row (RETURNING, FOR UPDATE). */
export function one<T>(rows: readonly T[], what: string): T {
  const r = rows[0];
  if (r === undefined) throw new Error(`internal: expected a row for ${what}`);
  return r;
}

/** Database rejections from the guards/constraints become typed errors; anything else is rethrown untouched. */
export function mapDbError(e: unknown): never {
  if (e instanceof MemoryError) throw e;
  const code = (e as { code?: string }).code;
  if (code === "P0001" || code === "23514" || code === "23505") throw new MemoryError("DB_REJECTED", String((e as Error).message).slice(0, 200));
  throw e;
}

export async function requireActor(q: Q, actor: Actor, roles: readonly string[]): Promise<string> {
  const [u] = await q<{ role: string; disabled_at: Date | null }[]>`SELECT role, disabled_at FROM users WHERE id = ${actor.userId} AND organization_id = ${actor.organizationId}`;
  if (!u || u.disabled_at || !roles.includes(u.role)) throw new MemoryError("FORBIDDEN", "actor lacks the role for this memory operation");
  return u.role;
}

export async function requireProject(q: Q, organizationId: string, projectId: string): Promise<void> {
  const [p] = await q`SELECT id FROM repositories WHERE id = ${projectId} AND organization_id = ${organizationId}`;
  if (!p) throw new MemoryError("NOT_FOUND", "no such project");
}

export async function lockMemory(q: Q, organizationId: string, projectId: string, memoryId: string): Promise<Row> {
  const [m] = await q<Row[]>`SELECT * FROM memory_records WHERE id = ${memoryId} AND organization_id = ${organizationId} AND project_id = ${projectId} FOR UPDATE`;
  if (!m) throw new MemoryError("NOT_FOUND", "no such memory in this project");
  return m;
}

export async function recordTransition(
  q: Q,
  m: { id: string; organizationId: string; recordVersion: number },
  from: MemoryStatus | null,
  to: MemoryStatus,
  actor: Actor,
  reason: string | null,
  evidence: Record<string, unknown>,
): Promise<void> {
  const evidenceDigest = digestOf({ memory: m.id, from, to, version: m.recordVersion, ...evidence });
  await q`INSERT INTO memory_transitions (memory_id, from_status, to_status, record_version, actor_id, actor, reason, evidence_digest)
    VALUES (${m.id}, ${from}, ${to}, ${m.recordVersion}, ${actor.userId}, ${actor.userId}, ${reason}, ${evidenceDigest})`;
  await q`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest)
    VALUES (${m.organizationId}, ${actor.userId}, ${"memory." + to}, ${"memory:" + m.id}, 'ok', ${reason}, ${evidenceDigest})`;
}

export async function viewsOf(q: Q, rows: Row[]): Promise<MemoryView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id as string);
  const srcs = await q<Row[]>`SELECT * FROM memory_sources WHERE memory_id = ANY(${ids}::uuid[]) ORDER BY created_at, id`;
  return rows.map((r) => {
    const sources: MemorySourceView[] = srcs
      .filter((s) => s.memory_id === r.id)
      .map((s) => ({
        id: s.id as string,
        sourceKind: (s.artifact_id ? "artifact" : "event") as SourceKind,
        sourceId: (s.artifact_id ?? s.event_id) as string,
        digest: s.source_digest as string,
        extractionMethod: s.extraction_method as string,
        aclDigest: s.acl_digest as string,
        revoked: s.revoked_at != null,
      }));
    const status = r.status as MemoryStatus;
    const revoked = sources.filter((s) => s.revoked).length;
    const validTo = (r.valid_to as Date | null) ?? null;
    return {
      id: r.id as string,
      organizationId: r.organization_id as string,
      projectId: r.project_id as string,
      kind: r.kind as MemoryKind,
      claim: r.claim as string,
      status,
      sensitivity: r.sensitivity as MemorySensitivity,
      recordVersion: r.record_version as number,
      supersedesId: (r.supersedes_id as string | null) ?? null,
      supersededBy: (r.superseded_by as string | null) ?? null,
      createdBy: r.created_by as string,
      approvedBy: (r.approved_by as string | null) ?? null,
      validFrom: r.valid_from as Date,
      validTo,
      sourceDigest: r.source_digest as string,
      createdAt: r.created_at as Date,
      sources,
      usable: isUsable(status, revoked) && validTo === null,
    };
  });
}

function sourceDigestOf(sources: SourceRef[]): string {
  return digestOf(
    [...sources]
      .map((s) => ({ kind: s.kind, id: s.id, digest: s.digest }))
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
  );
}

/**
 * Every source must be an artifact or event of THIS project (through its job), in this organization, and its digest must
 * match what is stored. A mismatch is reported as SCOPE_MISMATCH without revealing whether the other row exists.
 */
export async function sourceInProject(q: Q, organizationId: string, projectId: string, kind: SourceKind, id: string): Promise<boolean> {
  const rows = kind === "artifact"
    ? await q`SELECT a.id FROM artifacts a JOIN jobs j ON j.id = a.job_id JOIN repositories r ON r.id = j.repository_id
        WHERE a.id = ${id} AND r.id = ${projectId} AND r.organization_id = ${organizationId}`
    : await q`SELECT e.id FROM events e JOIN jobs j ON j.id = e.job_id JOIN repositories r ON r.id = j.repository_id
        WHERE e.id = ${id} AND r.id = ${projectId} AND r.organization_id = ${organizationId}`;
  return rows.length > 0;
}

export async function verifySources(q: Q, organizationId: string, projectId: string, sources: SourceRef[]): Promise<void> {
  if (sources.length === 0) throw new MemoryError("NO_SOURCE", "a memory needs at least one source; abstain instead of inventing one");
  for (const s of sources) {
    const [revoked] = await q`SELECT 1 FROM memory_source_revocations WHERE project_id = ${projectId} AND source_kind = ${s.kind} AND source_id = ${s.id}`;
    if (revoked) throw new MemoryError("SOURCE_REVOKED", "a revoked source cannot back a new memory");
    const rows = s.kind === "artifact"
      ? await q`SELECT a.id FROM artifacts a JOIN jobs j ON j.id = a.job_id JOIN repositories r ON r.id = j.repository_id
          WHERE a.id = ${s.id} AND a.digest = ${s.digest} AND r.id = ${projectId} AND r.organization_id = ${organizationId}`
      : await q`SELECT e.id FROM events e JOIN jobs j ON j.id = e.job_id JOIN repositories r ON r.id = j.repository_id
          WHERE e.id = ${s.id} AND e.digest = ${s.digest} AND r.id = ${projectId} AND r.organization_id = ${organizationId}`;
    if (rows.length === 0) throw new MemoryError("SCOPE_MISMATCH", "source is not an authorized, digest-matching item of this project");
  }
}

export async function insertProposal(
  tx: Q,
  actor: Actor,
  i: { projectId: string; kind: MemoryKind; claim: string; sources: SourceRef[]; sensitivity: MemorySensitivity; recordVersion: number; supersedesId: string | null; isConsolidation?: boolean },
): Promise<MemoryView> {
  const hash = claimHash(i.claim);
  const sourceDigest = sourceDigestOf(i.sources);
  const [existing] = await tx<Row[]>`SELECT * FROM memory_records WHERE organization_id = ${actor.organizationId} AND project_id = ${i.projectId}
    AND normalized_claim_hash = ${hash} AND source_digest = ${sourceDigest} AND record_version = ${i.recordVersion} AND status <> 'deleted'`;
  if (existing) return one(await viewsOf(tx, [existing]), "existing memory"); // idempotent: the same claim from the same sources is one record
  const row = one(await tx<Row[]>`INSERT INTO memory_records (organization_id, project_id, kind, claim, normalized_claim_hash, source_digest, sensitivity,
      record_version, supersedes_id, created_by, is_consolidation)
    VALUES (${actor.organizationId}, ${i.projectId}, ${i.kind}, ${i.claim}, ${hash}, ${sourceDigest}, ${i.sensitivity},
      ${i.recordVersion}, ${i.supersedesId}, ${actor.userId}, ${i.isConsolidation === true})
    RETURNING *`, "inserted memory");
  const id = row.id as string;
  for (const s of i.sources) {
    await tx`INSERT INTO memory_sources (memory_id, organization_id, project_id, artifact_id, event_id, source_digest, source_span, extraction_method, acl_digest)
      VALUES (${id}, ${actor.organizationId}, ${i.projectId}, ${s.kind === "artifact" ? s.id : null}, ${s.kind === "event" ? s.id : null},
        ${s.digest}, ${s.span ? tx.json(s.span as never) : null}, ${s.extractionMethod}, ${s.aclDigest})`;
  }
  await recordTransition(tx, { id, organizationId: actor.organizationId, recordVersion: i.recordVersion }, null, "proposed", actor, null, { sources: sourceDigest });
  return one(await viewsOf(tx, [row]), "inserted memory view");
}

/** Creates a PROPOSED memory. Proposing never makes it usable; only a human approval does. Idempotent per claim and source set. */
export async function proposeMemory(sql: Sql, actor: Actor, input: ProposeInput): Promise<MemoryView> {
  const claim = validateClaim(input.claim);
  const sensitivity = input.sensitivity ?? "internal";
  if (!(MEMORY_SENSITIVITIES as readonly string[]).includes(sensitivity)) throw new MemoryError("INVALID_CLAIM", "unknown sensitivity");
  const base = { projectId: input.projectId, kind: input.kind, claim, sources: input.sources, sensitivity, recordVersion: 1, supersedesId: null };
  try {
    return await sql.begin(async (tx) => {
      await requireActor(tx, actor, PROPOSER_ROLES);
      await requireProject(tx, actor.organizationId, input.projectId);
      await verifySources(tx, actor.organizationId, input.projectId, input.sources);
      return insertProposal(tx, actor, base);
    }) as MemoryView;
  } catch (e) {
    mapDbError(e);
  }
}

/** Proposes a NEW version of an approved memory. The old version stays immutable until the new one is approved. */
export async function proposeRevision(sql: Sql, actor: Actor, supersedesId: string, input: { claim: string; sources: SourceRef[] }): Promise<MemoryView> {
  const claim = validateClaim(input.claim);
  try {
    return await sql.begin(async (tx) => {
      await requireActor(tx, actor, PROPOSER_ROLES);
      const old = await lockMemory(tx, actor.organizationId, await projectOf(tx, actor.organizationId, supersedesId), supersedesId);
      if (old.status !== "approved") throw new MemoryError("WRONG_STATE", "only an approved memory can be revised");
      const projectId = old.project_id as string;
      await verifySources(tx, actor.organizationId, projectId, input.sources);
      return insertProposal(tx, actor, {
        projectId,
        kind: old.kind as MemoryKind,
        claim,
        sources: input.sources,
        sensitivity: old.sensitivity as MemorySensitivity,
        recordVersion: (old.record_version as number) + 1,
        supersedesId,
      });
    }) as MemoryView;
  } catch (e) {
    mapDbError(e);
  }
}

async function projectOf(q: Q, organizationId: string, memoryId: string): Promise<string> {
  const [m] = await q<{ project_id: string }[]>`SELECT project_id FROM memory_records WHERE id = ${memoryId} AND organization_id = ${organizationId}`;
  if (!m) throw new MemoryError("NOT_FOUND", "no such memory");
  return m.project_id;
}

/**
 * Human approval of one exact proposed memory. The approver must not be its author, the memory needs at least one source
 * and none may be revoked. If it revises an approved memory, the old version is superseded in the same transaction.
 */
export async function approveMemory(sql: Sql, actor: Actor, projectId: string, memoryId: string): Promise<MemoryView> {
  try {
    return await sql.begin(async (tx) => {
      await requireActor(tx, actor, APPROVER_ROLES);
      const m = await lockMemory(tx, actor.organizationId, projectId, memoryId);
      const from = m.status as MemoryStatus;
      assertTransition(from, "approved");
      if (m.created_by === actor.userId) throw new MemoryError("SELF_APPROVAL", "the author cannot approve their own memory");
      const srcs = await tx<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM memory_sources WHERE memory_id = ${memoryId}`;
      if (srcs.length === 0) throw new MemoryError("NO_SOURCE", "memory has no source");
      if (srcs.some((s) => s.revoked_at != null)) throw new MemoryError("SOURCE_REVOKED", "a source of this memory was revoked");
      const view = { id: memoryId, organizationId: actor.organizationId, recordVersion: m.record_version as number };
      // A consolidated memory supersedes its originals ONLY if every original is still approved. Otherwise fail closed.
      const originals = await tx<Row[]>`SELECT o.id, o.status, o.record_version FROM memory_consolidations c
        JOIN memory_records o ON o.id = c.original_id WHERE c.consolidated_id = ${memoryId} FOR UPDATE OF o`;
      if (originals.some((o) => o.status !== "approved")) throw new MemoryError("WRONG_STATE", "an original of this consolidation is no longer approved; re-propose the consolidation");
      await tx`UPDATE memory_records SET status = 'approved', approved_by = ${actor.userId}, updated_at = now() WHERE id = ${memoryId}`;
      await recordTransition(tx, view, from, "approved", actor, null, {});
      for (const o of originals) {
        await tx`UPDATE memory_records SET status = 'superseded', superseded_by = ${memoryId}, valid_to = now(), updated_at = now() WHERE id = ${o.id as string}`;
        await recordTransition(tx, { id: o.id as string, organizationId: actor.organizationId, recordVersion: o.record_version as number }, "approved", "superseded", actor, `consolidated into ${memoryId}`, { successor: memoryId });
      }
      const supersedes = m.supersedes_id as string | null;
      if (supersedes) {
        const [old] = await tx<Row[]>`SELECT * FROM memory_records WHERE id = ${supersedes} FOR UPDATE`;
        if (old && old.status === "approved") {
          await tx`UPDATE memory_records SET status = 'superseded', superseded_by = ${memoryId}, valid_to = now(), updated_at = now() WHERE id = ${supersedes}`;
          await recordTransition(tx, { id: supersedes, organizationId: actor.organizationId, recordVersion: old.record_version as number }, "approved", "superseded", actor, null, { successor: memoryId });
        }
      }
      return one(await viewsOf(tx, [await reload(tx, memoryId)]), "memory view");
    }) as MemoryView;
  } catch (e) {
    mapDbError(e);
  }
}

export async function reload(q: Q, memoryId: string): Promise<Row> {
  const [r] = await q<Row[]>`SELECT * FROM memory_records WHERE id = ${memoryId}`;
  if (!r) throw new MemoryError("NOT_FOUND", "no such memory");
  return r;
}

export async function rejectMemory(sql: Sql, actor: Actor, projectId: string, memoryId: string, reason: string): Promise<MemoryView> {
  if (!reason.trim()) throw new MemoryError("INVALID_CLAIM", "a rejection needs a reason");
  try {
    return await sql.begin(async (tx) => {
      await requireActor(tx, actor, APPROVER_ROLES);
      const m = await lockMemory(tx, actor.organizationId, projectId, memoryId);
      const from = m.status as MemoryStatus;
      assertTransition(from, "rejected");
      await tx`UPDATE memory_records SET status = 'rejected', updated_at = now() WHERE id = ${memoryId}`;
      await recordTransition(tx, { id: memoryId, organizationId: actor.organizationId, recordVersion: m.record_version as number }, from, "rejected", actor, reason, {});
      return one(await viewsOf(tx, [await reload(tx, memoryId)]), "memory view");
    }) as MemoryView;
  } catch (e) {
    mapDbError(e);
  }
}

/**
 * Revokes ONE evidence item (an artifact or event) across the project. Its provenance rows are marked revoked and every
 * proposed or approved memory that cites it becomes `revoked`. Revocation cannot be undone; re-approval needs a new record.
 */
export async function revokeSource(
  sql: Sql,
  actor: Actor,
  projectId: string,
  source: { kind: SourceKind; id: string },
  reason: string,
): Promise<{ revokedSources: number; revokedMemories: string[] }> {
  if (!reason.trim()) throw new MemoryError("INVALID_CLAIM", "a revocation needs a reason");
  try {
    return await sql.begin(async (tx) => {
      await requireActor(tx, actor, STEWARD_ROLES);
      await requireProject(tx, actor.organizationId, projectId);
      if (!(await sourceInProject(tx, actor.organizationId, projectId, source.kind, source.id))) throw new MemoryError("SCOPE_MISMATCH", "source is not an item of this project");
      await tx`INSERT INTO memory_source_revocations (organization_id, project_id, source_kind, source_id, reason, revoked_by)
        VALUES (${actor.organizationId}, ${projectId}, ${source.kind}, ${source.id}, ${reason}, ${actor.userId})
        ON CONFLICT (project_id, source_kind, source_id) DO NOTHING`;
      const col = source.kind === "artifact" ? "artifact_id" : "event_id";
      const marked = await tx.unsafe<{ memory_id: string }[]>(
        `UPDATE memory_sources SET revoked_at = now() WHERE ${col} = $1 AND project_id = $2 AND organization_id = $3 AND revoked_at IS NULL RETURNING memory_id`,
        [source.id, projectId, actor.organizationId],
      );
      const memIds = [...new Set(marked.map((r) => r.memory_id))];
      const revokedMemories: string[] = [];
      for (const memId of memIds) {
        const m = await lockMemory(tx, actor.organizationId, projectId, memId);
        const from = m.status as MemoryStatus;
        if (from !== "proposed" && from !== "approved") continue;
        assertTransition(from, "revoked");
        await tx`UPDATE memory_records SET status = 'revoked', updated_at = now() WHERE id = ${memId}`;
        await recordTransition(tx, { id: memId, organizationId: actor.organizationId, recordVersion: m.record_version as number }, from, "revoked", actor, reason, { source: source.id });
        revokedMemories.push(memId);
      }
      return { revokedSources: marked.length, revokedMemories };
    });
  } catch (e) {
    mapDbError(e);
  }
}

/**
 * Erases a memory: content and content-derived hash are removed, status becomes `deleted`, a content-free tombstone and
 * the transition are kept. Allowed to the author or a steward. Idempotent for an already-erased memory.
 */
export async function eraseMemory(sql: Sql, actor: Actor, projectId: string, memoryId: string, reason: string): Promise<MemoryView> {
  if (!reason.trim() || reason.length > 500) throw new MemoryError("INVALID_CLAIM", "an erasure needs a reason of at most 500 characters");
  try {
    return await sql.begin(async (tx) => {
      const role = await requireActor(tx, actor, READER_ROLES);
      const m = await lockMemory(tx, actor.organizationId, projectId, memoryId);
      if (!(STEWARD_ROLES as readonly string[]).includes(role) && m.created_by !== actor.userId) throw new MemoryError("FORBIDDEN", "only the author or a steward can erase this memory");
      if (m.status === "deleted") return one(await viewsOf(tx, [m]), "erased memory view");
      const from = m.status as MemoryStatus;
      assertTransition(from, "deleted");
      await tx`UPDATE memory_records SET status = 'deleted', claim = '', normalized_claim_hash = 'erased', updated_at = now() WHERE id = ${memoryId}`;
      await tx`INSERT INTO memory_tombstones (memory_id, organization_id, project_id, requested_by, reason)
        VALUES (${memoryId}, ${actor.organizationId}, ${projectId}, ${actor.userId}, ${reason})`;
      await recordTransition(tx, { id: memoryId, organizationId: actor.organizationId, recordVersion: m.record_version as number }, from, "deleted", actor, reason, {});
      return one(await viewsOf(tx, [await reload(tx, memoryId)]), "memory view");
    }) as MemoryView;
  } catch (e) {
    mapDbError(e);
  }
}

/** Reads one memory. Scoped to the organization AND the project named by the caller; any mismatch is NOT_FOUND. */
export async function getMemory(sql: Sql, actor: Actor, projectId: string, memoryId: string): Promise<MemoryView> {
  await requireActor(sql, actor, READER_ROLES);
  const [r] = await sql<Row[]>`SELECT * FROM memory_records WHERE id = ${memoryId} AND organization_id = ${actor.organizationId} AND project_id = ${projectId}`;
  if (!r) throw new MemoryError("NOT_FOUND", "no such memory in this project");
  return one(await viewsOf(sql, [r]), "memory view");
}

/** Memories a task may treat as current knowledge: approved, unrevoked, not superseded. Read-side fail-closed filter. */
export async function listCurrentMemories(sql: Sql, actor: Actor, projectId: string): Promise<MemoryView[]> {
  await requireActor(sql, actor, READER_ROLES);
  const rows = await sql<Row[]>`SELECT * FROM memory_records WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId}
    AND status = 'approved' AND valid_to IS NULL
    AND EXISTS (SELECT 1 FROM memory_sources s WHERE s.memory_id = memory_records.id) ORDER BY created_at, id`;
  return (await viewsOf(sql, rows)).filter((v) => v.usable);
}

/** Lists every memory of a project, including historical ones, for review screens (MEM-07). */
export async function listMemories(sql: Sql, actor: Actor, projectId: string): Promise<MemoryView[]> {
  await requireActor(sql, actor, READER_ROLES);
  const rows = await sql<Row[]>`SELECT * FROM memory_records WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId} ORDER BY created_at, id`;
  return viewsOf(sql, rows);
}
