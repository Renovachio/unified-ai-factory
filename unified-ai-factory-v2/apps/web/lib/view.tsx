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

// ---- v2.2: skill/agent registry and improvement backlog views (read-only; never activate anything) ----
export interface SkillRow { id: string; kind: string; slug: string; version: string; digest: string; state: string; active: boolean; createdAt: string }
export function SkillsTable({ items }: { items: SkillRow[] }) {
  if (items.length === 0) return <p className="empty">No skills or agents have been imported. Imports start in quarantine and stay inactive until an independent human approves the exact digest.</p>;
  return (
    <table><caption className="sr">Skill and agent versions</caption>
      <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">State</th><th scope="col">Active</th><th scope="col">Digest</th></tr></thead>
      <tbody>{items.map((s) => (<tr key={s.id}><td>{s.slug} <small>{s.version}</small></td><td>{s.kind}</td><td>{s.state}</td><td>{s.active ? "active" : "inactive"}</td><td><code>{s.digest.slice(7, 19)}</code></td></tr>))}</tbody>
    </table>
  );
}
export interface ImprovementRow { id: string; state: string; action: string; risk: string; problem: string; hypothesis: string; targetDigest: string; candidateDigest: string | null; comparisonId: string | null; rank: number }
export function ImprovementsTable({ items }: { items: ImprovementRow[] }) {
  if (items.length === 0) return <p className="empty">No improvement proposals. The supervisor only proposes; every change needs an independent human approval.</p>;
  return (
    <table><caption className="sr">Improvement backlog</caption>
      <thead><tr><th scope="col">Proposal</th><th scope="col">State</th><th scope="col">Risk</th><th scope="col">Problem</th><th scope="col">Rank</th></tr></thead>
      <tbody>{items.map((p) => (<tr key={p.id}><td><a href={`/improvements/${p.id}`}>{p.id.slice(0, 8)}</a> <small>{p.action}</small></td><td>{p.state}</td><td>{p.risk}</td><td><UntrustedText title="problem" text={p.problem} /></td><td>{p.rank.toFixed(3)}</td></tr>))}</tbody>
    </table>
  );
}
export interface ComparisonView { id: string; status: string; benchmarkDigest: string; evaluator: string; metrics: Record<string, number>; criticalRegressions: number; sampleSize: number; uncertaintyNotes: string; reasons: string[]; recommendation: string }
export function ComparisonPanel({ c }: { c: ComparisonView | null }) {
  if (!c) return <p className="empty">No independent evaluation has been recorded for this proposal.</p>;
  const m = c.metrics; const f = (k: string) => (m[k] === undefined ? "–" : m[k].toFixed(3));
  return (
    <section aria-label="Evaluation comparison">
      <h3>Evaluation: {c.status} — {c.recommendation === "recommend_approval" ? "approval may be recommended" : "approval NOT recommended"}</h3>
      <table><caption className="sr">Paired comparison on the same benchmark</caption>
        <thead><tr><th scope="col">Baseline mean</th><th scope="col">Candidate mean</th><th scope="col">Improvement</th><th scope="col">95% interval</th><th scope="col">Critical regressions</th><th scope="col">Samples</th></tr></thead>
        <tbody><tr><td>{f("baselineMean")}</td><td>{f("candidateMean")}</td><td>{f("meanImprovement")}</td><td>[{f("ciLow")}, {f("ciHigh")}]</td><td>{c.criticalRegressions}</td><td>{c.sampleSize}</td></tr></tbody>
      </table>
      <p>Benchmark <code>{c.benchmarkDigest.slice(7, 19)}</code> · evaluator <code>{c.evaluator}</code></p>
      <UntrustedText title="limitations" text={c.uncertaintyNotes} />
      <ul>{c.reasons.map((r, i) => (<li key={i}>{r}</li>))}</ul>
    </section>
  );
}
/** Candidate diff: shown as inert text with +/- gutters; the diff comes from a candidate package and is untrusted. */
export function CandidateDiff({ diff }: { diff: string }) {
  return (
    <pre aria-label="Candidate diff" className="diff">{diff.split("\n").map((l, i) => (<span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>{l}{"\n"}</span>))}</pre>
  );
}
