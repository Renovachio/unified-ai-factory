import type { Sql } from "@factory/db";
import {
  conflictsOf, insertProposal, lockProjectApprovals, mapDbError, recordTransition, requireActor, requireProject, type Actor, type MemoryView, type SourceRef, verifySources,
} from "./lifecycle";
import { APPROVER_ROLES, MemoryError, normalizeClaim, PROPOSER_ROLES, READER_ROLES, SENSITIVITY_RANK, validateClaim, type MemoryKind, type MemorySensitivity } from "./domain";

/**
 * Consolidation (MEM-05). A consolidated memory is PROPOSED from 2..20 approved originals of one kind in one project. Proposing
 * changes nothing about the originals. Only a human approval of the consolidated memory supersedes them (lifecycle.approveMemory),
 * and it refuses if any original changed meanwhile. No approval is ever inferred or created automatically.
 */
export const CONSOLIDATION_MIN = 2;
export const CONSOLIDATION_MAX = 20;
/** Review candidates are read-only signals. A human decides; nothing is changed automatically. */
export const REVIEW_SIMILARITY = 0.5;
export const REVIEW_MAX_RECORDS = 500;

type Row = Record<string, unknown>;

export interface ConsolidationInput {
  originalIds: string[];
  claim: string;
  sources: SourceRef[];
}

export async function proposeConsolidation(sql: Sql, actor: Actor, projectId: string, input: ConsolidationInput): Promise<MemoryView> {
  const ids = input.originalIds;
  try {
    return await sql.begin(async (tx) => {
      // Authorization first: an unauthorized caller learns nothing from input-shape errors.
      await requireActor(tx, actor, PROPOSER_ROLES);
      await requireProject(tx, actor.organizationId, projectId);
      const claim = validateClaim(input.claim);
      if (new Set(ids).size !== ids.length) throw new MemoryError("INVALID_CONSOLIDATION", "originals must be distinct");
      if (ids.length < CONSOLIDATION_MIN || ids.length > CONSOLIDATION_MAX) {
        throw new MemoryError("INVALID_CONSOLIDATION", `a consolidation needs ${CONSOLIDATION_MIN}..${CONSOLIDATION_MAX} originals`);
      }
      const originals = await tx<Row[]>`SELECT id, status, kind, sensitivity, record_version FROM memory_records
        WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId} AND id = ANY(${ids}::uuid[]) FOR UPDATE`;
      if (originals.length !== ids.length) throw new MemoryError("NOT_FOUND", "one or more originals are not in this project");
      if (originals.some((o) => o.status !== "approved")) throw new MemoryError("WRONG_STATE", "only approved memories can be consolidated");
      const kinds = new Set(originals.map((o) => o.kind as string));
      if (kinds.size !== 1) throw new MemoryError("INVALID_CONSOLIDATION", "originals must share one kind");
      const [busy] = await tx`SELECT 1 FROM memory_consolidations c JOIN memory_records p ON p.id = c.consolidated_id
        WHERE c.original_id = ANY(${ids}::uuid[]) AND p.status = 'proposed'`;
      if (busy) throw new MemoryError("WRONG_STATE", "an original is already part of a pending consolidation");
      await verifySources(tx, actor.organizationId, projectId, input.sources);
      const sensitivity = originals
        .map((o) => o.sensitivity as MemorySensitivity)
        .reduce((a, b) => (SENSITIVITY_RANK[b] > SENSITIVITY_RANK[a] ? b : a));
      const view = await insertProposal(tx, actor, {
        projectId, kind: [...kinds][0] as MemoryKind, claim, sources: input.sources, sensitivity, recordVersion: 1, supersedesId: null,
        isConsolidation: true,
      });
      // An identical claim and source set may already exist as a PLAIN memory. That record must never receive links.
      const [flag] = await tx<{ is_consolidation: boolean }[]>`SELECT is_consolidation FROM memory_records WHERE id = ${view.id}`;
      if (flag?.is_consolidation !== true) throw new MemoryError("WRONG_STATE", "an identical claim and sources already exist as a plain memory");
      // An identical proposal (same claim and sources) returns the existing record. Its links must be exactly the requested set.
      const existing = (await tx<{ original_id: string }[]>`SELECT original_id FROM memory_consolidations WHERE consolidated_id = ${view.id}`).map((r) => r.original_id).sort();
      const requested = [...ids].sort();
      if (existing.length === 0) {
        for (const id of ids) {
          await tx`INSERT INTO memory_consolidations (organization_id, project_id, consolidated_id, original_id, created_by)
            VALUES (${actor.organizationId}, ${projectId}, ${view.id}, ${id}, ${actor.userId})`;
        }
      } else if (existing.join(",") !== requested.join(",")) {
        throw new MemoryError("WRONG_STATE", "an identical claim and sources already consolidate a different set of originals");
      }
      return view;
    }) as MemoryView;
  } catch (e) {
    mapDbError(e);
  }
}

export interface ReviewCandidates {
  /** Approved memories whose normalized claim is identical. Ids only: no claim text is returned. */
  duplicateGroups: string[][];
  /** Approved same-kind memories with different claims but high token overlap. May be duplicates with edits, or conflicts. */
  possibleConflicts: Array<{ a: string; b: string; similarity: number }>;
}

