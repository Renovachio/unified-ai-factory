import { api } from "../../lib/api";
import { ApprovalsInbox, type ApprovalItem } from "../../lib/dispatch-view";
import { ErrorNote, Page } from "../../lib/view";
import { decideCapability } from "../actions";

export const dynamic = "force-dynamic";
export default async function Approvals({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams; const r = await api<{ items: ApprovalItem[] }>("/v2/dispatch/approvals");
  return (<Page title="Approvals">{sp.error ? <p role="alert" className="error">{sp.error.slice(0, 300)}</p> : null}{r.ok ? <ApprovalsInbox items={r.data.items} decide={decideCapability} /> : <ErrorNote error={r.error} />}</Page>);
}
