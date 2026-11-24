import { api } from "../../lib/api";
import { ProjectsTable, type ProjectView } from "../../lib/dispatch-view";
import { ErrorNote, Page } from "../../lib/view";

export const dynamic = "force-dynamic";
export default async function Projects() {
  const r = await api<{ items: ProjectView[] }>("/v2/dispatch/projects");
  return (<Page title="Projects">{r.ok ? <ProjectsTable items={r.data.items} /> : <ErrorNote error={r.error} />}</Page>);
}
