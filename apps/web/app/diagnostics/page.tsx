import { api } from "../../lib/api";
import { HealthPanel, ModelReadiness, Section, type ModelsView, type SummaryView } from "../../lib/dispatch-view";
import { ErrorNote, Page } from "../../lib/view";

export const dynamic = "force-dynamic";
export default async function Diagnostics() {
  const [ready, sum, models] = await Promise.all([api<Record<string, unknown>>("/health/ready"), api<SummaryView>("/v2/dispatch/summary"), api<ModelsView>("/v2/dispatch/capabilities?category=models")]);
  return (
    <Page title="Diagnostics">
      <p className="note">Service lifecycle (start, stop, restart) is managed from the terminal: <code>dispatch status</code> and <code>dispatch doctor</code>. This page shows what the API itself can see.</p>
      <Section id="d-api" title="API and database">{ready.ok ? <p role="status">API reachable; database ready.</p> : <ErrorNote error={ready.error} />}</Section>
      <Section id="d-health" title="Work">{sum.ok ? <HealthPanel s={sum.data} /> : <ErrorNote error={sum.error} />}</Section>
      <Section id="d-models" title="Models">{models.ok ? <ModelReadiness m={models.data} /> : <ErrorNote error={models.error} />}</Section>
    </Page>
  );
}
