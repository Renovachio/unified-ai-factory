import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, interpret, parseLine, type NlInterpreter } from "@factory/dispatch-core";
import { DispatchClient } from "@factory/dispatch-client";
import { color, safe, sym } from "../render";
import type { Ctx } from "../launcher/context";
import { Executor, renderSummary, resolveJob, type Io, type Outcome } from "./executor";
import { Session } from "./session";

export const LOCAL_ACTOR = "dispatch-local-owner";
export function makeClient(c: Ctx): DispatchClient {
  const token = readFileSync(c.paths.token, "utf8").trim();
  return new DispatchClient({ baseUrl: `http://${c.cfg.host}:${c.cfg.ports.api}`, headers: () => ({ authorization: `Bearer ${token}` }), timeoutMs: 8000 });
}

export const helpText = (): string => ["Commands:", ...COMMANDS.map((c) => `  ${c.usage.padEnd(22)} ${c.summary}`), "", "Or just type what you want, e.g. “show my jobs”, “list models”, “status”. Anything Dispatch can't match deterministically is refused unless a qualified, authorized model interpreter is configured (none is by default).", "Anything starting with “/” is a command and is never sent to a model or a shell."].join("\n");

export interface ReplHooks { openDashboard(): Promise<string>; shutdown(io: Io): Promise<{ stopped: boolean; message: string }>; interpreter?: NlInterpreter }
export type ReplResult = "detached" | "shutdown";

/** Line source that serves both the main prompt and confirmation questions from ONE reader (works for TTY and piped stdin). EOF = detach. */
export class Lines {
  private q: string[] = []; private waiters: Array<(s: string | null) => void> = []; private closed = false;
  constructor(src: NodeJS.ReadableStream, private readonly out: NodeJS.WritableStream, private completer?: (l: string) => [string[], string]) {
    const rl = createInterface({ input: src, ...(src === process.stdin && process.stdin.isTTY ? { output: out, completer } : {}), terminal: src === process.stdin && !!process.stdin.isTTY, historySize: 100 });
    this.rl = rl; rl.on("line", (l) => { const w = this.waiters.shift(); if (w) w(l); else this.q.push(l); }); rl.on("close", () => { this.closed = true; for (const w of this.waiters.splice(0)) w(null); });
  }
  private rl;
  next(prompt: string): Promise<string | null> {
    const v = this.q.shift(); if (v !== undefined) return Promise.resolve(v);
    if (this.closed) return Promise.resolve(null); // end of input: the caller detaches
    this.rl.setPrompt(prompt); this.rl.prompt();
    return new Promise((res) => this.waiters.push(res));
  }
  close() { this.rl.close(); }
}

