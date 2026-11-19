import { api } from "../lib/api";
import { ErrorNote, Page, UsagePanel, type UsageView } from "../lib/view";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const r = await api<UsageView>("/usage");
  return (
    <Page title="Overview">
      {r.ok ? (
        <>
          <p>Jobs in window: {Object.entries(r.data.jobs.byState).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}</p>
          <UsagePanel u={r.data} />
        </>
      ) : <ErrorNote error={r.error} />}
    </Page>
  );
}
