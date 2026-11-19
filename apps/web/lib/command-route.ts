// The dashboard command box is a NAVIGATOR. It understands the same slash commands and deterministic phrases as the terminal, but it never mutates anything:
// state changes happen through explicit, separately confirmed controls on the pages themselves.
import { deterministic, parseLine } from "@factory/dispatch-core/src/intent/index";
import type { Intent } from "@factory/dispatch-core/src/intent/index";

export type Route = { to: string } | { notice: string };

const MUTATING = new Set(["job.pause", "job.resume", "job.cancel", "job.create", "project.create", "approval.review"]);
function routeIntent(i: Intent): Route {
  if (MUTATING.has(i.type)) {
    const where = i.type === "approval.review" ? "/approvals" : "jobId" in i ? `/jobs/${encodeURIComponent(i.jobId)}` : "/projects";
    return { notice: `“${i.type}” changes state, so it is not run from this box. Open ${where} and use the confirmed control there (or the terminal).` };
  }
  switch (i.type) {
    case "factory.status": return { to: "/" };
    case "job.list": return { to: i.projectId ? `/projects/${encodeURIComponent(i.projectId)}` : "/jobs" };
    case "project.select": return { to: `/projects/${encodeURIComponent(i.projectId)}` };
    case "capability.list": return { to: i.category === "models" ? "/models" : "/skills" };
    case "clarification.required": return { notice: i.question };
    default: return { notice: "Not understood." };
  }
}

export function routeCommand(text: string): Route {
  const p = parseLine(text);
  switch (p.kind) {
    case "text": {
      if (p.text === "") return { notice: "Type a command like /jobs, or a phrase like “show my jobs”." };
      const d = deterministic(p.text);
      if (d && "ambiguous" in d) return { notice: d.ambiguous };
      return d ? routeIntent(d) : { notice: "I only understand a fixed set of phrases here (no model is qualified). Try /help." };
    }
    case "request": return { notice: "Creating a request changes state, so it is not run from this box. Use `dispatch <request>` or /dispatch <request> in the terminal." };
    case "unknown": return { notice: `Unknown command. ${p.suggestions.length ? `Did you mean ${p.suggestions.join(", ")}? ` : ""}Try /help.` };
    case "usage": return { notice: `Usage: ${p.usage}` };
    case "intent": return routeIntent(p.intent);
    case "local": {
      const m: Record<string, Route> = { help: { to: "/help" }, projects: { to: "/projects" }, models: { to: "/models" }, skills: { to: "/skills" }, agents: { to: "/skills" }, approvals: { to: "/approvals" }, dashboard: { to: "/" }, context: { to: "/" }, "context-clear": { to: "/" }, exit: { notice: "/exit and /shutdown control the terminal session and the factory lifecycle; they are not available in the browser." }, shutdown: { notice: "/exit and /shutdown control the terminal session and the factory lifecycle; they are not available in the browser." }, logs: { to: `/logs?job=${encodeURIComponent(p.arg ?? "")}` } };
      return m[p.command] ?? { notice: "Not available here." };
    }
  }
}
