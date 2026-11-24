import { api } from "../../lib/api";
import { ErrorNote, Page, WorkersTable } from "../../lib/view";

export const dynamic = "force-dynamic";

export default async function Workers() {
  const r = await api<{ items: Parameters<typeof WorkersTable>[0]["items"] }>("/workers");
  return <Page title="Workers">{r.ok ? <WorkersTable items={r.data.items} /> : <ErrorNote error={r.error} />}</Page>;
}
