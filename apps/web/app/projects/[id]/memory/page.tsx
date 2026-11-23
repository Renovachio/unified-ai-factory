import { api } from "../../../../lib/api";
import { Section, type ProjectView } from "../../../../lib/dispatch-view";
import { isId } from "../../../../lib/memory-form";
import { ApprovedTable, Banner, ConsentForm, ContextPreview, HistoryList, NoteForm, ProposedList, type MemoryItem, type Overlap } from "../../../../lib/memory-view";
import { ErrorNote, Page } from "../../../../lib/view";
import { memoryConsent, memoryDecide, memoryNote } from "../../../actions";

export const dynamic = "force-dynamic";
const MAX_OVERLAP_CHECKS = 50;

export default async function ProjectMemory({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string; task?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  if (!isId(id)) return <Page title="Project memory"><p role="alert" className="error">No such project, or it is not visible to you.</p><p><a href="/projects">All projects</a></p></Page>;
  const q = `projectId=${encodeURIComponent(id)}`;
  const [projects, list, consent] = await Promise.all([
    api<{ items: ProjectView[] }>("/v2/dispatch/projects"), api<{ items: MemoryItem[] }>(`/v2/dispatch/memory?${q}`), api<{ optedIn: boolean }>(`/v2/dispatch/memory/consent?${q}`),
  ]);
  if (!projects.ok) return <Page title="Project memory"><ErrorNote error={projects.error} /></Page>;
  const p = projects.data.items.find((x) => x.id === id);
  if (!p) return <Page title="Project memory"><p role="alert" className="error">No such project, or it is not visible to you.</p><p><a href="/projects">All projects</a></p></Page>;
  const items = list.ok ? list.data.items : [];
  const proposed = items.filter((m) => m.status === "proposed"); const approved = items.filter((m) => m.status === "approved");
  const history = items.filter((m) => m.status !== "proposed" && m.status !== "approved");
  // Overlap with approved memory is checked per proposed item so the reviewer sees, before approving, what approval would erase.
  const overlaps: Record<string, Overlap[] | null> = {};
  await Promise.all(proposed.slice(0, MAX_OVERLAP_CHECKS).map(async (m) => {
    const r = await api<{ items: Overlap[] }>(`/v2/dispatch/memory/${encodeURIComponent(m.id)}/conflicts?${q}`);
    overlaps[m.id] = r.ok ? r.data.items : null;
  }));
  const task = (sp.task ?? "").slice(0, 2000).trim();
  let preview: Parameters<typeof ContextPreview>[0]["result"] = null;
  if (task) {
    const r = await api<{ text: string; memoryIds: string[]; omitted: number }>(`/v2/dispatch/memory/context?${q}&task=${encodeURIComponent(task)}`);
    preview = r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error.detail ?? r.error.title };
  }
  return (
    <Page title={`Memory · ${p.name}`}>
      <p><a href={`/projects/${encodeURIComponent(id)}`}>Back to the project</a></p>
      <Banner error={sp.error} notice={sp.notice} />
      <p>Claude is shown only memory you have approved, and only when it is relevant to the task. Notes become proposals first.</p>
      {list.ok ? null : <ErrorNote error={list.error} />}
      <Section id="mem-proposed" title={`Waiting for your review (${proposed.length})`}>
        {proposed.length > MAX_OVERLAP_CHECKS ? <p className="note">Overlap was checked for the first {MAX_OVERLAP_CHECKS} items only; decide those first.</p> : null}
        <ProposedList projectId={id} items={proposed} overlaps={overlaps} decide={memoryDecide} />
      </Section>
      <Section id="mem-approved" title={`Approved (${approved.length})`}><ApprovedTable items={approved} /><HistoryList items={history} /></Section>
      <Section id="mem-note" title="Add a note"><NoteForm projectId={id} action={memoryNote} /></Section>
      <Section id="mem-context" title="What Claude would receive"><ContextPreview projectId={id} task={task} result={preview} /></Section>
      <Section id="mem-consent" title="Signals about missing memory"><ConsentForm projectId={id} optedIn={consent.ok ? consent.data.optedIn : null} action={memoryConsent} /></Section>
    </Page>
  );
}
