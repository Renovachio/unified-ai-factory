import { api } from "../../../lib/api";
import { CandidateDiff, ComparisonPanel, ErrorNote, Page, UntrustedText, type ComparisonView } from "../../../lib/view";

export const dynamic = "force-dynamic";

interface Detail { id: string; state: string; action: string; risk: string; problem: string; hypothesis: string; targetDigest: string; candidateDigest: string | null; rollbackRule: string | null;
  approvalPackage: { diff: string; security: { ok: boolean; errors: string[] }; license: { declared: string | null; review: string | null }; grantedScopes: Record<string, string[]> | null; rollbackRules: string } | null; comparison: ComparisonView | null }

export default async function ImprovementDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<Detail>(`/v2/improvements/${encodeURIComponent(id)}`);
  if (!r.ok) return <Page title="Improvement"><ErrorNote error={r.error} /></Page>;
  const d = r.data; const p = d.approvalPackage;
  return (
    <Page title={`Improvement ${d.id.slice(0, 8)}`}>
      <p>State <strong>{d.state}</strong> · {d.action} · risk {d.risk}</p>
      <UntrustedText title="problem" text={d.problem} />
      <UntrustedText title="hypothesis" text={d.hypothesis} />
      <p>Active version <code>{d.targetDigest.slice(7, 19)}</code> → candidate <code>{d.candidateDigest?.slice(7, 19) ?? "–"}</code></p>
      {p ? (<>
        <h3>Candidate diff</h3><CandidateDiff diff={p.diff} />
        <p>Security: {p.security.ok ? "static checks passed" : `FAILED (${p.security.errors.join(", ")})`} · license {p.license.declared ?? "none"} ({p.license.review ?? "unreviewed"})</p>
        <p>Granted scopes: {p.grantedScopes ? Object.entries(p.grantedScopes).map(([k, v]) => `${k}: ${v.join(", ") || "none"}`).join(" · ") : "–"}</p>
        <p>Rollback rule: {p.rollbackRules}</p>
      </>) : <p className="empty">No approval package yet.</p>}
      <ComparisonPanel c={d.comparison} />
      <p><small>Approval is performed by an independent human through the approvals API for the exact digests shown; this page cannot approve or activate.</small></p>
    </Page>
  );
}
