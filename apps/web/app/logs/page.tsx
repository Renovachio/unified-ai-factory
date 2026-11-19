import { api } from "../../lib/api";
import { ErrorNote, Page, short, when } from "../../lib/view";

export const dynamic = "force-dynamic";
interface Ev { eventId: string; globalSeq: number; jobId: string; sequence: number; type: string; at: string }
export default async function Logs({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const sp = await searchParams; const want = (sp.job ?? "").trim().toLowerCase().slice(0, 64);
  const r = await api<{ events: Ev[] }>("/v2/dispatch/events?cursor=0&limit=500");
  if (!r.ok) return <Page title="Logs"><ErrorNote error={r.error} /></Page>;
  const rows = r.data.events.filter((e) => !want || e.jobId.toLowerCase().startsWith(want)).slice(-200).reverse();
  return (
    <Page title="Logs">
      <p className="note">Recorded events (redacted); newest first.{want ? ` Filtered to job ${short(want, 12)}.` : ""} Reload to refresh.</p>
      {rows.length === 0 ? <p className="empty">No events.</p> : (
        <table><caption className="sr">Events</caption><thead><tr><th scope="col">When</th><th scope="col">Job</th><th scope="col">#</th><th scope="col">Event</th></tr></thead>
          <tbody>{rows.map((e) => (<tr key={e.eventId}><td>{when(e.at)}</td><td><a href={`/jobs/${encodeURIComponent(e.jobId)}`}><code>{short(e.jobId)}</code></a></td><td>{e.sequence}</td><td>{e.type}</td></tr>))}</tbody></table>)}
    </Page>
  );
}
