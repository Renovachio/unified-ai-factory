import { api } from "../../lib/api";
import { ErrorNote, ImprovementsTable, Page, type ImprovementRow } from "../../lib/view";

export const dynamic = "force-dynamic";

export default async function Improvements() {
  const r = await api<{ items: ImprovementRow[] }>("/v2/improvements");
  return (
    <Page title="Improvement backlog">
      <p>Evidence-backed proposals from opted-in, anonymised signals. The supervisor can observe and propose only; approval, activation and rollback policy belong to humans.</p>
      {r.ok ? <ImprovementsTable items={r.data.items} /> : <ErrorNote error={r.error} />}
    </Page>
  );
}
