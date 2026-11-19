import { api } from "../../lib/api";
import { decide } from "../actions";
import { ErrorNote, JobsTable, Page, short, type JobRow } from "../../lib/view";

export const dynamic = "force-dynamic";

interface Pol { mergeEligibility: { headSha: string | null; policyDigest: string | null } }
interface Detail { baseSha: string | null; version: number }

export default async function Inbox() {
  const [waiting, info] = await Promise.all([api<{ items: JobRow[] }>("/jobs?state=AWAITING_HUMAN&limit=50"), api<{ items: JobRow[] }>("/jobs?state=NEEDS_INFO&limit=50")]);
  if (!waiting.ok) return <Page title="Inbox"><ErrorNote error={waiting.error} /></Page>;
  const cards = await Promise.all(waiting.data.items.map(async (j) => ({ j, pol: await api<Pol>(`/jobs/${j.id}/policy`), d: await api<Detail>(`/jobs/${j.id}`) })));
  return (
    <Page title="Inbox">
      <h2>Awaiting your decision</h2>
      {cards.length === 0 ? <p className="empty">Nothing is waiting for approval.</p> : null}
      {cards.map(({ j, pol, d }) => pol.ok && d.ok && pol.data.mergeEligibility.headSha && pol.data.mergeEligibility.policyDigest && d.data.baseSha ? (
        <section key={j.id} aria-label={`Approval for job ${short(j.id)}`}>
          <h3><a href={`/jobs/${j.id}`}>Job {short(j.id)}</a> · risk {j.risk}</h3>
          <p>You are approving candidate <code>{short(pol.data.mergeEligibility.headSha, 12)}</code> (base <code>{short(d.data.baseSha, 12)}</code>). The approval is void if the head, base, policy or evidence change.</p>
          <form action={decide} className="inline">
            <input type="hidden" name="jobId" value={j.id} /><input type="hidden" name="headSha" value={pol.data.mergeEligibility.headSha} /><input type="hidden" name="baseSha" value={d.data.baseSha} />
            <input type="hidden" name="policyDigest" value={pol.data.mergeEligibility.policyDigest} /><input type="hidden" name="expectedVersion" value={d.data.version} />
            <label>Reason (required to reject or request changes)<input name="reason" maxLength={1000} /></label>
            <button name="decision" value="approve" type="submit">Approve exact candidate</button>
            <button name="decision" value="rework" type="submit">Request changes</button>
            <button name="decision" value="reject" type="submit">Reject</button>
          </form>
        </section>
      ) : (<p key={j.id}><a href={`/jobs/${j.id}`}>Job {short(j.id)}</a> — evidence incomplete; open the job.</p>))}
      <h2>Waiting for an answer from the requester</h2>
      {info.ok ? <JobsTable items={info.data.items} /> : <ErrorNote error={info.error} />}
    </Page>
  );
}
