import { bindingFor, ConfirmationStore, DESTRUCTIVE, type Intent } from "@factory/dispatch-core";
import { ApiError, OutcomeUnknown, StaleRevision, type DispatchClient, type JobView, type Summary } from "@factory/dispatch-client";
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
    try { return await this.run(intent); }
    catch (e) {
      if (e instanceof OutcomeUnknown) return { status: "failed", reasonCode: "outcome-unknown", message: `The request may or may not have been applied (${e.message}). Check /jobs before retrying.` };
      if (e instanceof StaleRevision) return { status: "blocked", reasonCode: "stale-revision", message: "That item changed since you last looked. Refresh with /jobs and try again." };
      if (e instanceof ApiError) return e.status === 403 ? blocked("forbidden", "You are not permitted to do that.") : e.status === 404 ? blocked("not-found", "Not found, or not visible to you.") : { status: "failed", reasonCode: `http-${e.status}`, message: `${e.title}${e.detail ? `: ${e.detail}` : ""}` };
      return { status: "failed", reasonCode: "unavailable", message: `The factory is not reachable (${(e as Error).message}). Run \`dispatch status\`.` };
    }
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
      case "project.create": return blocked("project-not-linked", "Creating a project requires linking a repository, which needs the GitHub App (not configured here). Use the dashboard once a repository is connected.");
      case "job.create": {
        const pid = await this.activeProject() ?? i.projectId; const m = this.c.mutation("POST", "/api/v1/jobs", { repositoryId: pid, request: { type: "feature", title: i.request.slice(0, 120), description: i.request, sourceId: `dispatch-${this.session.id}-${m_counter()}` } });
        const r = await this.c.send<{ jobId: string; state: string }>(m); return done(`Job ${r.jobId.slice(0, 8)} created (${r.state}).`);
      }
      case "job.pause": case "job.resume": case "job.cancel": return this.jobAction(i);
      case "approval.review": return this.reviewApproval(i.approvalId);
      case "capability.list": return this.capabilities(i.category);
      case "clarification.required": return { status: "needs-input", message: i.question };
    }
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
