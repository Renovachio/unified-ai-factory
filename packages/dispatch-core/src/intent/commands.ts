import type { Intent } from "./schema";
import { ID_RE, MAX_TEXT, PROJECT_REF_RE } from "./schema";

/** Versioned command table. Unknown slash commands are returned as `unknown`: they are never forwarded to a model or a shell. */
export const COMMAND_TABLE_VERSION = 1;
export interface CommandInfo { name: string; usage: string; summary: string; example?: string }
export const COMMANDS: readonly CommandInfo[] = [
  { name: "dispatch", usage: "/dispatch <request>", summary: "Create a new request in the active project", example: "/dispatch add dark mode to settings" },
  { name: "help", usage: "/help", summary: "List commands and examples" },
  { name: "new", usage: "/new <folder>", summary: "Add a local folder as a project (no GitHub needed)", example: "/new ~/code/notes" },
  { name: "projects", usage: "/projects", summary: "List projects in your authorized scope" },
  { name: "project", usage: "/project use <id>", summary: "Set the active project (/project add <folder> adds a local folder)" },
  { name: "jobs", usage: "/jobs", summary: "List active, queued and recent jobs" },
  { name: "status", usage: "/status", summary: "Factory health, capability readiness and job summary" },
  { name: "models", usage: "/models", summary: "Available vs qualified vs authorized model runtimes" },
  { name: "skills", usage: "/skills", summary: "Approved registry capabilities (proposals labelled separately)" },
  { name: "agents", usage: "/agents", summary: "Registered agents and their permitted roles" },
  { name: "approvals", usage: "/approvals", summary: "Human action inbox" },
  { name: "runs", usage: "/runs", summary: "Agent runs waiting for your review, and recent ones" },
  { name: "review", usage: "/review [run]", summary: "Show what an agent run changed (a diff), without applying anything" },
  { name: "accept", usage: "/accept [run]", summary: "Apply a reviewed run to your folder (you type a word to confirm)" },
  { name: "discard", usage: "/discard [run]", summary: "Reject a run and delete its work copy" },
  { name: "approve", usage: "/approve <id>", summary: "Review an approval, then confirm it in a separate step" },
  { name: "pause", usage: "/pause <jobId>", summary: "Request a safe pause" },
  { name: "resume", usage: "/resume <jobId>", summary: "Resume a paused job" },
  { name: "cancel", usage: "/cancel <jobId>", summary: "Cancel one job (confirmation required)" },
  { name: "logs", usage: "/logs <jobId>", summary: "Show job events (redacted)" },
  { name: "dashboard", usage: "/dashboard", summary: "Open the dashboard in your browser" },
  { name: "context", usage: "/context [clear]", summary: "Show or clear the scoped conversational context" },
  { name: "exit", usage: "/exit", summary: "Detach; the factory keeps running" },
  { name: "shutdown", usage: "/shutdown", summary: "Stop the factory after reviewing active jobs" },
];

export type Parsed =
  | { kind: "intent"; intent: Intent; viaCommand: string }
  | { kind: "local"; command: "help" | "exit" | "shutdown" | "dashboard" | "context" | "context-clear" | "projects" | "models" | "skills" | "agents" | "approvals" | "logs"; arg?: string }
  | { kind: "request"; text: string }
  | { kind: "local-project"; path: string }
  | { kind: "run"; action: "list" | "review" | "accept" | "discard"; ref?: string }
  | { kind: "usage"; command: string; usage: string }
  | { kind: "unknown"; input: string; suggestions: string[] }
  | { kind: "text"; text: string };

function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] ?? 0;
}
export const suggest = (name: string): string[] => COMMANDS.map((c) => ({ c, d: lev(name, c.name) })).filter((x) => x.d <= 3 || x.c.name.startsWith(name)).sort((a, b) => a.d - b.d).slice(0, 3).map((x) => `/${x.c.name}`);

