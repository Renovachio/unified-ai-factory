// Dispatch memory (MEM-04/06 wiring). Lets a Claude Code session READ approved project memory and give feedback on it, and lets a HUMAN
// create, review and approve memory. The agent identity (role editor) can read and give feedback; only a human with `job:decide` can add a
// note, approve, reject or change consent, and the memory package refuses approval for the agent's database role as well.
// Everything returned to a model is framed as reference DATA by the memory package (MEMORY_FRAME); nothing here is an instruction.
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "@factory/db";
import {
  approveMemory, approveWithErasure, buildContextPack, conflictsOf, getMemory, ingestSource, listMemories, MemoryError, rejectMemory, requireProject, ROLE_INPUT_CAPS,
  setTelemetryConsent, telemetryOptedIn,
  type Actor as MemoryActor, type MemoryView,
} from "@factory/memory";
import { FileArtifactStore, feedbackWithSignals } from "@factory/orchestrator";
import { require_, type Actor } from "./auth";
import { LOCAL_AGENT_SUBJECT } from "./local";
import { readJson } from "./body";
import { ApiProblem, problems } from "./problem";
import type { Handler } from "./registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const localOnly = () => { if (!process.env.DISPATCH_LOCAL_TOKEN_FILE) throw problems.notFound("no such route"); };
/** Rendered memory packs are kept under the Dispatch home, in their own folder (the retention sweep must use the same root). */
const packStore = (): FileArtifactStore => {
  const home = process.env.DISPATCH_HOME;
  if (!home) throw problems.notFound("no such route");
  const d = join(home, "memory-packs");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return new FileArtifactStore(realpathSync(d));
};
const memActor = (a: Actor): MemoryActor => ({ organizationId: a.orgId, userId: a.userId });
const seg = (req: Request): string[] => new URL(req.url).pathname.split("/").filter(Boolean); // [api, v2, dispatch, memory, <id>, <verb>]
const obj = async (req: Request, max: number): Promise<Record<string, unknown>> => {
  const { value } = await readJson(req, max);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problems.unprocessable("body must be a JSON object");
  return value as Record<string, unknown>;
};
const text = (b: Record<string, unknown>, k: string, max = 4000): string => {
  const v = b[k];
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max) throw problems.unprocessable(`${k} must be a non-empty string of at most ${max} characters`);
  return v;
};
const uuid = (v: unknown, k: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw problems.unprocessable(`${k} must be an id`); return v; };

/** The memory package's errors become the API's problems; anything else is not hidden. */
function asProblem(e: unknown): unknown {
  if (!(e instanceof MemoryError)) return e;
  const detail = e.message;
  switch (e.code) {
    case "FORBIDDEN": return problems.forbidden(detail);
    case "NOT_FOUND": case "PACK_NOT_FOUND": return problems.notFound(detail);
    case "SELF_APPROVAL": case "WRONG_STATE": case "ILLEGAL_TRANSITION": case "CONFLICT_UNRESOLVED": case "DB_REJECTED":
      return problems.conflict(`memory-${e.code.toLowerCase().replace(/_/g, "-")}`, detail);
    default: return new ApiProblem({ status: 422, code: `memory-${e.code.toLowerCase().replace(/_/g, "-")}`, title: "Unprocessable Content", detail });
  }
}
async function guarded<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { throw asProblem(e); } }

const brief = (m: MemoryView) => ({ id: m.id, kind: m.kind, status: m.status, claim: m.claim, usable: m.usable, createdBy: m.createdBy, approvedBy: m.approvedBy, createdAt: m.createdAt, sources: m.sources.length, revokedSources: m.sources.filter((s) => s.revoked).length, supersededBy: m.supersededBy, validTo: m.validTo });

