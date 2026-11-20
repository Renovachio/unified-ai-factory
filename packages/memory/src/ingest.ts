import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Sql } from "@factory/db";
import { digestOf } from "@factory/telemetry";
import { MemoryError, PROPOSER_ROLES } from "./domain";
import { detectInjection, detectSecret, EXTRACTOR_ID, extractCandidates, MAX_SOURCE_CHARS, type CandidateKind } from "./extract";
import { type Actor, proposeMemory, requireActor, requireProject, type SourceKind } from "./lifecycle";

/**
 * Evidence-based ingestion (MEM-02). Reads ONE approved source (an artifact or an event of the project), checks consent,
 * verifies the content against its stored digest, extracts candidate claims deterministically, drops anything carrying a
 * secret or instruction-like text, and proposes the rest. Ingestion never approves: every memory it creates is `proposed`.
 */

export const INGESTIBLE_EVENT_TYPES = ["human.note", "intake.message"] as const;
export const TRANSCRIPT_KINDS = ["transcript", "meeting_transcript", "recording"] as const;

export interface Consent {
  purpose: "project_memory";
  /** Enabled member of the organization who grants this ingestion. */
  grantedBy: string;
  /** Required (true) for transcripts and recordings. */
  recordingConsent?: boolean;
}

export interface IngestInput {
  projectId: string;
  source: { kind: SourceKind; id: string };
  consent: Consent;
}

export interface IngestLink {
  memoryId: string;
  marker: CandidateKind;
  spanStart: number;
  spanEnd: number;
}

export interface IngestResult {
  runId: string;
  /** True when this exact source content was already ingested; nothing new was proposed. */
  reused: boolean;
  stats: { candidates: number; proposed: number; droppedSecret: number; droppedInjection: number };
  links: IngestLink[];
}

type Row = Record<string, unknown>;

interface SourceMeta {
  kind: SourceKind;
  id: string;
  digest: string;
  /** Artifact kind or event type; decides transcript rules and whether the source is ingestible. */
  label: string;
  storageUri: string | null;
  inlineText: string | null;
}

async function sourceMeta(sql: Sql, organizationId: string, projectId: string, src: { kind: SourceKind; id: string }): Promise<SourceMeta> {
  if (src.kind === "artifact") {
    const [a] = await sql<Row[]>`SELECT a.kind, a.digest, a.storage_uri, a.redaction_status FROM artifacts a
      JOIN jobs j ON j.id = a.job_id JOIN repositories r ON r.id = j.repository_id
      WHERE a.id = ${src.id} AND r.id = ${projectId} AND r.organization_id = ${organizationId}`;
    if (!a) throw new MemoryError("SCOPE_MISMATCH", "source is not an item of this project");
    if (a.redaction_status !== "clean") throw new MemoryError("SOURCE_UNVERIFIED", "artifact is not marked clean by redaction");
    return { kind: "artifact", id: src.id, digest: a.digest as string, label: a.kind as string, storageUri: a.storage_uri as string, inlineText: null };
  }
  const [e] = await sql<Row[]>`SELECT e.type, e.digest, e.payload_redacted FROM events e
    JOIN jobs j ON j.id = e.job_id JOIN repositories r ON r.id = j.repository_id
    WHERE e.id = ${src.id} AND r.id = ${projectId} AND r.organization_id = ${organizationId}`;
  if (!e) throw new MemoryError("SCOPE_MISMATCH", "source is not an item of this project");
  const type = e.type as string;
  if (!(INGESTIBLE_EVENT_TYPES as readonly string[]).includes(type)) throw new MemoryError("NOT_INGESTIBLE", `event type ${type} is not ingestible`);
  const text = (e.payload_redacted as Record<string, unknown>).text;
  if (typeof text !== "string") throw new MemoryError("NOT_INGESTIBLE", "event has no text payload");
  return { kind: "event", id: src.id, digest: e.digest as string, label: type, storageUri: null, inlineText: text };
}

