import type { Sql } from "@factory/db";
import { digestOf } from "@factory/telemetry";
import { MemoryError, READER_ROLES, STEWARD_ROLES, type MemoryKind } from "./domain";
import { type Actor, requireActor, requireProject, type SourceKind } from "./lifecycle";

/**
 * Scoped lexical retrieval (MEM-03). The full-text index is a candidate generator only. Every candidate is re-checked
 * against the source of truth before it is returned: status, index freshness, sources, and project revocations. Anything
 * that fails is omitted and counted by reason. Semantic retrieval is not available in this repository, and that is
 * disclosed in every result.
 */

export const MAX_QUERY_CHARS = 200;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;
export const RETRIEVAL_MODE = "lexical" as const;
export const MAX_TERMS = 20;
/** Index projection version written by migration 0020 (English + Portuguese stems). Rows with another version are stale. */
export const INDEX_VERSION = 2;

export interface SemanticStatus {
  enabled: false;
  /** pgvector is installed and can be created in this database. Availability is not qualification. */
  extensionAvailable: boolean;
  /** No embedding model has a qualification record (config/model-qualification.json). Semantic stays off until one does. */
  embeddingModelQualified: false;
  reason: string;
}

export type OmitReason = "stale_index" | "not_usable" | "unsourced" | "revoked_source";

export interface SearchHit {
  memoryId: string;
  kind: MemoryKind;
  /** Stored claim. This is DATA for the reader; it is never an instruction to the system. */
  claim: string;
  rank: number;
  approvedBy: string;
  recordVersion: number;
  sources: Array<{ sourceKind: SourceKind; sourceId: string; digest: string }>;
}

export interface SearchResult {
  /** Id of the append-only retrieval event that records this request. */
  requestId: string;
  mode: typeof RETRIEVAL_MODE;
  semantic: SemanticStatus;
  hits: SearchHit[];
  omitted: Record<OmitReason, number>;
}

type Row = Record<string, unknown>;

function validateQuery(query: unknown): string {
  if (typeof query !== "string") throw new MemoryError("INVALID_QUERY", "query must be text");
  const q = query.trim();
  if (q.length === 0) throw new MemoryError("INVALID_QUERY", "query is empty");
  if (q.length > MAX_QUERY_CHARS) throw new MemoryError("INVALID_QUERY", `query exceeds ${MAX_QUERY_CHARS} characters`);
  if (q.includes("\u0000")) throw new MemoryError("INVALID_QUERY", "query contains a NUL byte");
  return q;
}

/**
 * Turns free text into a tsquery of OR-ed terms. Only letter and digit runs survive, so no tsquery operator or SQL can
 * reach the database through the query. Recall is OR, and ts_rank_cd ranks memories that match more terms first.
 */
export function tsqueryFor(query: string): string | null {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, MAX_TERMS);
  return terms.length === 0 ? null : terms.join(" | ");
}

