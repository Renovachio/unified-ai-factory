import { api } from "../../../lib/api";
import { ErrorNote, Page, PolicyPanel, RiskBadge, safeUrl, StateBadge, Timeline, UntrustedText, type PolicyViewModel, type TimelineEntryView } from "../../../lib/view";

export const dynamic = "force-dynamic";

interface Detail { id: string; state: string; version: number; risk: string; headSha: string | null; baseSha: string | null; prNumber: number | null; round: number; maxRounds: number; pausedAt: string | null; pauseReason: string | null; request: { type: string; title: string; description: string } }

export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tl, pol] = await Promise.all([
    api<{ job: Detail; entries: TimelineEntryView[]; nextCursor: string | null }>(`/jobs/${encodeURIComponent(id)}/timeline?limit=500`),
    api<PolicyViewModel>(`/jobs/${encodeURIComponent(id)}/policy`),
  ]);
  if (!tl.ok) return <Page title="Job"><ErrorNote error={tl.error} /></Page>;
  const j = tl.data.job;
  const prLink = safeUrl(tl.data.entries.find((e) => e.source === "pull_request")?.data.url);
  return (
    <Page title={`Job ${id.slice(0, 8)}`}>
      <p><StateBadge state={j.state} /> <RiskBadge risk={j.risk} /> round {j.round}/{j.maxRounds}{j.pausedAt ? ` · paused: ${j.pauseReason ?? ""}` : ""}</p>
      <p>Candidate <code>{j.headSha?.slice(0, 12) ?? "–"}</code> on base <code>{j.baseSha?.slice(0, 12) ?? "–"}</code>{prLink ? <> · <a href={prLink} rel="noreferrer noopener">pull request #{j.prNumber}</a></> : null}</p>
      <UntrustedText title={j.request.title} text={j.request.description} />
      <h2>Policy</h2>
      {pol.ok ? <PolicyPanel p={pol.data} /> : <ErrorNote error={pol.error} />}
      <h2>Timeline</h2>
      <Timeline entries={tl.data.entries} />
      {tl.data.nextCursor ? <p className="note">History continues; fetch with the cursor via the API for the remainder.</p> : null}
    </Page>
  );
}
