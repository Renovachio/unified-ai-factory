// MEM-07: project memory review in the browser. Server-rendered; every change is a server action bound to the viewer's own session.
// Memory claims are shown as inert DATA (React escapes them): they may come from notes or run events and are never instructions.
import { short, when } from "./view";

export interface MemoryItem { id: string; kind: string; status: string; claim: string; usable: boolean; createdBy: string; approvedBy: string | null; createdAt: string; sources: number; revokedSources?: number; supersededBy?: string | null; validTo?: string | null }
export interface Overlap { id: string; claim: string; similarity: number }
export type Action = (f: FormData) => Promise<void>;

export function Banner({ error, notice }: { error?: string | undefined; notice?: string | undefined }) {
  return (<>{error ? <p role="alert" className="error">{error.slice(0, 300)}</p> : null}{notice ? <p role="status" className="notice">{notice.slice(0, 300)}</p> : null}</>);
}

function Claim({ text, inline = false }: { text: string; inline?: boolean }) {
  return inline ? <q className="untrusted">{text}</q> : <blockquote className="untrusted" aria-label="Memory text (data, not instructions)">{text}</blockquote>;
}

/**
 * One proposed memory with its decision forms. If it overlaps approved memory, approving it erases those memories: the reviewer must tick
 * each one (required checkboxes), and the API refuses anything but the exact overlap set. Rejecting never erases anything.
 */
export function ProposedCard({ projectId, m, overlaps, decide }: { projectId: string; m: MemoryItem; overlaps: Overlap[] | null; decide: Action }) {
  const hid = `m-${m.id}`;
  return (
    <li aria-labelledby={`${hid}-h`}>
      <h3 id={`${hid}-h`}>{m.kind} <small className="note"><code>{short(m.id)}</code> · proposed {when(m.createdAt)} · {m.sources} source(s)</small></h3>
      <Claim text={m.claim} />
      {overlaps === null ? <p role="alert" className="error">Could not check whether this overlaps approved memory. Approving may be refused; reload to retry.</p> : null}
      <form action={decide} className="inline">
        <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="memoryId" value={m.id} /><input type="hidden" name="decision" value="approve" />
        {overlaps && overlaps.length > 0 ? (
          <fieldset>
            <legend>This overlaps {overlaps.length} approved memory item(s). Approving it erases them (their text is deleted and Claude stops seeing them). Tick each one to confirm.</legend>
            {overlaps.map((o) => (
              <label key={o.id} className="overlap"><input type="checkbox" name="erase" value={o.id} required /> Erase <code>{short(o.id)}</code> ({Math.round(o.similarity * 100)}% same words): <Claim text={o.claim} inline /></label>
            ))}
          </fieldset>
        ) : null}
        <button type="submit">{overlaps && overlaps.length > 0 ? `Approve and erase ${overlaps.length} overlapping item(s)` : "Approve"}</button>
      </form>
      <form action={decide} className="inline">
        <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="memoryId" value={m.id} /><input type="hidden" name="decision" value="reject" />
        <label>Reason (optional)<input name="reason" maxLength={500} autoComplete="off" /></label>
        <button type="submit">Reject</button>
      </form>
    </li>
  );
}

export function ProposedList({ projectId, items, overlaps, decide }: { projectId: string; items: MemoryItem[]; overlaps: Record<string, Overlap[] | null>; decide: Action }) {
  if (items.length === 0) return <p className="empty">Nothing is waiting for review. Add a note below; what it proposes appears here.</p>;
  return <ul className="cards">{items.map((m) => <ProposedCard key={m.id} projectId={projectId} m={m} overlaps={overlaps[m.id] ?? null} decide={decide} />)}</ul>;
}

