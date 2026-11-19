import { api } from "../../../lib/api";
import { ActiveJobsTable, ProjectsTable, Section, type ProjectView, type SnapshotJob } from "../../../lib/dispatch-view";
import { ErrorNote, Page } from "../../../lib/view";

export const dynamic = "force-dynamic";
export default async function Project({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [projects, snap] = await Promise.all([api<{ items: ProjectView[] }>("/v2/dispatch/projects"), api<{ jobs: SnapshotJob[] }>("/v2/dispatch/snapshot")]);
  if (!projects.ok) return <Page title="Project"><ErrorNote error={projects.error} /></Page>;
  const p = projects.data.items.find((x) => x.id === id);
  if (!p) return <Page title="Project"><p role="alert" className="error">No such project, or it is not visible to you.</p><p><a href="/projects">All projects</a></p></Page>;
  return (
    <Page title={p.name}>
      <ProjectsTable items={[p]} />
      <Section id="p-jobs" title="Jobs in this project">{snap.ok ? <ActiveJobsTable items={snap.data.jobs.filter((j) => j.projectId === id)} empty="No jobs in this project in the last 24 hours." /> : <ErrorNote error={snap.error} />}</Section>
      <p className="note">Create work from the terminal (<code>dispatch</code>) or an existing intake channel; dashboard job creation arrives with repository linking.</p>
    </Page>
  );
}
