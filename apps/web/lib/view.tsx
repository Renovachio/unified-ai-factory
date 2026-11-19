import type { ReactNode } from "react";

/** Only http(s) links are ever rendered as hrefs (blocks javascript:/data: URLs coming from remote data). */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null; } catch { return null; }
}
export const short = (s: unknown, n = 8): string => (typeof s === "string" ? s.slice(0, n) : "");
export const when = (iso: unknown): string => (typeof iso === "string" ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "");

const TONE: Record<string, string> = {
  DONE: "ok", MERGED: "ok", POSTMERGE_MONITOR: "ok", FAILED: "bad", QUARANTINED: "bad", REJECTED: "bad", CANCELLED: "muted", AWAITING_HUMAN: "warn", NEEDS_INFO: "warn",
};
export function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${TONE[state] ?? "info"}`}>{state}</span>;
}
export function RiskBadge({ risk }: { risk: string }) {
  return <span className={`badge risk-${risk.toLowerCase()}`} title="Risk is set by deterministic rules; a model can only raise it">{risk}</span>;
}

export interface JobRow { id: string; repositoryId: string; state: string; version: number; risk: string; priority: string; prNumber: number | null; createdAt: string; updatedAt: string }

export function JobsTable({ items }: { items: JobRow[] }) {
  if (items.length === 0) return <p className="empty">No jobs yet.</p>;
  return (
    <table>
      <caption className="sr">Jobs</caption>
      <thead><tr><th scope="col">Job</th><th scope="col">State</th><th scope="col">Risk</th><th scope="col">Priority</th><th scope="col">PR</th><th scope="col">Updated</th></tr></thead>
      <tbody>
        {items.map((j) => (
          <tr key={j.id}>
            <td><a href={`/jobs/${encodeURIComponent(j.id)}`}><code>{short(j.id)}</code></a></td>
            <td><StateBadge state={j.state} /></td><td><RiskBadge risk={j.risk} /></td><td>{j.priority}</td>
            <td>{j.prNumber ?? "–"}</td><td>{when(j.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface TimelineEntryView { ts: string; source: string; id: string; kind: string; summary: string; data: Record<string, unknown> }
export function Timeline({ entries }: { entries: TimelineEntryView[] }) {
  if (entries.length === 0) return <p className="empty">No history recorded.</p>;
  return (
    <ol className="timeline" aria-label="Job timeline">
      {entries.map((e) => (
        <li key={`${e.source}:${e.id}`} data-source={e.source}>
          <time dateTime={e.ts}>{when(e.ts)}</time>
          <span className="src">{e.source}</span>
          <strong>{e.kind}</strong>
          <span className="sum">{e.summary}</span>
          <details><summary>details</summary><pre>{JSON.stringify(e.data, null, 2)}</pre></details>
        </li>
      ))}
    </ol>
  );
}

/** Requester-supplied text is shown as data, in a box that says so. React escapes it; it is never interpreted as HTML or instructions. */
export function UntrustedText({ title, text }: { title: string; text: string }) {
  return (
    <section aria-label="Request (untrusted)">
      <h3>{title} <span className="badge muted">untrusted input</span></h3>
      <pre className="untrusted">{text}</pre>
    </section>
  );
}

export interface UsageView {
  window: { since: string; until: string };
  jobs: { byState: Record<string, number> };
  runtimes: Array<{ runtimeId: string; modelId: string; authMode: string; usageSource: string; runs: number; succeeded: number; failed: number; computeSeconds: number | null; tokensIn: number | null; tokensOut: number | null }>;
  roles: Array<{ role: string; runs: number; avgComputeSeconds: number | null }>;
  pressure: { rateLimitEvents: number; expiredLeases: number; invalidReviewReports: number; reworkRequests: number; gateFailures: number };
  capacity: { runningTasks: number; workers: Record<string, number>; localMaxRunningJobs: number; host: { cpuCount: number; loadAvg1m: number; memTotalMb: number; memFreeMb: number } };
  note: string;
}
export function UsagePanel({ u }: { u: UsageView }) {
  return (
    <div>
      <p className="note">{u.note}</p>
      <h3>Runtimes</h3>
      <table><caption className="sr">Runtime utilisation</caption>
        <thead><tr><th scope="col">Runtime</th><th scope="col">Model</th><th scope="col">Auth mode</th><th scope="col">Runs</th><th scope="col">OK</th><th scope="col">Failed</th><th scope="col">Compute s</th><th scope="col">Tokens in/out (capacity)</th></tr></thead>
        <tbody>{u.runtimes.map((r) => (<tr key={`${r.runtimeId}|${r.modelId}|${r.authMode}|${r.usageSource}`}><td>{r.runtimeId}</td><td>{r.modelId}</td><td>{r.authMode}</td><td>{r.runs}</td><td>{r.succeeded}</td><td>{r.failed}</td><td>{r.computeSeconds?.toFixed(1) ?? "–"}</td><td>{r.tokensIn ?? "–"} / {r.tokensOut ?? "–"}</td></tr>))}</tbody>
      </table>
      <h3>Pressure and retry waste</h3>
      <ul>
        <li>Rate-limit events: {u.pressure.rateLimitEvents}</li><li>Expired leases: {u.pressure.expiredLeases}</li><li>Invalid review reports: {u.pressure.invalidReviewReports}</li>
        <li>Rework requests: {u.pressure.reworkRequests}</li><li>Gate failures: {u.pressure.gateFailures}</li>
      </ul>
      <h3>Capacity</h3>
      <ul>
        <li>Running tasks: {u.capacity.runningTasks} (local limit {u.capacity.localMaxRunningJobs})</li>
        <li>Workers: {Object.entries(u.capacity.workers).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}</li>
        <li>Host: {u.capacity.host.cpuCount} CPU, load {u.capacity.host.loadAvg1m}, memory free {u.capacity.host.memFreeMb} / {u.capacity.host.memTotalMb} MB</li>
      </ul>
    </div>
  );
}

export function WorkersTable({ items }: { items: Array<{ id: string; mode: string; status: string; heartbeatAt: string | null; activeLeases: number; capabilities: Record<string, unknown> }> }) {
  if (items.length === 0) return <p className="empty">No workers enrolled.</p>;
  return (
    <table><caption className="sr">Workers</caption>
      <thead><tr><th scope="col">Worker</th><th scope="col">Mode</th><th scope="col">Status</th><th scope="col">Heartbeat</th><th scope="col">Leases</th><th scope="col">Sandbox</th></tr></thead>
      <tbody>{items.map((w) => (<tr key={w.id}><td><code>{short(w.id)}</code></td><td>{w.mode}</td><td><StateBadge state={w.status.toUpperCase()} /></td><td>{when(w.heartbeatAt) || "never"}</td><td>{w.activeLeases}</td><td>{String(w.capabilities.sandbox ?? "?")} / {String(w.capabilities.isolation ?? "?")}</td></tr>))}</tbody>
    </table>
  );
}

export function AuditTable({ items }: { items: Array<{ id: string; at: string; actor: string; action: string; resource: string; result: string; reason: string | null }> }) {
  if (items.length === 0) return <p className="empty">No audit entries.</p>;
  return (
    <table><caption className="sr">Audit log</caption>
      <thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Resource</th><th scope="col">Result</th><th scope="col">Reason</th></tr></thead>
      <tbody>{items.map((a) => (<tr key={a.id}><td>{when(a.at)}</td><td><code>{short(a.actor, 12)}</code></td><td>{a.action}</td><td><code>{a.resource}</code></td><td>{a.result}</td><td>{a.reason ?? ""}</td></tr>))}</tbody>
    </table>
  );
}

export interface PolicyViewModel { risk: string; reviewers: { required: string[]; reasons: string[] }; gates: Array<{ verdict: string; headSha: string; at: string }>; mergeEligibility: { autoMergeEligible: boolean; requiresHuman: boolean; reasons: string[]; policyDigest: string | null; headSha: string | null } }
export function PolicyPanel({ p }: { p: PolicyViewModel }) {
  return (
    <section aria-label="Policy">
      <p>Risk <RiskBadge risk={p.risk} /> — risk is explained by the reasons below, never by a single confidence score.</p>
      <h4>Required reviewers</h4>
      <ul>{p.reviewers.required.map((r) => (<li key={r}>{r}</li>))}</ul>
      <ul className="reasons">{p.reviewers.reasons.map((r) => (<li key={r}>{r}</li>))}</ul>
      <h4>Merge eligibility</h4>
      <p>Unattended merge: <strong>{p.mergeEligibility.autoMergeEligible ? "eligible" : "not eligible"}</strong>. Human approval: <strong>{p.mergeEligibility.requiresHuman ? "required" : "not required"}</strong>.</p>
      <ul className="reasons">{p.mergeEligibility.reasons.map((r) => (<li key={r}>{r}</li>))}</ul>
      <p>Candidate <code>{short(p.mergeEligibility.headSha, 12) || "–"}</code> · policy <code>{short(p.mergeEligibility.policyDigest?.replace("sha256:", ""), 12) || "–"}</code></p>
    </section>
  );
}

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (<><h1>{title}</h1>{children}</>);
}
export function ErrorNote({ error }: { error: { status: number; title: string; detail?: string } }) {
  return (
    <div role="alert" className="error">
      <strong>{error.status === 401 ? "Sign in required" : error.status === 403 ? "Not permitted" : error.title}</strong>
      {error.detail ? <p>{error.detail}</p> : null}
      {error.status === 401 ? <p>This dashboard authenticates through your organisation's OIDC session; none was provided.</p> : null}
    </div>
  );
}