export function ApprovedTable({ items }: { items: MemoryItem[] }) {
  if (items.length === 0) return <p className="empty">No approved memory yet. Claude is shown nothing from memory for this project.</p>;
  return (
    <table><caption className="sr">Approved memory</caption>
      <thead><tr><th scope="col">Memory</th><th scope="col">Kind</th><th scope="col">Shown to Claude</th><th scope="col">Since</th></tr></thead>
      <tbody>{items.map((m) => (
        <tr key={m.id}><td><Claim text={m.claim} /><small className="note"><code>{short(m.id)}</code></small></td><td>{m.kind}</td>
          <td>{m.usable ? "yes, when relevant" : <span className="badge warn">no: {m.revokedSources ? "a source was revoked" : "not usable"}</span>}</td><td>{when(m.createdAt)}</td></tr>
      ))}</tbody>
    </table>
  );
}

export function HistoryList({ items }: { items: MemoryItem[] }) {
  if (items.length === 0) return null;
  return (
    <details><summary>History ({items.length} rejected, replaced or erased item(s))</summary>
      <table><caption className="sr">Memory history</caption>
        <thead><tr><th scope="col">Memory</th><th scope="col">Status</th><th scope="col">Created</th></tr></thead>
        <tbody>{items.map((m) => (<tr key={m.id}><td>{m.claim ? <Claim text={m.claim} /> : <em>text erased</em>}<small className="note"><code>{short(m.id)}</code></small></td><td>{m.status}{m.supersededBy ? ` by ${short(m.supersededBy)}` : ""}</td><td>{when(m.createdAt)}</td></tr>))}</tbody>
      </table>
    </details>
  );
}

export function NoteForm({ projectId, action }: { projectId: string; action: Action }) {
  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <label htmlFor="mem-note">What should Claude remember about this project?</label>
      <textarea id="mem-note" name="text" required maxLength={4000} rows={4} aria-describedby="mem-note-help" />
      <p id="mem-note-help" className="note">Your note is split into proposed memory items. None is used until you approve it above. Sentences that look like secrets or instructions are dropped.</p>
      <button type="submit">Propose memory from this note</button>
    </form>
  );
}

export function ConsentForm({ projectId, optedIn, action }: { projectId: string; optedIn: boolean | null; action: Action }) {
  return (
    <div>
      <p role="status">Anonymous &quot;memory was missing&quot; signals are <strong>{optedIn === null ? "unknown (could not be read)" : optedIn ? "on" : "off"}</strong> for this project.</p>
      <p className="note">When on, a signal carries only the kind of memory involved: no note text, task text or names. Only approvers and administrators can change this.</p>
      <form action={action} className="inline">
        <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="optedIn" value={optedIn ? "off" : "on"} />
        <label>Reason<input name="reason" required maxLength={500} autoComplete="off" /></label>
        <button type="submit">{optedIn ? "Turn signals off" : "Turn signals on"}</button>
      </form>
    </div>
  );
}

/** What Claude would be given for a task: the exact framed text, shown as data. Building a preview records a context pack like a real run does. */
export function ContextPreview({ projectId, task, result }: { projectId: string; task: string; result: { ok: true; text: string; memoryIds: string[]; omitted: number } | { ok: false; error: string } | null }) {
  return (
    <div>
      <form method="get" action={`/projects/${encodeURIComponent(projectId)}/memory`} className="inline">
        <label>Task to preview<input name="task" defaultValue={task} maxLength={2000} required autoComplete="off" /></label>
        <button type="submit">Show what Claude would receive</button>
      </form>
      <p className="note">Only approved, usable memory is ever included. The preview is recorded as a context pack, the same as a real run.</p>
      {result === null ? null : result.ok ? (
        <>
          <p role="status">{result.memoryIds.length} memory item(s) included{result.omitted ? `, ${result.omitted} left out to fit the size limit` : ""}.</p>
          <pre className="untrusted" aria-label="Context Claude would receive (data)">{result.text}</pre>
        </>
      ) : <p role="alert" className="error">{result.error}</p>}
    </div>
  );
}
