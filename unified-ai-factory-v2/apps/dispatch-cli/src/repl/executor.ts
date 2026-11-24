import { bindingFor, ConfirmationStore, DESTRUCTIVE, type Intent } from "@factory/dispatch-core";
import { ApiError, OutcomeUnknown, StaleRevision, type DispatchClient, type JobView, type Summary } from "@factory/dispatch-client";
import { resolve as resolvePath } from "node:path";
import type { Session } from "./session";

export interface Io { out(s: string): void; ask(prompt: string): Promise<string> }
export type Outcome = { status: "completed" | "blocked" | "needs-input" | "failed"; message: string; reasonCode?: string };
const done = (message: string): Outcome => ({ status: "completed", message });
const blocked = (reasonCode: string, message: string): Outcome => ({ status: "blocked", reasonCode, message });

export type Resolved<T> = { ok: true; item: T } | { ok: false; message: string };
/** Resolve a reference the user typed (full id, unique id prefix of 6+ chars, or a unique title fragment) against ONLY the jobs the API says this actor may see. Ambiguity is never guessed. */
export function resolveJob(jobs: JobView[], ref: string): Resolved<JobView> {
  const r = ref.trim().toLowerCase(); if (r.length === 0) return { ok: false, message: "No job given." };
  const exact = jobs.filter((j) => j.id.toLowerCase() === r); if (exact[0] && exact.length === 1) return { ok: true, item: exact[0] };
  const pre = r.length >= 6 ? jobs.filter((j) => j.id.toLowerCase().startsWith(r)) : []; if (pre[0] && pre.length === 1) return { ok: true, item: pre[0] };
  const hits = pre.length > 1 ? pre : jobs.filter((j) => j.title.text.toLowerCase().includes(r));
  if (hits[0] && hits.length === 1) return { ok: true, item: hits[0] };
  if (hits.length === 0) return { ok: false, message: `No visible job matches “${ref.slice(0, 60)}”. Try /jobs.` };
  return { ok: false, message: `“${ref.slice(0, 60)}” matches ${hits.length} jobs; be specific:\n${hits.slice(0, 8).map((j) => `  ${j.id.slice(0, 8)}  ${j.state.padEnd(14)} ${j.title.text.slice(0, 50)}`).join("\n")}` };
}

const line = (j: JobView) => `${j.id.slice(0, 8)}  ${j.state.padEnd(14)} ${j.paused ? "paused " : "       "}${j.project.padEnd(24).slice(0, 24)} ${j.title.text.slice(0, 50)}`;

export class Executor {
  constructor(private readonly c: DispatchClient, readonly session: Session, private readonly io: Io, private readonly confirms = new ConfirmationStore(), private readonly actor = session.data.actor) {}

  /** Re-checks authorization for the active project on every use: if it is no longer visible (revoked, deleted) the scope is dropped instead of being trusted. */
  private async activeProject(): Promise<string | null> {
    const id = this.session.projectId; if (!id) return null;
    const projects = await this.c.get<{ items: Array<{ id: string }> }>("/api/v2/dispatch/projects");
    if (projects.items.some((p) => p.id === id)) return id;
    this.session.clearProject(); this.io.out("Your active project is no longer available to you; context cleared."); return null;
  }

  async execute(intent: Intent): Promise<Outcome> {
    try { return await this.run(intent); } catch (e) { return this.explain(e); }
  }
  private explain(e: unknown): Outcome {
      if (e instanceof OutcomeUnknown) return { status: "failed", reasonCode: "outcome-unknown", message: `The request may or may not have been applied (${e.message}). Check /jobs before retrying.` };
      if (e instanceof StaleRevision) return { status: "blocked", reasonCode: "stale-revision", message: "That item changed since you last looked. Refresh with /jobs and try again." };
      if (e instanceof ApiError) return e.status === 403 ? blocked("forbidden", "You are not permitted to do that.") : e.status === 404 ? blocked("not-found", "Not found, or not visible to you.") : { status: "failed", reasonCode: `http-${e.status}`, message: `${e.title}${e.detail ? `: ${e.detail}` : ""}` };
    return { status: "failed", reasonCode: "unavailable", message: `The factory is not reachable (${(e as Error).message}). Run \`dispatch status\`.` };
  }

  private async jobs(): Promise<JobView[]> { const s = await this.c.snapshot(); return s.jobs; }

