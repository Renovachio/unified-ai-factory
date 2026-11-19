import type { ReactNode } from "react";
import { StateBadge, short, when } from "./view";

export interface SummaryView { jobs: { inFlight: number; waitingOnHuman: number; total: number }; approvals: { pending: number; jobDecisions: number; capabilityApprovals: number }; projects: number; workers: { active: number } }
export interface ProjectView { id: string; name: string; provider: string; path?: string; jobs: { total: number; active: number; waitingOnHuman: number } }
export interface SnapshotJob { id: string; projectId: string; project: string; state: string; revision: number; risk: string; prNumber: number | null; title: { text: string; trust: "untrusted" }; paused: boolean; updatedAt: string }
export type ApprovalItem = { id: string; type: "job-decision"; project: string; revision: number; title: { text: string }; at: string } | { id: string; type: "capability-approval"; operation: string; capability: string; digest: string; permissionDigest: string; expiresAt: string };
export interface ModelsView { configLoaded: boolean; policy: { allowedInferenceModes: string[]; modelApiBillingEnabled: boolean }; available: Array<{ id: string; path: string }>; qualified: Array<{ role: string; model: string; runtime: string; expiresAt: string | null }>; authorizedProviders: string[]; summary: { available: number; qualified: number; authorized: number }; note?: string }

/** Plain-language health for a non-expert: one sentence first, numbers second. */
export function HealthPanel({ s }: { s: SummaryView }) {
  const attention = s.approvals.pending > 0;
  const headline = s.workers.active === 0 && s.jobs.inFlight > 0 ? "Jobs are queued but no worker is running them." : attention ? `${s.approvals.pending} item(s) need your decision.` : s.jobs.inFlight > 0 ? `${s.jobs.inFlight} job(s) running; nothing needs you.` : "All quiet. Nothing is running and nothing needs you.";
  return (
    <section aria-labelledby="health-h"><h2 id="health-h">Factory health</h2><p className="headline" role="status">{headline}</p>
      <dl className="stats">
        <div><dt>In flight</dt><dd>{s.jobs.inFlight}</dd></div><div><dt>Waiting on you</dt><dd>{s.approvals.pending}</dd></div><div><dt>Projects</dt><dd>{s.projects}</dd></div><div><dt>Active workers</dt><dd>{s.workers.active}</dd></div><div><dt>Jobs total</dt><dd>{s.jobs.total}</dd></div>
      </dl>
    </section>
  );
}

export function ProjectsTable({ items }: { items: ProjectView[] }) {
  if (items.length === 0) return <p className="empty">No projects yet. In the terminal, add a folder on this machine with {"/new <folder>"} (no GitHub needed), or link a GitHub repository.</p>;
  return (
    <table><caption className="sr">Projects</caption>
      <thead><tr><th scope="col">Project</th><th scope="col">Source</th><th scope="col">Active</th><th scope="col">Waiting on you</th><th scope="col">Total jobs</th></tr></thead>
      <tbody>{items.map((p) => (<tr key={p.id}><td><a href={`/projects/${encodeURIComponent(p.id)}`}>{p.name}</a>{p.path ? <small className="note"> {p.path}</small> : null}</td><td>{p.provider === "local" ? "local folder" : p.provider}</td><td>{p.jobs.active}</td><td>{p.jobs.waitingOnHuman}</td><td>{p.jobs.total}</td></tr>))}</tbody>
    </table>
  );
}

export function ActiveJobsTable({ items, empty = "No jobs in the last 24 hours." }: { items: SnapshotJob[]; empty?: string }) {
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <table><caption className="sr">Jobs</caption>
      <thead><tr><th scope="col">Job</th><th scope="col">What</th><th scope="col">State</th><th scope="col">Project</th><th scope="col">Updated</th></tr></thead>
      <tbody>{items.map((j) => (<tr key={j.id}><td><a href={`/jobs/${encodeURIComponent(j.id)}`}><code>{short(j.id)}</code></a></td><td>{j.title.text.slice(0, 80)} <span className="badge muted">untrusted</span></td><td><StateBadge state={j.state} />{j.paused ? <span className="badge warn"> paused</span> : null}</td><td>{j.project}</td><td>{when(j.updatedAt)}</td></tr>))}</tbody>
    </table>
  );
}