export const memoryRoutes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  // Read: the approved, usable memory relevant to a task, as one framed text block, plus the ids it came from.
  { method: "GET", pattern: /^\/dispatch\/memory\/context$/, handler: async ({ req, sql, actor }) => {
    localOnly(); require_(actor, "job:read");
    const q = new URL(req.url).searchParams;
    const projectId = uuid(q.get("projectId"), "projectId");
    const task = (q.get("task") ?? "").slice(0, 2000);
    if (task.trim().length === 0) throw problems.unprocessable("task must not be empty");
    return guarded(async () => {
      const pack = await buildContextPack(sql, memActor(actor), {
        projectId, modelRole: "builder", maxInputTokens: ROLE_INPUT_CAPS.builder,
        systemInstructions: "Project memory for the Dispatch coordinator.", task,
      }, packStore());
      return { status: 200, body: { packId: pack.packId, memoryIds: pack.manifest.selected.map((s) => s.memoryId), omitted: pack.manifest.omitted.memoryIds.length, text: pack.text } };
    });
  } },
  // Human: list a project's memory (proposed first) for review.
  { method: "GET", pattern: /^\/dispatch\/memory$/, handler: async ({ req, sql, actor }) => {
    localOnly(); require_(actor, "job:read");
    const q = new URL(req.url).searchParams;
    const projectId = uuid(q.get("projectId"), "projectId");
    const status = q.get("status");
    return guarded(async () => {
      const all = await listMemories(sql, memActor(actor), projectId);
      const rows = (status ? all.filter((m) => m.status === status) : all).slice(0, 200);
      return { status: 200, body: { items: rows.map(brief) } };
    });
  } },
  // Human reviewer (MEM-07): the APPROVED memories a proposed memory overlaps. Approving it then needs exactly these ids in acceptErasureOf.
  // Read-only, but only for people who can decide: it exists to prepare a decision. Overlap is a wording signal, not a judgement.
  { method: "GET", pattern: /^\/dispatch\/memory\/[^/]+\/conflicts$/, handler: async ({ req, sql, actor }) => {
    localOnly(); require_(actor, "job:decide");
    const memoryId = uuid(seg(req)[4], "memory id");
    const projectId = uuid(new URL(req.url).searchParams.get("projectId"), "projectId");
    return guarded(async () => {
      const m = await getMemory(sql, memActor(actor), projectId, memoryId); // org + project scoped; NOT_FOUND otherwise
      const items = m.status === "proposed" ? await conflictsOf(sql, actor.orgId, projectId, memoryId) : [];
      return { status: 200, body: { memoryId, status: m.status, items } };
    });
  } },
  // Human or agent: the project's current telemetry consent (no row means off). Read-only; changing it stays approver-only (POST below).
  { method: "GET", pattern: /^\/dispatch\/memory\/consent$/, handler: async ({ req, sql, actor }) => {
    localOnly(); require_(actor, "job:read");
    const projectId = uuid(new URL(req.url).searchParams.get("projectId"), "projectId");
    return guarded(async () => {
      await requireProject(sql, actor.orgId, projectId);
      return { status: 200, body: { projectId, optedIn: await telemetryOptedIn(sql, actor.orgId, projectId) } };
    });
  } },
  // Human: write a note on a job of the project. It becomes an event source and is ingested into PROPOSED memories (never approved).
  { method: "POST", pattern: /^\/dispatch\/memory\/note$/, handler: async ({ req, sql, actor, mutating, key, maxBody }) => {
    localOnly(); mutating(); key(); require_(actor, "job:decide");
    const b = await obj(req, maxBody);
    const projectId = uuid(b.projectId, "projectId"), note = text(b, "text", 4000);
    return guarded(async () => {
      // A note is stored as an event on a job of the project: the named job, or else the project's latest one.
      const [job] = b.jobId !== undefined
        ? await sql`SELECT j.id FROM jobs j JOIN repositories r ON r.id = j.repository_id WHERE j.id = ${uuid(b.jobId, "jobId")} AND r.id = ${projectId} AND r.organization_id = ${actor.orgId}`
        : await sql`SELECT j.id FROM jobs j JOIN repositories r ON r.id = j.repository_id WHERE r.id = ${projectId} AND r.organization_id = ${actor.orgId} ORDER BY j.created_at DESC LIMIT 1`;
      if (!job) throw new MemoryError("NOT_FOUND", "this project has no job yet; start one with `dispatch code` first");
      const jobId = job.id as string;
      const ev = await appendEvent(sql, { jobId, type: "human.note", source: "api", actorId: actor.userId, payload: { text: note } });
      // The extractor proposes; the human who wrote the note consents and later approves. The dispatch agent identity is the proposer so the
      // memory package's "author cannot approve their own memory" rule still holds for a single user.
      const [ag] = await sql`SELECT id FROM users WHERE organization_id = ${actor.orgId} AND auth_subject = ${LOCAL_AGENT_SUBJECT} AND disabled_at IS NULL`;
      if (!ag) throw new MemoryError("FORBIDDEN", "the dispatch agent identity is not set up; start Dispatch once with its agent token");
      const r = await ingestSource(sql, { organizationId: actor.orgId, userId: ag.id as string }, { projectId, source: { kind: "event", id: ev.id }, consent: { purpose: "project_memory", grantedBy: actor.userId } });
      return { status: 201, body: { proposed: r.stats.proposed, candidates: r.stats.candidates, droppedSecret: r.stats.droppedSecret, droppedInjection: r.stats.droppedInjection, memoryIds: r.links.map((l) => l.memoryId) } };
    });
  } },
  // Human: approve or reject a proposed memory. Approval that overlaps an approved memory needs the overlapping ids named (acceptErasureOf).
  { method: "POST", pattern: /^\/dispatch\/memory\/[^/]+\/decision$/, handler: async ({ req, sql, actor, mutating, key, maxBody }) => {
    localOnly(); mutating(); key(); require_(actor, "job:decide");
    const memoryId = uuid(seg(req)[4], "memory id");
    const b = await obj(req, maxBody);
    const projectId = uuid(b.projectId, "projectId");
    const decision = b.decision;
    if (decision !== "approve" && decision !== "reject") throw problems.unprocessable("decision must be approve or reject");
    return guarded(async () => {
      if (decision === "reject") {
        const m = await rejectMemory(sql, memActor(actor), projectId, memoryId, typeof b.reason === "string" && b.reason.trim() ? b.reason.slice(0, 500) : "rejected by reviewer");
        return { status: 200, body: { memory: brief(m) } };
      }
      const erase = Array.isArray(b.acceptErasureOf) ? b.acceptErasureOf.map((x) => uuid(x, "acceptErasureOf")) : [];
      const m = erase.length > 0
        ? await approveWithErasure(sql, packStore(), memActor(actor), projectId, memoryId, erase)
        : await approveMemory(sql, memActor(actor), projectId, memoryId);
      return { status: 200, body: { memory: brief(m), erased: erase } };
    });
  } },
  // Agent or human: say whether a retrieved memory was useful, wrong, stale or missing. A gap signal goes to SAI-11 only with project consent.
  { method: "POST", pattern: /^\/dispatch\/memory\/feedback$/, handler: async ({ req, sql, actor, mutating, key, maxBody }) => {
    localOnly(); mutating(); key(); require_(actor, "job:create");
    const b = await obj(req, maxBody);
    const projectId = uuid(b.projectId, "projectId"), memoryId = uuid(b.memoryId, "memoryId");
    if (typeof b.verdict !== "string") throw problems.unprocessable("verdict must be useful, wrong, stale or missing");
    return guarded(async () => {
      const r = await feedbackWithSignals(sql, memActor(actor), projectId, { memoryId, verdict: b.verdict as "useful" });
      return { status: 201, body: { id: r.id, signalState: r.signalState } };
    });
  } },
  // Human: turn project telemetry consent for memory feedback signals on or off. Approver or admin only (also enforced by the database).
  { method: "POST", pattern: /^\/dispatch\/memory\/consent$/, handler: async ({ req, sql, actor, mutating, key, maxBody }) => {
    localOnly(); mutating(); key(); require_(actor, "job:decide");
    const b = await obj(req, maxBody);
    const projectId = uuid(b.projectId, "projectId");
    if (typeof b.optedIn !== "boolean") throw problems.unprocessable("optedIn must be true or false");
    return guarded(async () => {
      await setTelemetryConsent(sql, memActor(actor), projectId, b.optedIn as boolean, text(b, "reason", 500));
      return { status: 200, body: { optedIn: b.optedIn } };
    });
  } },
];