/** Read-only review signals for approved memories. It changes nothing and never decides a conflict. */
export async function findReviewCandidates(sql: Sql, actor: Actor, projectId: string): Promise<ReviewCandidates> {
  await requireActor(sql, actor, READER_ROLES);
  await requireProject(sql, actor.organizationId, projectId);
  const rows = await sql<{ id: string; kind: string; normalized_claim_hash: string; claim: string }[]>`
    SELECT id, kind, normalized_claim_hash, claim FROM memory_records
    WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId} AND status = 'approved'
    ORDER BY created_at, id LIMIT ${REVIEW_MAX_RECORDS}`;
  const byHash = new Map<string, string[]>();
  for (const r of rows) byHash.set(r.normalized_claim_hash, [...(byHash.get(r.normalized_claim_hash) ?? []), r.id]);
  const duplicateGroups = [...byHash.values()].filter((g) => g.length > 1);
  const tokens = (claim: string) => new Set(normalizeClaim(claim).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0));
  const seen = rows.map((r) => ({ id: r.id, kind: r.kind, hash: r.normalized_claim_hash, t: tokens(r.claim) }));
  const possibleConflicts: ReviewCandidates["possibleConflicts"] = [];
  for (let i = 0; i < seen.length; i++) {
    for (let j = i + 1; j < seen.length; j++) {
      const x = seen[i];
      const y = seen[j];
      if (!x || !y) continue;
      if (x.kind !== y.kind || x.hash === y.hash) continue;
      const inter = [...x.t].filter((t) => y.t.has(t)).length;
      const union = new Set([...x.t, ...y.t]).size;
      const similarity = union === 0 ? 0 : inter / union;
      if (similarity >= REVIEW_SIMILARITY) possibleConflicts.push({ a: x.id, b: y.id, similarity: Math.round(similarity * 1000) / 1000 });
    }
  }
  return { duplicateGroups, possibleConflicts };
}


/**
 * Restores the originals of a consolidated memory that has ENDED (revoked or erased). Human approval only. Every original must
 * still be superseded by this consolidated memory and must have no revoked source, or nothing changes. The consolidated memory
 * itself is not touched. The guard (migrations 0024 and 0025) is the only database path that allows superseded -> approved, and only here.
 */
export async function restoreConsolidation(sql: Sql, actor: Actor, projectId: string, consolidatedId: string): Promise<string[]> {
  try {
    return await sql.begin(async (tx) => {
      await requireActor(tx, actor, APPROVER_ROLES);
      await requireProject(tx, actor.organizationId, projectId);
      const [c] = await tx<Row[]>`SELECT status FROM memory_records WHERE id = ${consolidatedId} AND organization_id = ${actor.organizationId} AND project_id = ${projectId} FOR UPDATE`;
      if (!c) throw new MemoryError("NOT_FOUND", "no such consolidated memory in this project");
      if (c.status !== "revoked" && c.status !== "deleted") throw new MemoryError("WRONG_STATE", "originals can be restored only after their consolidated memory is revoked or erased");
      const originals = await tx<Row[]>`SELECT o.id, o.status, o.superseded_by, o.record_version FROM memory_consolidations l
        JOIN memory_records o ON o.id = l.original_id WHERE l.consolidated_id = ${consolidatedId} FOR UPDATE OF o`;
      if (originals.length === 0) throw new MemoryError("NOT_FOUND", "no originals are linked to this consolidated memory");
      for (const o of originals) {
        if (o.status !== "superseded" || o.superseded_by !== consolidatedId) throw new MemoryError("WRONG_STATE", "an original is no longer superseded by this consolidation");
        const [bad] = await tx`SELECT 1 FROM memory_sources s WHERE s.memory_id = ${o.id as string} AND (s.revoked_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM memory_source_revocations rv WHERE rv.project_id = s.project_id
            AND rv.source_kind = CASE WHEN s.artifact_id IS NOT NULL THEN 'artifact' ELSE 'event' END
            AND rv.source_id = COALESCE(s.artifact_id, s.event_id))) LIMIT 1`;
        if (bad) throw new MemoryError("SOURCE_REVOKED", "an original has a revoked source and cannot be restored");
      }
      // Restoring originals makes them approved again: the same rule as any approval applies (lock, then overlap refusal).
      await lockProjectApprovals(tx, projectId);
      for (const o of originals) {
        const overlaps = await conflictsOf(tx, actor.organizationId, projectId, o.id as string);
        if (overlaps.length > 0) throw new MemoryError("CONFLICT_UNRESOLVED", `an original overlaps approved memory ${overlaps.map((x) => x.id).join(", ")}; resolve that overlap before restoring`);
      }
      const restored: string[] = [];
      for (const o of originals) {
        const id = o.id as string;
        await tx`UPDATE memory_records SET status = 'approved', superseded_by = NULL, valid_to = NULL, updated_at = now() WHERE id = ${id}`;
        await recordTransition(tx, { id, organizationId: actor.organizationId, recordVersion: o.record_version as number }, "superseded", "approved", actor, `restored after consolidation ${consolidatedId} ended`, { restoredFrom: consolidatedId });
        restored.push(id);
      }
      return restored;
    });
  } catch (e) {
    mapDbError(e);
  }
}