/** Folder arguments may be typed shell-style: surrounding quotes, or backslash-escaped characters (what tab completion and drag-and-drop produce). No expansion is performed. */
export function unescapePath(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t.replace(/\\(.)/g, "$1");
}
export function parseLine(line: string): Parsed {
  const s = line.trim(); if (s === "") return { kind: "text", text: "" };
  if (!s.startsWith("/")) return { kind: "text", text: s };
  const [head = "", ...rest] = s.slice(1).split(/\s+/); const name = head.toLowerCase(); const arg = rest.join(" ").trim();
  const info = COMMANDS.find((c) => c.name === name);
  if (!info) return { kind: "unknown", input: s.slice(0, 80), suggestions: suggest(name) };
  const usage = (): Parsed => ({ kind: "usage", command: name, usage: info.usage });
  const id = (): string | null => (ID_RE.test(arg) ? arg : null);
  switch (name) {
    case "help": case "exit": case "shutdown": case "dashboard": case "projects": case "models": case "skills": case "agents": case "approvals":
      return arg === "" ? { kind: "local", command: name } : usage();
    case "runs": return arg === "" ? { kind: "run", action: "list" } : usage();
    case "review": case "accept": case "discard": return arg === "" ? { kind: "run", action: name } : /^[0-9a-f]{6,36}(-[0-9a-f-]*)?$/i.test(arg) ? { kind: "run", action: name, ref: arg.toLowerCase() } : usage(); // no id = the only run awaiting approval
    case "jobs": return arg === "" ? { kind: "intent", intent: { type: "job.list" }, viaCommand: name } : usage();
    case "status": return arg === "" ? { kind: "intent", intent: { type: "factory.status" }, viaCommand: name } : usage();
    case "dispatch": return arg === "" || arg.length > MAX_TEXT ? usage() : { kind: "request", text: arg };
    case "new": return arg === "" || arg.length > 1024 ? usage() : { kind: "local-project", path: unescapePath(arg) };
    case "project": { const add = /^add\s+(.+)$/i.exec(arg)?.[1]?.trim(); if (add && add.length <= 1024) return { kind: "local-project", path: unescapePath(add) }; const pid = /^use\s+(\S+)$/i.exec(arg)?.[1]; return pid && (ID_RE.test(pid) || PROJECT_REF_RE.test(pid)) ? { kind: "intent", intent: { type: "project.select", projectId: pid }, viaCommand: name } : usage(); }
    case "pause": case "resume": case "cancel": return id() ? { kind: "intent", intent: { type: `job.${name}`, jobId: arg }, viaCommand: name } : usage();
    case "approve": return id() ? { kind: "intent", intent: { type: "approval.review", approvalId: arg }, viaCommand: name } : usage();
    case "logs": return id() ? { kind: "local", command: "logs", arg } : usage();
    case "context": return arg === "" ? { kind: "local", command: "context" } : arg.toLowerCase() === "clear" ? { kind: "local", command: "context-clear" } : usage();
  }
  return usage();
}

/** Subcommands of the shell program. `dispatch <words>` is a request, so a one-word typo of a subcommand must be refused rather than become a job. */
export const SHELL_SUBCOMMANDS = ["start", "status", "doctor", "stop", "migrate", "help", "work", "mcp", "code", "changes", "undo", "plugin"] as const;
export function shellRequestText(args: string[]): { ok: true; text: string } | { ok: false; error: string } {
  const text = args.join(" ").trim();
  if (text === "") return { ok: false, error: "empty request" };
  if (text.length > MAX_TEXT) return { ok: false, error: `request is longer than ${MAX_TEXT} characters` };
  if (args.length === 1) { const w = text.toLowerCase(); const near = [...SHELL_SUBCOMMANDS].map((c) => ({ c, d: lev(w, c) })).filter((x) => x.d <= 2).sort((a, b) => a.d - b.d)[0]?.c; if (near) return { ok: false, error: `“${text.slice(0, 30)}” looks like a mistyped command. Did you mean \`dispatch ${near}\`? (To make it a request, write a full sentence.)` }; }
  return { ok: true, text };
}
