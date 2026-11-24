import { api } from "../../lib/api";
import { ErrorNote, JobsTable, Page, type JobRow } from "../../lib/view";

export const dynamic = "force-dynamic";

export default async function Jobs({ searchParams }: { searchParams: Promise<{ cursor?: string; state?: string }> }) {
  const sp = await searchParams;
  const q = new URLSearchParams({ limit: "50", ...(sp.cursor ? { cursor: sp.cursor } : {}), ...(sp.state ? { state: sp.state } : {}) });
  const r = await api<{ items: JobRow[]; nextCursor: string | null }>(`/jobs?${q}`);
  return (
    <Page title="Jobs">
      {r.ok ? (<><JobsTable items={r.data.items} />{r.data.nextCursor ? <p><a href={`/jobs?cursor=${encodeURIComponent(r.data.nextCursor)}`}>Older jobs</a></p> : null}</>) : <ErrorNote error={r.error} />}
    </Page>
  );
}