  private async run(i: Intent): Promise<Outcome> {
    switch (i.type) {
      case "factory.status": { const s = await this.c.summary(); return done(renderSummary(s)); }
      case "job.list": {
        const pid = i.projectId ?? (await this.activeProject()); const all = await this.jobs(); const js = pid ? all.filter((j) => j.projectId === pid) : all;
        this.session.remember(js.slice(0, 50).map((j) => ({ kind: "job", id: j.id, label: j.title.text.slice(0, 60) })));
        return done(js.length === 0 ? "No jobs." : `${pid ? "" : "All projects. "}${js.length} job(s):\n${js.map(line).join("\n")}`);
      }
      case "project.select": {
        const ps = await this.c.get<{ items: Array<{ id: string; name: string }> }>("/api/v2/dispatch/projects"); const hit = ps.items.find((p) => p.id === i.projectId || p.id.startsWith(i.projectId) && i.projectId.length >= 6 || p.name === i.projectId);
        if (!hit) return blocked("not-found", `No visible project “${i.projectId.slice(0, 60)}”. Try /projects.`);
        this.session.setProject(hit.id, hit.name); return done(`Active project: ${hit.name}`);
      }
      case "project.create": return blocked("use-folder", "Add a project with /new <folder> (a local folder) instead.");
      case "job.create": return this.createJob(await this.activeProject() ?? i.projectId, i.request);
      case "job.pause": case "job.resume": case "job.cancel": return this.jobAction(i);
      case "approval.review": return this.reviewApproval(i.approvalId);
      case "capability.list": return this.capabilities(i.category);
      case "clarification.required": return { status: "needs-input", message: i.question };
    }
  }

