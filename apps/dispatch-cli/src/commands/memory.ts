// `dispatch memory ...`: the HUMAN side of project memory. Only the person at this terminal (owner token) can write a note, approve, reject or
// change telemetry consent; Claude Code can only read approved memory and give feedback (see mcp.ts).
import { realpathSync } from "node:fs";
import { makeCtx } from "../launcher/context";
import { makeClient } from "../repl/repl";
import { safe, sym } from "../render";

export const MEMORY_HELP = `Usage (run inside the project folder):
  dispatch memory list [proposed|approved]   show this project's memory
  dispatch memory note <text...>             record something Claude should remember (becomes PROPOSED, never active until you approve)
  dispatch memory approve <id>               approve a proposed memory (first characters of the id are enough)
  dispatch memory reject <id> [reason...]    reject a proposed memory
  dispatch memory revise <id> <new text...>  correct an APPROVED memory: proposes a replacement (same sources); approve it to replace the old one
  dispatch memory erase <id> [reason...]     erase a proposed, rejected or superseded memory (approved memory leaves only by approving its replacement)
  dispatch memory export                     print everything recorded for this project as JSON
  dispatch memory consent on|off             allow/stop anonymous "memory was missing" signals for this project (default: off)`;

interface Item { id: string; kind: string; status: string; claim: string; usable: boolean }

export async function cmdMemory(args: string[], cwd = process.cwd(), out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help") { out(MEMORY_HELP); return sub ? 0 : 2; }
  let client; try { client = makeClient(makeCtx({ create: false })); } catch { err(`${sym.fail()} Dispatch has not been started yet. Run \`dispatch\` once first.`); return 1; }
  try {
    let real = cwd; try { real = realpathSync(cwd); } catch { /* use as given */ }
    const projects = await client.get<{ items?: Array<{ id: string; path?: string }> } | Array<{ id: string; path?: string }>>("/api/v2/dispatch/projects");
    const list = Array.isArray(projects) ? projects : (projects.items ?? []);
    const project = list.find((p) => p.path === real);
    if (!project) { err(`${sym.fail()} This folder is not a Dispatch project yet. Run \`dispatch code "<request>"\` here once.`); return 1; }
    const pid = project.id; const base = "/api/v2/dispatch/memory";
    const items = async (status?: string) => (await client.get<{ items: Item[] }>(`${base}?projectId=${pid}${status ? `&status=${encodeURIComponent(status)}` : ""}`)).items;
    const post = async (path: string, body: Record<string, unknown>) => client.send<Record<string, unknown>>(client.mutation("POST", path, { projectId: pid, ...body }));
    const byPrefix = async (prefix: string | undefined): Promise<Item | string> => {
      if (!prefix || prefix.length < 4) return "give at least the first 4 characters of the memory id (see `dispatch memory list`)";
      const hits = (await items()).filter((m) => m.id.startsWith(prefix));
      return hits.length === 1 ? (hits[0] as Item) : hits.length === 0 ? "no memory has that id" : "that id is ambiguous; type more of it";
    };
    if (sub === "list") {
      const rows = await items(rest[0]);
      out(rows.length ? rows.map((m) => `${m.id.slice(0, 8)}  ${m.status.padEnd(9)} ${m.kind.padEnd(11)} ${safe(m.claim).slice(0, 110)}`).join("\n") : "No memory yet. Add one with `dispatch memory note <text>`.");
      return 0;
    }
    if (sub === "note") {
      const text = rest.join(" ").trim(); if (!text) { err(`${sym.fail()} write what Claude should remember.`); return 2; }
      const r = await post(`${base}/note`, { text });
      out(`Proposed ${String(r.proposed)} memory item(s) from your note${Number(r.droppedSecret) ? ` (${String(r.droppedSecret)} dropped: looked like a secret)` : ""}. Review with \`dispatch memory list proposed\`, then \`dispatch memory approve <id>\`.`);
      return 0;
    }
    if (sub === "approve" || sub === "reject") {
      const m = await byPrefix(rest[0]); if (typeof m === "string") { err(`${sym.fail()} ${m}`); return 1; }
      out(`${sub === "approve" ? "Approving" : "Rejecting"}: ${safe(m.claim)}`);
      await post(`${base}/${m.id}/decision`, { decision: sub, ...(sub === "reject" ? { reason: rest.slice(1).join(" ") || "rejected by reviewer" } : {}) });
      out(sub === "approve" ? "Approved. Claude will now be shown it when it is relevant." : "Rejected.");
      return 0;
    }
    if (sub === "export") { out(JSON.stringify(await client.get(`${base}/export?projectId=${pid}`), null, 2)); return 0; }
    if (sub === "revise") {
      const m = await byPrefix(rest[0]); if (typeof m === "string") { err(`${sym.fail()} ${m}`); return 1; }
      const claim = rest.slice(1).join(" ").trim(); if (!claim) { err(`${sym.fail()} write the corrected text after the id.`); return 2; }
      const r = await post(`${base}/${m.id}/revise`, { claim }) as { memory?: { id: string } };
      out(`Proposed a replacement (${(r.memory?.id ?? "").slice(0, 8)}). Nothing changes until you run \`dispatch memory approve ${(r.memory?.id ?? "").slice(0, 8)}\`.`);
      return 0;
    }
    if (sub === "erase") {
      const m = await byPrefix(rest[0]); if (typeof m === "string") { err(`${sym.fail()} ${m}`); return 1; }
      await post(`${base}/${m.id}/erase`, { reason: rest.slice(1).join(" ") || "erased by the owner" });
      out("Erased (its text is removed, and so is the stored text of any context pack that used it).");
      return 0;
    }
    if (sub === "consent") {
      if (rest[0] !== "on" && rest[0] !== "off") { err(`${sym.fail()} say \`on\` or \`off\`.`); return 2; }
      await post(`${base}/consent`, { optedIn: rest[0] === "on", reason: `set from the dispatch terminal` });
      out(`Signals are now ${rest[0]} for this project.`);
      return 0;
    }
    err(`${sym.fail()} unknown memory command "${safe(sub).slice(0, 30)}".\n${MEMORY_HELP}`); return 2;
  } catch (e) {
    const msg = safe((e as Error).message);
    err(`${sym.fail()} ${msg}${/overlap|conflict/i.test(msg) ? "\n  This memory overlaps an approved one. Approving it must name what to erase: do that in the dashboard (Memory page), which shows the overlap." : ""}`); return 1;
  }
}