/** Reads an artifact from its file URI and proves the bytes match the stored digest (tamper detection). */
function readVerified(uri: string, digest: string): string {
  const m = /^file:\/\/(\/.+)$/.exec(uri);
  if (!m) throw new MemoryError("SOURCE_UNVERIFIED", "unsupported artifact location");
  const path = m[1] ?? "";
  if (path === "") throw new MemoryError("SOURCE_UNVERIFIED", "unsupported artifact location");
  let buf: Buffer;
  try {
    if (statSync(path).size > MAX_SOURCE_CHARS * 4) throw new MemoryError("SOURCE_TOO_LARGE", "artifact exceeds the ingestion size limit");
    buf = readFileSync(path);
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError("SOURCE_UNVERIFIED", "artifact content is unavailable");
  }
  if (`sha256:${createHash("sha256").update(buf).digest("hex")}` !== digest) throw new MemoryError("SOURCE_UNVERIFIED", "artifact content does not match its digest");
  const text = buf.toString("utf8");
  if (text.length > MAX_SOURCE_CHARS) throw new MemoryError("SOURCE_TOO_LARGE", "artifact exceeds the ingestion size limit");
  return text;
}

async function checkConsent(sql: Sql, organizationId: string, consent: Consent, label: string): Promise<void> {
  if (!consent || consent.purpose !== "project_memory" || typeof consent.grantedBy !== "string") throw new MemoryError("CONSENT_REQUIRED", "explicit project_memory consent is required");
  const [u] = await sql`SELECT 1 FROM users WHERE id = ${consent.grantedBy} AND organization_id = ${organizationId} AND disabled_at IS NULL`;
  if (!u) throw new MemoryError("CONSENT_REQUIRED", "consent must be granted by an enabled member of this organization");
  if ((TRANSCRIPT_KINDS as readonly string[]).includes(label) && consent.recordingConsent !== true) {
    throw new MemoryError("CONSENT_REQUIRED", "transcripts and recordings need recordingConsent: true");
  }
}

async function linksOf(sql: Sql, runId: string): Promise<IngestLink[]> {
  const rows = await sql<Row[]>`SELECT memory_id, marker, span_start, span_end FROM memory_ingestion_links WHERE run_id = ${runId} ORDER BY span_start`;
  return rows.map((r) => ({ memoryId: r.memory_id as string, marker: r.marker as CandidateKind, spanStart: r.span_start as number, spanEnd: r.span_end as number }));
}

async function refusal(sql: Sql, actor: Actor, input: IngestInput, e: MemoryError): Promise<void> {
  await sql`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest)
    VALUES (${actor.organizationId}, ${actor.userId}, 'memory.ingest', ${`source:${input.source.kind}:${input.source.id}`}, 'refused',
      ${`${e.code}: ${e.message}`.slice(0, 300)}, ${digestOf({ project: input.projectId, source: input.source, code: e.code })})`;
}

export async function ingestSource(sql: Sql, actor: Actor, input: IngestInput): Promise<IngestResult> {
  try {
    return await ingestInner(sql, actor, input);
  } catch (e) {
    if (e instanceof MemoryError) await refusal(sql, actor, input, e);
    throw e;
  }
}

