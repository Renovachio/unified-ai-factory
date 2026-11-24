import { api } from "../../lib/api";
import { AuditTable, ErrorNote, Page } from "../../lib/view";

export const dynamic = "force-dynamic";

export default async function Audit({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const sp = await searchParams;
  const r = await api<{ items: Parameters<typeof AuditTable>[0]["items"]; nextCursor: string | null }>(`/audit?limit=100${sp.cursor ? `&cursor=${encodeURIComponent(sp.cursor)}` : ""}`);
  return (
    <Page title="Audit">
      {r.ok ? (<><AuditTable items={r.data.items} />{r.data.nextCursor ? <p><a href={`/audit?cursor=${encodeURIComponent(r.data.nextCursor)}`}>Older entries</a></p> : null}</>) : <ErrorNote error={r.error} />}
    </Page>
  );
}