export async function runRepl(c: Ctx, hooks: ReplHooks, opts: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; client?: DispatchClient } = {}): Promise<ReplResult> {
  const output = opts.output ?? process.stdout; const client = opts.client ?? makeClient(c);
  const sessionFile = join(c.paths.home, "sessions", `${process.ppid}-${process.env.TERM_SESSION_ID ?? "tty"}.json`.replace(/[^A-Za-z0-9._-]/g, "_"));
  const session = Session.open(sessionFile, LOCAL_ACTOR);
  const completer = (l: string): [string[], string] => { const all = COMMANDS.map((x) => `/${x.name}`); return [l.startsWith("/") ? all.filter((x) => x.startsWith(l)) : [], l]; };
  const lines = new Lines(opts.input ?? process.stdin, output, completer);
  // Sanitise per line: control characters (ESC sequences etc.) are stripped, but our own line breaks survive.
  const say = (s: string) => output.write(`${s.split("\n").map((l) => safe(l)).join("\n")}\n`);
  const io: Io = { out: say, ask: async (p) => (await lines.next(p)) ?? "" };
  const ex = new Executor(client, session, io);
  const show = (o: Outcome) => say(o.status === "completed" ? o.message : `${o.status === "failed" ? sym.fail() : sym.warn()} ${o.message}`);
  say(color.dim("Type /help for commands. /exit leaves the factory running; /shutdown stops it."));
  for (;;) {
    const raw = await lines.next(session.data.activeProjectName ? `dispatch [${safe(session.data.activeProjectName).slice(0, 24)}]> ` : "dispatch> ");
    if (raw === null) { say("\nDetached; the factory keeps running."); lines.close(); return "detached"; }
    const p = parseLine(raw);
    switch (p.kind) {
      case "text": {
        if (p.text === "") break;
        const r = await interpret(p.text, { activeProjectId: session.projectId }, hooks.interpreter);
        if (r.via === "none") { say(r.reason === "ambiguous" ? (r.question ?? "Could you be more specific?") : r.reason === "invalid-output" ? "I couldn't turn that into a safe action, so I did nothing. Try a /command." : "I only understand a fixed set of phrases without a configured model interpreter (none is qualified here). Try /help."); break; }
        show(await ex.execute(r.intent)); break;
      }
      case "unknown": say(`Unknown command ${safe(p.input.split(" ")[0] ?? "")}.${p.suggestions.length ? ` Did you mean ${p.suggestions.join(", ")}?` : ""} Try /help.`); break;
      case "usage": say(`Usage: ${p.usage}`); break;
      case "intent": show(await ex.execute(p.intent)); break;
      case "local": {
        const cmd = p.command;
        if (cmd === "help") say(helpText());
        else if (cmd === "exit") { say("Detached; the factory keeps running."); lines.close(); return "detached"; }
        else if (cmd === "shutdown") { const r = await hooks.shutdown(io); say(r.message); if (r.stopped) { lines.close(); return "shutdown"; } }
        else if (cmd === "dashboard") say(await hooks.openDashboard());
        else if (cmd === "context") say([`Session ${session.id.slice(0, 8)}  (expires ${new Date(session.data.expiresAt).toLocaleString()})`, `Active project: ${session.data.activeProjectName ?? "none"}`, `Remembered references: ${session.data.refs.length ? session.data.refs.slice(0, 10).map((r) => `${r.kind}:${r.id.slice(0, 8)}`).join(", ") : "none"}`].join("\n"));
        else if (cmd === "context-clear") { session.clear(); say("Context cleared (project data is unchanged)."); }
        else if (cmd === "projects") { try { const r = await client.get<{ items: Array<{ id: string; name: string; jobs: { active: number; waitingOnHuman: number } }> }>("/api/v2/dispatch/projects"); say(r.items.length ? r.items.map((x) => `${x.id.slice(0, 8)}  ${x.name.padEnd(30)} ${x.jobs.active} active · ${x.jobs.waitingOnHuman} waiting${x.id === session.projectId ? "   ← active" : ""}`).join("\n") : "No projects yet. Link a repository from the dashboard."); } catch (e) { say(`${sym.fail()} ${(e as Error).message}`); } }
        else if (cmd === "models" || cmd === "skills" || cmd === "agents") show(await ex.execute({ type: "capability.list", category: cmd }));
        else if (cmd === "approvals") { try { const r = await client.get<{ items: Array<Record<string, unknown>> }>("/api/v2/dispatch/approvals"); say(r.items.length ? r.items.map((a) => `${String(a.id).slice(0, 8)}  ${String(a.type).padEnd(20)} ${a.type === "job-decision" ? safe(String((a.title as { text: string }).text)).slice(0, 50) : `${String(a.operation)} ${String(a.capability)}`}`).join("\n") + "\n(use /approve <id>)" : "Nothing needs your attention."); } catch (e) { say(`${sym.fail()} ${(e as Error).message}`); } }
        else if (cmd === "logs") await showLogs(client, p.arg ?? "", say, lines);
        break;
      }
    }
  }
}

async function showLogs(client: DispatchClient, ref: string, say: (s: string) => void, lines: Lines): Promise<void> {
  try {
    const snap = await client.snapshot(); const r = resolveJob(snap.jobs, ref); if (!r.ok) { say(r.message); return; }
    const id = r.item.id; const page = await client.events(0, 500); const mine = page.events.filter((e) => e.jobId === id);
    say(mine.length ? mine.map((e) => `${e.at}  #${e.sequence}  ${e.type}`).join("\n") : "No events yet."); 
    say(color.dim("Following live; press Enter to stop."));
    const ac = new AbortController(); const stop = lines.next("").then(() => ac.abort());
    try { for await (const e of client.stream(page.cursor, ac.signal)) if (e.jobId === id) say(`${e.at}  #${e.sequence}  ${e.type}`); } catch { /* aborted or disconnected */ }
    await stop;
  } catch (e) { say(`${sym.fail()} ${(e as Error).message}`); }
}
export { renderSummary };
