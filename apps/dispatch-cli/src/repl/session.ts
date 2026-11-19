import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Conversational scope for ONE terminal session. It holds references only (ids), never project data or secrets, and is bound to the signed-in actor. */
export interface SessionData { sessionId: string; actor: string; activeProjectId: string | null; activeProjectName: string | null; refs: Array<{ kind: "job" | "approval" | "project"; id: string; label: string }>; createdAt: number; expiresAt: number; revision: number }
export const SESSION_TTL_MS = 8 * 3600_000;

export class Session {
  constructor(public data: SessionData, private readonly file: string | null, private readonly now: () => number = Date.now) {}
  static open(file: string | null, actor: string, now: () => number = Date.now): Session {
    if (file && existsSync(file)) {
      try { const d = JSON.parse(readFileSync(file, "utf8")) as SessionData; if (d.actor === actor && d.expiresAt > now() && typeof d.sessionId === "string") return new Session(d, file, now); } catch { /* corrupt or foreign: start clean */ }
    }
    const s = new Session({ sessionId: randomUUID(), actor, activeProjectId: null, activeProjectName: null, refs: [], createdAt: now(), expiresAt: now() + SESSION_TTL_MS, revision: 0 }, file, now); s.save(); return s;
  }
  get id() { return this.data.sessionId; }
  get projectId() { return this.data.activeProjectId; }
  setProject(id: string, name: string) { this.data.activeProjectId = id; this.data.activeProjectName = name; this.touch(); }
  clearProject() { this.data.activeProjectId = null; this.data.activeProjectName = null; this.touch(); }
  /** `/context clear`: drops the conversational scope (active project and remembered references). Project data is untouched. */
  clear() { this.data.activeProjectId = null; this.data.activeProjectName = null; this.data.refs = []; this.touch(); }
  remember(refs: SessionData["refs"]) { this.data.refs = refs.slice(0, 50); this.touch(); }
  private touch() { this.data.revision++; this.save(); }
  private save() {
    if (!this.file) return;
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); const tmp = `${this.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, this.file); } catch { /* scope persistence is best-effort; the in-memory session still works */ }
  }
}