async function ingestInner(sql: Sql, actor: Actor, input: IngestInput): Promise<IngestResult> {
  await requireActor(sql, actor, PROPOSER_ROLES);
  await requireProject(sql, actor.organizationId, input.projectId);
  const meta = await sourceMeta(sql, actor.organizationId, input.projectId, input.source);
  await checkConsent(sql, actor.organizationId, input.consent, meta.label);

  const [revoked] = await sql`SELECT 1 FROM memory_source_revocations WHERE project_id = ${input.projectId} AND source_kind = ${meta.kind} AND source_id = ${meta.id}`;
  if (revoked) throw new MemoryError("SOURCE_REVOKED", "a revoked source cannot be ingested");

  // Artifacts: bytes are re-hashed against the stored digest. Events: the digest is the one appendEvent computed and
  // stored, and the text is the redacted payload, so the stored digest is the verification anchor.
  const text = meta.storageUri ? readVerified(meta.storageUri, meta.digest) : (meta.inlineText as string);
  if (text.length > MAX_SOURCE_CHARS) throw new MemoryError("SOURCE_TOO_LARGE", "source exceeds the ingestion size limit");

  const [existing] = await sql<Row[]>`SELECT * FROM memory_ingestion_runs WHERE project_id = ${input.projectId} AND source_kind = ${meta.kind}
    AND source_id = ${meta.id} AND source_digest = ${meta.digest} AND extractor_id = ${EXTRACTOR_ID}`;
  if (existing) {
    return {
      runId: existing.id as string,
      reused: true,
      stats: stats(existing),
      links: await linksOf(sql, existing.id as string),
    };
  }

  const aclDigest = digestOf({ organizationId: actor.organizationId, projectId: input.projectId, scope: "project_memory" });
  const candidates = extractCandidates(text);
  const droppedSecret = { n: 0 };
  const droppedInjection = { n: 0 };
  const links: IngestLink[] = [];
  for (const c of candidates) {
    if (detectSecret(c.claim)) { droppedSecret.n++; continue; }
    if (detectInjection(c.claim)) { droppedInjection.n++; continue; }
    const view = await proposeMemory(sql, actor, {
      projectId: input.projectId,
      kind: c.kind,
      claim: c.claim,
      sources: [{ kind: meta.kind, id: meta.id, digest: meta.digest, extractionMethod: "deterministic", aclDigest, span: { start: c.start, end: c.end } }],
    });
    links.push({ memoryId: view.id, marker: c.kind, spanStart: c.start, spanEnd: c.end });
  }
  const counts = { candidates: candidates.length, proposed: links.length, droppedSecret: droppedSecret.n, droppedInjection: droppedInjection.n };
  const consent = { purpose: "project_memory", grantedBy: input.consent.grantedBy, recordingConsent: input.consent.recordingConsent === true };

  // One transaction records the run and its links. If a concurrent run won the unique key, nothing is written here.
  const runId = await sql.begin(async (tx) => {
    const [run] = await tx<Row[]>`INSERT INTO memory_ingestion_runs (organization_id, project_id, source_kind, source_id, source_digest, extractor_id,
        consent, candidates_total, proposed, dropped_secret, dropped_injection, created_by)
      VALUES (${actor.organizationId}, ${input.projectId}, ${meta.kind}, ${meta.id}, ${meta.digest}, ${EXTRACTOR_ID},
        ${tx.json(consent as never)}, ${counts.candidates}, ${counts.proposed}, ${counts.droppedSecret}, ${counts.droppedInjection}, ${actor.userId})
      ON CONFLICT (project_id, source_kind, source_id, source_digest, extractor_id) DO NOTHING RETURNING id`;
    if (!run) return null;
    const newRunId = run.id as string;
    for (const l of links) {
      await tx`INSERT INTO memory_ingestion_links (run_id, memory_id, span_start, span_end, marker)
        VALUES (${newRunId}, ${l.memoryId}, ${l.spanStart}, ${l.spanEnd}, ${l.marker})`;
    }
    await tx`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest)
      VALUES (${actor.organizationId}, ${actor.userId}, 'memory.ingest', ${`source:${meta.kind}:${meta.id}`}, 'ok', null, ${digestOf({ run: newRunId, ...counts })})`;
    return newRunId;
  }) as string | null;

  if (runId === null) {
    const [winner] = await sql<Row[]>`SELECT * FROM memory_ingestion_runs WHERE project_id = ${input.projectId} AND source_kind = ${meta.kind}
      AND source_id = ${meta.id} AND source_digest = ${meta.digest} AND extractor_id = ${EXTRACTOR_ID}`;
    if (!winner) throw new MemoryError("DB_REJECTED", "ingestion run conflict without a winner");
    return { runId: winner.id as string, reused: true, stats: stats(winner), links: await linksOf(sql, winner.id as string) };
  }
  return { runId, reused: false, stats: counts, links };
}

function stats(r: Row) {
  return {
    candidates: r.candidates_total as number,
    proposed: r.proposed as number,
    droppedSecret: r.dropped_secret as number,
    droppedInjection: r.dropped_injection as number,
  };
}
