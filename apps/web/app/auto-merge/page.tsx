import { api } from "../../lib/api";
import { killAutoMerge } from "../actions";
import { ErrorNote, Page, when } from "../../lib/view";

export const dynamic = "force-dynamic";

interface Status { global: { killSwitch: boolean; reason: string | null; setBy: string | null; setAt: string | null }; autoMergesLast24h: number; repositories: Array<{ repositoryId: string; repository: string; enabled: boolean; signoffDigest: string | null; allowedRisks: string[]; maxPerDay: number; cooldownMinutes: number; tripped: boolean; tripReason: string | null }> }

export default async function AutoMerge() {
  const r = await api<Status>("/auto-merge");
  if (!r.ok) return <Page title="Auto-merge"><ErrorNote error={r.error} /></Page>;
  const g = r.data.global;
  return (
    <Page title="Auto-merge">
      <p>Unattended merging is <strong>opt-in</strong>, LOW-risk only, and never applies to HIGH or CRITICAL changes. The shipped policy is the pilot: every merge needs a human.</p>
      <p>Kill switch: <strong>{g.killSwitch ? "ENGAGED (auto-merge is off)" : "released"}</strong>{g.setAt ? ` · ${g.setBy ?? ""} ${when(g.setAt)}` : ""}{g.reason ? ` · ${g.reason}` : ""} · auto-merges in the last 24 h: {r.data.autoMergesLast24h}</p>
      {!g.killSwitch ? (
        <form action={killAutoMerge} className="inline"><label>Reason<input name="reason" required maxLength={1000} /></label><button type="submit">Engage kill switch</button></form>
      ) : null}
      <table><caption className="sr">Repositories opted in to auto-merge</caption>
        <thead><tr><th scope="col">Repository</th><th scope="col">Opted in</th><th scope="col">Risks</th><th scope="col">Limits</th><th scope="col">Breaker</th><th scope="col">Pilot sign-off</th></tr></thead>
        <tbody>{r.data.repositories.map((x) => (<tr key={x.repositoryId}><td>{x.repository}</td><td>{x.enabled ? "yes" : "no"}</td><td>{x.allowedRisks.join(", ")}</td><td>{x.maxPerDay}/day, {x.cooldownMinutes} min cooldown</td><td>{x.tripped ? `TRIPPED: ${x.tripReason ?? ""}` : "ok"}</td><td><code>{x.signoffDigest?.slice(7, 19) ?? "–"}</code></td></tr>))}</tbody>
      </table>
      {r.data.repositories.length === 0 ? <p className="empty">No repository has opted in.</p> : null}
    </Page>
  );
}