  /** `/new <folder>` / `/project add <folder>`: register a local folder as a project (validated by the API) and make it the active project. */
  async addLocalProject(path: string): Promise<Outcome> {
    try {
      const abs = path.trim().startsWith("~") || path.trim().startsWith("/") ? path.trim() : resolvePath(process.cwd(), path.trim());
      type R = { id?: string; name: string; path: string; created?: boolean; isGit?: boolean; missing?: boolean; folderCreated?: boolean };
      let r = await this.c.send<R>(this.c.mutation("POST", "/api/v2/dispatch/projects", { path: abs }));
      if (r.missing) { // the folder does not exist: offer to create exactly that path
        const ans = (await this.io.ask(`${r.path} does not exist. Create it? (y/N) `)).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") return blocked("not-confirmed", "Nothing was created.");
        r = await this.c.send<R>(this.c.mutation("POST", "/api/v2/dispatch/projects", { path: abs, create: true }));
      }
      if (!r.id) return blocked("folder-refused", "The folder could not be added.");
      this.session.setProject(r.id, r.name);
      return done(`${r.folderCreated ? "Created and added" : r.created ? "Added" : "Already added"}: ${r.name} (${r.path})${r.isGit ? "" : "\nNote: this folder is not a git repository, so changes to it cannot be tracked until it is one."}\nActive project: ${r.name}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) return blocked("folder-refused", e.detail ?? e.title);
      return this.explain(e);
    }
  }
  /** `/dispatch <request>`: pick the project (active one; else the only one; else ask), then create the request through the normal idempotent job API. */
  private async findRun(ref?: string): Promise<{ id: string } | Outcome> {
    const l = await this.c.get<{ items: Array<{ id: string; status: string }> }>("/api/v2/dispatch/runs");
    const hits = ref ? l.items.filter((r) => r.id.startsWith(ref)) : l.items.filter((r) => r.status === "awaiting_approval");
    if (hits.length === 1 && hits[0]) return { id: hits[0].id };
    return blocked(hits.length ? "ambiguous" : "not-found", hits.length ? "That matches more than one run; type more of the id (see /runs)." : "No such run. See /runs.");
  }
  async runs(): Promise<Outcome> {
    try {
      const l = await this.c.get<{ items: Array<{ id: string; status: string; project: string; summary: string | null; failure: string | null; changes: unknown[]; plan: { tasks: Array<{ model: string }> } }> }>("/api/v2/dispatch/runs");
      if (!l.items.length) return done("No agent runs yet.");
      const models = (r: (typeof l.items)[number]) => ["opus", "sonnet", "haiku"].map((m) => [m, r.plan.tasks.filter((t) => t.model === m).length] as const).filter(([, n]) => n).map(([m, n]) => `${n}×${m}`).join(" ");
      return done(l.items.map((r) => `${r.id.slice(0, 8)}  ${r.status.padEnd(17)} ${r.project.slice(0, 20).padEnd(20)} ${String(r.changes.length).padStart(3)} change(s)  ${models(r)}${r.status === "failed" && r.failure ? `  ✗ ${r.failure.slice(0, 60)}` : r.status === "awaiting_approval" ? "  ← /review " + r.id.slice(0, 8) : ""}`).join("\n"));
    } catch (e) { return this.explain(e); }
  }
  /** Show a run: what the agents were asked, what they did, and the diff. Nothing is applied. */
  async reviewRun(ref?: string): Promise<Outcome> {
    try {
      const f = await this.findRun(ref); if (!("id" in f)) return f;
      const r = await this.c.get<{ id: string; status: string; project: string; summary: string | null; plan: { summary: string; tasks: Array<{ id: string; model: string; goal: string }> }; changes: Array<{ path: string; kind: string }>; diff?: string; log: Array<{ note: string }> }>(`/api/v2/dispatch/runs/${f.id}`);
      const warn = r.log.filter((l) => l.note.startsWith("WARNING")).map((l) => l.note);
      return done([`Run ${r.id.slice(0, 8)} on ${r.project} — ${r.status}`, `Plan: ${r.plan.summary}`, ...r.plan.tasks.map((t) => `  ${t.model.padEnd(6)} ${t.id}: ${t.goal.slice(0, 100)}`), `Agent says: ${r.summary ?? "(nothing)"}`, ...warn, `${r.changes.length} change(s): ${r.changes.map((c) => `${c.kind} ${c.path}`).join(", ")}`, "", r.diff ?? "(diff is only available while a run is awaiting approval)", r.status === "awaiting_approval" ? `\n/accept ${r.id.slice(0, 8)} to apply these changes, or /discard ${r.id.slice(0, 8)}.` : ""].join("\n"));
    } catch (e) { return this.explain(e); }
  }
  /** Apply a run. You are shown the diff again and must type a word; the approval carries the digest of exactly what was shown. */
  async acceptRun(ref?: string): Promise<Outcome> {
    try {
      const f = await this.findRun(ref); if (!("id" in f)) return f;
      const r = await this.c.get<{ id: string; status: string; mode?: string; project: string; digest: string | null; changes: Array<{ path: string; kind: string }>; diff?: string }>(`/api/v2/dispatch/runs/${f.id}`);
      if (r.status !== "awaiting_approval" || !r.digest) return blocked("not-awaiting", `That run is ${r.status}; there is nothing to apply.`);
      if (r.mode === "in_place") {
        this.io.out(r.diff ?? ""); this.io.out(`${r.changes.length} change(s) are ALREADY in your folder for ${r.project}.`);
        if ((await this.io.ask("Type “keep” to accept them (they stay as they are), anything else leaves the run open: ")).trim().toLowerCase() !== "keep") return blocked("not-confirmed", "Nothing was decided; the changes are still in your folder.");
        await this.c.send(this.c.mutation("POST", `/api/v2/dispatch/runs/${r.id}/decision`, { decision: "approve", digest: r.digest }));
        return done(`Kept ${r.changes.length} change(s) in ${r.project}.`);
      }
      this.io.out(r.diff ?? ""); this.io.out(`${r.changes.length} change(s) will be written into your folder for ${r.project}.`);
      if ((await this.io.ask("Type “apply” to write them, anything else cancels: ")).trim().toLowerCase() !== "apply") return blocked("not-confirmed", "Nothing was applied.");
      const d = await this.c.send<{ status: string; applied: number }>(this.c.mutation("POST", `/api/v2/dispatch/runs/${r.id}/decision`, { decision: "approve", digest: r.digest }));
      return done(`Applied ${d.applied} change(s) to ${r.project}.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return blocked("refused", `${e.detail ?? e.title}`);
      return this.explain(e);
    }
  }
  async discardRun(ref?: string): Promise<Outcome> {
    try {
      const f = await this.findRun(ref); if (!("id" in f)) return f;
      const r = await this.c.get<{ mode?: string; digest: string | null; changes: unknown[]; project: string }>(`/api/v2/dispatch/runs/${f.id}`);
      if (r.mode === "in_place") {
        if ((await this.io.ask(`This RESTORES ${r.project} to the snapshot taken before the run (${r.changes.length} file(s) change back). Type “restore” to do it: `)).trim().toLowerCase() !== "restore") return blocked("not-confirmed", "Nothing was restored.");
        await this.c.send(this.c.mutation("POST", `/api/v2/dispatch/runs/${f.id}/decision`, { decision: "reject", digest: r.digest ?? "" }));
        return done(`Restored ${r.project} to the snapshot; the run is closed.`);
      }
      await this.c.send(this.c.mutation("POST", `/api/v2/dispatch/runs/${f.id}/decision`, { decision: "reject", digest: "" }));
      return done("Run discarded; its work copy was deleted and your folder was not touched.");
    } catch (e) { if (e instanceof ApiError && e.status === 409) return blocked("refused", `${e.detail ?? e.title}`); return this.explain(e); }
  }

  async submitRequest(text: string): Promise<Outcome> {
    try {
      let pid = await this.activeProject();
      if (!pid) {
        const ps = (await this.c.get<{ items: Array<{ id: string; name: string }> }>("/api/v2/dispatch/projects")).items;
        if (ps.length === 0) return blocked("no-project", "There is no project to put this request in yet, so nothing was created. Point me at a folder with /project add <folder> (or `dispatch --project <folder> <request>`); a GitHub repository is not required.");
        if (ps.length > 1) return { status: "needs-input", message: `Which project? Choose one with /project use <id|owner/name>, then repeat the request:\n${ps.slice(0, 8).map((p) => `  ${p.id.slice(0, 8)}  ${p.name}`).join("\n")}` };
        const only = ps[0]; if (!only) return blocked("no-project", "No project."); pid = only.id; this.session.setProject(only.id, only.name);
      }
      return await this.createJob(pid, text);
    } catch (e) { return this.explain(e); }
  }
  private async createJob(projectId: string, text: string): Promise<Outcome> {
    const m = this.c.mutation("POST", "/api/v1/jobs", { repositoryId: projectId, request: { type: "feature", title: text.slice(0, 120), description: text, sourceId: `dispatch-${this.session.id}-${m_counter()}` } });
    const r = await this.c.send<{ jobId: string; state: string }>(m);
    return done(`Request created: job ${r.jobId.slice(0, 8)} (${r.state}). It stays queued until you run “dispatch work” in a terminal: Claude Code (Opus plans, cheaper agents execute) then does it in a copy of the folder, and you approve the result with /runs. (That needs your recorded provider-terms approval; see docs/dispatch/AGENTS.md.)`);
  }
  private async jobAction(i: Extract<Intent, { type: "job.pause" | "job.resume" | "job.cancel" }>): Promise<Outcome> {
    const r = resolveJob(await this.jobs(), i.jobId); if (!r.ok) return { status: "needs-input", message: r.message };
    const j = r.item; const verb = i.type.split(".")[1] as "pause" | "resume" | "cancel";
    if (DESTRUCTIVE.has(i.type)) {
      const b = bindingFor(i, { actor: this.actor, projectId: j.projectId, sessionId: this.session.id, targetRevision: j.revision }); const { token } = this.confirms.issue(b);
      this.io.out(`About to CANCEL job ${j.id.slice(0, 8)} “${j.title.text.slice(0, 60)}” (${j.state}, revision ${j.revision}). This cannot be undone.`);
      const ans = (await this.io.ask("Type the job id prefix to confirm, or anything else to abort: ")).trim().toLowerCase();
      if (ans !== j.id.slice(0, 8).toLowerCase()) return blocked("not-confirmed", "Cancelled nothing.");
      // Re-read: the confirmation is bound to the revision the user saw; if the job moved, refuse rather than act on something they did not review.
      const fresh = (await this.jobs()).find((x) => x.id === j.id);
      const check = this.confirms.consume(token, bindingFor(i, { actor: this.actor, projectId: j.projectId, sessionId: this.session.id, targetRevision: fresh?.revision ?? -1 }));
      if (!check.ok) return blocked("stale-confirmation", "The job changed while you were confirming. Nothing was done; review it again with /jobs.");
    }
    const body = { reason: `via dispatch (${this.session.id.slice(0, 8)})`, expectedVersion: j.revision };
    const m = this.c.mutation("POST", `/api/v1/jobs/${j.id}/${verb}`, body); await this.c.send(m);
    return done(`${verb === "cancel" ? "Cancelled" : verb === "pause" ? "Pause requested for" : "Resumed"} job ${j.id.slice(0, 8)}.`);
  }

  private async reviewApproval(id: string): Promise<Outcome> {
    const inbox = await this.c.get<{ items: Array<Record<string, unknown>> }>("/api/v2/dispatch/approvals"); const hits = inbox.items.filter((a) => String(a.id) === id || (id.length >= 6 && String(a.id).startsWith(id)));
    if (hits.length === 0) return blocked("not-found", "No such pending approval visible to you.");
    if (hits.length > 1) return { status: "needs-input", message: `Ambiguous: ${hits.length} approvals match; use more of the id.` };
    const a = hits[0];
    if (!a) return blocked("not-found", "No such pending approval visible to you.");
    if (a.type === "job-decision") return blocked("use-dashboard", `Job decision ${String(a.id).slice(0, 8)} binds to an exact head SHA and policy evidence; review and decide it in the dashboard (/dashboard).`);
    this.io.out(`Approval ${String(a.id).slice(0, 8)}: ${String(a.operation)} ${String(a.capability)}\n  package digest   ${String(a.digest)}\n  permission digest ${String(a.permissionDigest)}\n  expires ${String(a.expiresAt)}`);
    const ans = (await this.io.ask("Approve exactly this digest? Type “approve” to approve, “reject” to reject, anything else to leave it pending: ")).trim().toLowerCase();
    if (ans !== "approve" && ans !== "reject") return blocked("not-confirmed", "Left pending.");
    const m = this.c.mutation("POST", `/api/v2/approvals/${String(a.id)}/decision`, { decision: ans === "approve" ? "approved" : "rejected", digest: a.digest, permissionDigest: a.permissionDigest, note: "via dispatch" }); await this.c.send(m);
    return done(ans === "approve" ? "Approved. Activation is a separate step and has NOT happened; it still requires the current registry revision." : "Rejected.");
  }

  private async capabilities(cat: "skills" | "agents" | "models"): Promise<Outcome> {
    const r = await this.c.get<Record<string, unknown>>(`/api/v2/dispatch/capabilities?category=${cat}`);
    if (cat === "models") {
      const m = r as { configLoaded: boolean; summary: { available: number; qualified: number; authorized: number }; policy: { allowedInferenceModes: string[]; modelApiBillingEnabled: boolean }; available: Array<{ id: string }>; qualified: Array<{ role: string; model: string; runtime: string }>; note?: string };
      return done([`Model runtimes — available ${m.summary.available} · qualified ${m.summary.qualified} · authorized ${m.summary.authorized}  (three separate facts)`, `Policy: ${m.policy.allowedInferenceModes.join(", ") || "none"}; metered model APIs ${m.policy.modelApiBillingEnabled ? "ENABLED" : "disabled"}`, ...(m.configLoaded ? [] : ["(policy configuration could not be read)"]), ...m.available.map((x) => `  available  ${x.id}`), ...m.qualified.map((x) => `  qualified  ${x.role}: ${x.model} on ${x.runtime}`), ...(m.note ? [m.note] : [])].join("\n"));
    }
    const items = (r as { items: Array<{ slug: string; version: string; status: string; state: string; digest: string; roles?: string[] }> }).items;
    const approved = items.filter((x) => x.status === "approved-active"); const props = items.filter((x) => x.status !== "approved-active");
    return done([`${cat} — approved & active: ${approved.length}`, ...approved.map((x) => `  ✔ ${x.slug}@${x.version}${x.roles?.length ? `  roles: ${x.roles.join(",")}` : ""}`), `proposals / not active: ${props.length}`, ...props.slice(0, 20).map((x) => `  ○ ${x.slug}@${x.version}  [${x.state}] cannot run until approved`)].join("\n"));
  }
}
let counter = 0; const m_counter = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export function renderSummary(s: Summary): string {
  return [`Jobs: ${s.jobs.inFlight} in flight · ${s.jobs.waitingOnHuman} waiting on a human · ${s.jobs.total} total`, `Approvals pending: ${s.approvals.pending} (${s.approvals.jobDecisions} job decisions, ${s.approvals.capabilityApprovals} capability)`, `Projects: ${s.projects} · active workers: ${s.workers.active}`].join("\n");
}
