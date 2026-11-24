import { api } from "../lib/api";
import { ActiveJobsTable, ApprovalsInbox, CommandBox, HealthPanel, ProjectsTable, Section, type ApprovalItem, type ProjectView, type SnapshotJob, type SummaryView } from "../lib/dispatch-view";
import { ErrorNote, Page } from "../lib/view";
import { decideCapability, runCommand } from "./actions";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const sp = await searchParams;
  const [sum, projects, snap, appr] = await Promise.all([api<SummaryView>("/v2/dispatch/summary"), api<{ items: ProjectView[] }>("/v2/dispatch/projects"), api<{ jobs: SnapshotJob[] }>("/v2/dispatch/snapshot"), api<{ items: ApprovalItem[] }>("/v2/dispatch/approvals")]);
  return (
    <Page title="Dispatch">
      <CommandBox action={runCommand} notice={sp.notice?.slice(0, 400)} />
      {sum.ok ? <HealthPanel s={sum.data} /> : <ErrorNote error={sum.error} />}
      <Section id="needs-you" title="Needs your attention">{appr.ok ? <ApprovalsInbox items={appr.data.items} decide={decideCapability} /> : <ErrorNote error={appr.error} />}</Section>
      <Section id="active" title="Jobs">{snap.ok ? <ActiveJobsTable items={snap.data.jobs.slice(0, 15)} /> : <ErrorNote error={snap.error} />}{snap.ok && snap.data.jobs.length > 15 ? <p><a href="/jobs">All jobs</a></p> : null}</Section>
      <Section id="projects" title="Projects">{projects.ok ? <ProjectsTable items={projects.data.items} /> : <ErrorNote error={projects.error} />}</Section>
    </Page>
  );
}