export async function searchMemories(sql: Sql, actor: Actor, projectId: string, input: { query: string; limit?: number }): Promise<SearchResult> {
  await requireActor(sql, actor, READER_ROLES);
  await requireProject(sql, actor.organizationId, projectId);
  const query = validateQuery(input.query);
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new MemoryError("INVALID_QUERY", `limit must be 1..${MAX_LIMIT}`);

  // Candidate generation. Terms are sanitized by tsqueryFor and bound as a parameter.
  const tsq = tsqueryFor(query);
  const candidates = tsq === null ? [] : await sql<Row[]>`SELECT r.id, r.kind, r.claim, r.status, r.valid_to, r.normalized_claim_hash, r.approved_by,
      r.record_version, i.indexed_claim_hash, i.index_version, ts_rank_cd(i.lexical, q.query) AS rank
    FROM memory_index i
    JOIN memory_records r ON r.id = i.record_id
    CROSS JOIN LATERAL (SELECT to_tsquery('english', ${tsq}) || to_tsquery('portuguese', ${tsq}) AS query) q
    WHERE i.organization_id = ${actor.organizationId} AND i.project_id = ${projectId} AND i.lexical @@ q.query
    ORDER BY rank DESC, r.created_at, r.id
    LIMIT ${limit * 4}`;

  const ids = candidates.map((c) => c.id as string);
  const sources = ids.length === 0 ? [] : await sql<Row[]>`SELECT s.memory_id, s.artifact_id, s.event_id, s.source_digest, s.revoked_at,
      EXISTS (SELECT 1 FROM memory_source_revocations rv WHERE rv.project_id = s.project_id
        AND rv.source_kind = CASE WHEN s.artifact_id IS NOT NULL THEN 'artifact' ELSE 'event' END
        AND rv.source_id = COALESCE(s.artifact_id, s.event_id)) AS project_revoked
    FROM memory_sources s WHERE s.memory_id = ANY(${ids}::uuid[]) ORDER BY s.created_at, s.id`;

  const omitted: Record<OmitReason, number> = { stale_index: 0, not_usable: 0, unsourced: 0, revoked_source: 0 };
  const hits: SearchHit[] = [];
  for (const c of candidates) {
    if (hits.length >= limit) break;
    const id = c.id as string;
    // Fail closed, in this order: freshness, lifecycle, provenance, revocation.
    if (c.indexed_claim_hash !== c.normalized_claim_hash || c.index_version !== INDEX_VERSION) { omitted.stale_index++; continue; }
    if (c.status !== "approved" || c.valid_to !== null) { omitted.not_usable++; continue; }
    const mine = sources.filter((s) => s.memory_id === id);
    if (mine.length === 0) { omitted.unsourced++; continue; }
    if (mine.some((s) => s.revoked_at !== null || s.project_revoked === true)) { omitted.revoked_source++; continue; }
    hits.push({
      memoryId: id,
      kind: c.kind as MemoryKind,
      claim: c.claim as string,
      rank: Number(c.rank),
      approvedBy: c.approved_by as string,
      recordVersion: c.record_version as number,
      sources: mine.map((s) => ({
        sourceKind: (s.artifact_id ? "artifact" : "event") as SourceKind,
        sourceId: (s.artifact_id ?? s.event_id) as string,
        digest: s.source_digest as string,
      })),
    });
  }

  const [ext] = await sql<Row[]>`SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available`;
  const semantic: SemanticStatus = {
    enabled: false,
    extensionAvailable: ext?.available === true,
    embeddingModelQualified: false,
    reason: "no embedding model has a qualification record in config/model-qualification.json; semantic retrieval stays off",
  };
  const [event] = await sql<Row[]>`INSERT INTO memory_retrieval_events (organization_id, project_id, actor_id, query_digest, retrieval_mode, returned_ids, omitted)
    VALUES (${actor.organizationId}, ${projectId}, ${actor.userId}, ${digestOf({ query })}, ${RETRIEVAL_MODE},
      ${hits.map((h) => h.memoryId)}::uuid[], ${sql.json(omitted as never)})
    RETURNING id`;
  if (!event) throw new MemoryError("DB_REJECTED", "retrieval event was not recorded");
  return { requestId: event.id as string, mode: RETRIEVAL_MODE, semantic, hits, omitted };
}

/**
 * Rebuilds the project's lexical index from approved records. Safe to run at any time: the index is a projection, and
 * the trigger already keeps it current; this is the recovery path after an index-version change or detected staleness.
 */
export async function rebuildIndex(sql: Sql, actor: Actor, projectId: string): Promise<number> {
  await requireActor(sql, actor, STEWARD_ROLES);
  await requireProject(sql, actor.organizationId, projectId);
  return sql.begin(async (tx) => {
    await tx`DELETE FROM memory_index WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId}`;
    const rows = await tx<Row[]>`INSERT INTO memory_index (record_id, organization_id, project_id, indexed_claim_hash, index_version, lexical)
      SELECT r.id, r.organization_id, r.project_id, r.normalized_claim_hash, ${INDEX_VERSION}, memory_lexical(r.claim)
      FROM memory_records r WHERE r.organization_id = ${actor.organizationId} AND r.project_id = ${projectId} AND r.status = 'approved' AND r.valid_to IS NULL
      RETURNING record_id`;
    await tx`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest)
      VALUES (${actor.organizationId}, ${actor.userId}, 'memory.index_rebuild', ${`project:${projectId}`}, 'ok', null, ${digestOf({ indexed: rows.length })})`;
    return rows.length;
  }) as Promise<number>;
}
