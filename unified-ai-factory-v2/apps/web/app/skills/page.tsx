import { api } from "../../lib/api";
import { ErrorNote, Page, SkillsTable, type SkillRow } from "../../lib/view";

export const dynamic = "force-dynamic";

export default async function Skills() {
  const r = await api<{ items: SkillRow[] }>("/v2/skills");
  return (
    <Page title="Skills & agents">
      <p>Imported and generated capabilities. Nothing here runs until an independent human approves its exact content and permission digests; discovery and imports never execute scripts.</p>
      {r.ok ? <SkillsTable items={r.data.items} /> : <ErrorNote error={r.error} />}
    </Page>
  );
}
