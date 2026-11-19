import { api } from "../../lib/api";
import { ErrorNote, Page, UsagePanel, type UsageView } from "../../lib/view";

export const dynamic = "force-dynamic";

export default async function Usage() {
  const r = await api<UsageView>("/usage");
  return <Page title="Usage & capacity">{r.ok ? <UsagePanel u={r.data} /> : <ErrorNote error={r.error} />}</Page>;
}
