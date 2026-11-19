import { api } from "../../lib/api";
import { ModelReadiness, type ModelsView } from "../../lib/dispatch-view";
import { ErrorNote, Page } from "../../lib/view";

export const dynamic = "force-dynamic";
export default async function Models() {
  const r = await api<ModelsView>("/v2/dispatch/capabilities?category=models");
  return (<Page title="Models">{r.ok ? <ModelReadiness m={r.data} /> : <ErrorNote error={r.error} />}</Page>);
}