export function ApprovalsInbox({ items, decide }: { items: ApprovalItem[]; decide: (f: FormData) => Promise<void> }) {
  if (items.length === 0) return <p className="empty">Nothing needs your attention.</p>;
  return (
    <ul className="cards">{items.map((a) => a.type === "job-decision" ? (
      <li key={a.id}><h3>Job decision · {a.project}</h3><p><span className="badge muted">untrusted</span> {a.title.text.slice(0, 100)}</p><p>This approval is bound to an exact commit and policy evidence; review it on the job page. <a href={`/inbox`}>Review and decide</a></p></li>
    ) : (
      <li key={a.id}><h3>Capability approval · {a.operation}</h3><p><code>{a.capability}</code></p>
        <p>Approving binds exactly these digests; any change voids it. Activation is a separate step.</p>
        <dl className="digests"><dt>Package digest</dt><dd><code>{a.digest}</code></dd><dt>Permission digest</dt><dd><code>{a.permissionDigest}</code></dd><dt>Expires</dt><dd>{when(a.expiresAt)}</dd></dl>
        <form action={decide} className="inline"><input type="hidden" name="requestId" value={a.id} /><input type="hidden" name="digest" value={a.digest} /><input type="hidden" name="permissionDigest" value={a.permissionDigest} />
          <label>Note (optional)<input name="note" maxLength={500} /></label><button name="decision" value="approved" type="submit">Approve these exact digests</button><button name="decision" value="rejected" type="submit">Reject</button></form></li>
    ))}</ul>
  );
}

/** Three facts, three columns: available (a runtime exists), qualified (measured and approved for a role), authorized (policy permits it). Never merged into one "ready" light. */
export function ModelReadiness({ m }: { m: ModelsView }) {
  return (
    <section aria-label="Model readiness">
      <p className="headline" role="status">{m.summary.available === 0 ? "No model runtime is configured, so no model work can run." : m.summary.qualified === 0 ? "A runtime exists, but no model is qualified for any critical role." : m.summary.authorized === 0 ? "Models are qualified but no provider authorization is recorded." : "A qualified, authorized model is available."}</p>
      <dl className="stats"><div><dt>Available</dt><dd>{m.summary.available}</dd></div><div><dt>Qualified</dt><dd>{m.summary.qualified}</dd></div><div><dt>Authorized</dt><dd>{m.summary.authorized}</dd></div></dl>
      <p>Allowed inference: {m.policy.allowedInferenceModes.join(", ") || "none"}. Usage-billed model APIs: <strong>{m.policy.modelApiBillingEnabled ? "enabled" : "disabled"}</strong>.</p>
      {!m.configLoaded ? <p role="alert" className="error">Policy configuration could not be read; showing nothing as ready.</p> : null}
      <h3>Available runtimes</h3>{m.available.length ? <ul>{m.available.map((x) => <li key={x.id}><code>{x.id}</code></li>)}</ul> : <p className="empty">None.</p>}
      <h3>Qualified for a role</h3>{m.qualified.length ? <ul>{m.qualified.map((x, i) => <li key={i}>{x.role}: <code>{x.model}</code> on {x.runtime}{x.expiresAt ? ` (until ${String(x.expiresAt).slice(0, 10)})` : ""}</li>)}</ul> : <p className="empty">None. Qualification needs a measured, approved record per role.</p>}
      <h3>Authorized providers</h3>{m.authorizedProviders.length ? <ul>{m.authorizedProviders.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="empty">None. Subscription CLIs stay blocked until terms are recorded.</p>}
    </section>
  );
}

export function CommandBox({ action, notice }: { action: (f: FormData) => Promise<void>; notice?: string | undefined }) {
  return (
    <form action={action} className="command" role="search" aria-label="Command">
      <label htmlFor="cmd">Command or question</label>
      <div className="row"><input id="cmd" name="text" autoComplete="off" maxLength={500} placeholder="e.g. /jobs, “show my jobs”, /models" aria-describedby="cmd-help" /><button type="submit">Go</button></div>
      <p id="cmd-help" className="note">Navigates only; it never changes anything. Changes use confirmed controls on each page.</p>
      {notice ? <p role="status" className="notice">{notice}</p> : null}
    </form>
  );
}

export function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) { return (<section aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>); }

export function JobControls({ jobId, state, paused, revision, act }: { jobId: string; state: string; paused: boolean; revision: number; act: (f: FormData) => Promise<void> }) {
  const terminal = ["DONE", "CANCELLED", "REJECTED", "FAILED"].includes(state);
  if (terminal) return <p className="note">This job is finished; there is nothing to control.</p>;
  return (
    <section aria-label="Job controls"><h2>Controls</h2>
      <form action={act} className="inline"><input type="hidden" name="jobId" value={jobId} /><input type="hidden" name="revision" value={revision} />
        {paused ? <button name="op" value="resume" type="submit">Resume</button> : <button name="op" value="pause" type="submit">Pause at a safe point</button>}</form>
      <form action={act} className="inline danger"><input type="hidden" name="jobId" value={jobId} /><input type="hidden" name="revision" value={revision} /><input type="hidden" name="op" value="cancel" />
        <label>To cancel this job, type its id prefix <code>{short(jobId)}</code><input name="confirm" required pattern={short(jobId)} autoComplete="off" aria-describedby="cancel-help" /></label><button type="submit">Cancel job</button>
        <p id="cancel-help" className="note">Cancelling cannot be undone. It applies only if the job is still at revision {revision}.</p></form>
    </section>
  );
}
