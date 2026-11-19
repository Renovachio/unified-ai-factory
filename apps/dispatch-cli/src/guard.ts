// `dispatch guard-write`: a Claude Code PreToolUse hook for file-writing tools. Allows a write only inside Dispatch's work folder (the throwaway copies);
// everything else is denied with exit code 2 and a reason Claude can read. Fail closed: unparseable input, a missing path or any error denies.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { safeRelPath, withinWrites, type ActiveScope } from "@factory/dispatch-core";

export type GuardResult = { allow: true } | { allow: false; reason: string };
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Resolve a path that may not exist yet through its nearest existing ancestor, so symlinks are judged by where they really point. */
function realish(p: string): string {
  let cur = resolve(p); const rest: string[] = [];
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) break; rest.unshift(basename(cur)); cur = up; }
  return join(realpathSync(cur), ...rest);
}
/** `protect`: also refuse protected paths inside the root (.git, .github, .env*, node_modules, keys): used when working in place in your real project. */
export function guardWrite(inputJson: string, workRoot: string, o: { protect?: boolean; scopeFile?: string } = {}): GuardResult {
  try {
    const i = JSON.parse(inputJson) as { agent_id?: unknown; tool_name?: unknown; tool_input?: Record<string, unknown>; cwd?: unknown };
    if (typeof i.tool_name !== "string" || !WRITE_TOOLS.has(i.tool_name)) return { allow: false, reason: "this guard only expects file-writing tools" };
    const target = i.tool_input?.file_path ?? i.tool_input?.notebook_path;
    if (typeof target !== "string" || target === "" || target.includes("\0")) return { allow: false, reason: "no file path given" };
    const abs = isAbsolute(target) ? target : resolve(typeof i.cwd === "string" ? i.cwd : process.cwd(), target);
    const root = realpathSync(workRoot); const real = realish(abs);
    if (real === root || !real.startsWith(root + sep)) return { allow: false, reason: `writes are only allowed inside ${root}; ${basename(real)} is outside it.` };
    if (o.protect && !safeRelPath(relative(root, real))) return { allow: false, reason: `${relative(root, real)} is a protected path (.git, .github, .env, keys or dependencies) and may not be changed by an agent.` };
    if (o.scopeFile) { // in-place run: writes are limited to what the accepted PLAN declared; no plan (or a stale one for another folder) means no writes
      let scope: ActiveScope; try { scope = JSON.parse(readFileSync(o.scopeFile, "utf8")) as ActiveScope; } catch { return { allow: false, reason: "there is no active Dispatch run for this folder; call dispatch_start_run with your plan first." }; }
      if (!Array.isArray(scope.writes) || scope.project !== root) return { allow: false, reason: "the active run does not belong to this folder." };
      const rel = relative(root, real); if (!withinWrites(rel, scope.writes)) return { allow: false, reason: `${rel} is not in the write scope of the accepted plan (${scope.writes.slice(0, 8).join(", ") || "none"}). Change the plan or leave it alone.` };
      // Lease: within one wave the first agent to write a file owns it; a DIFFERENT agent (Claude's hook input carries agent_id for subagents) is refused, so parallel agents cannot overwrite each other.
      const who = typeof i.agent_id === "string" && i.agent_id ? i.agent_id : "main"; const dir = join(`${o.scopeFile}.claims`, String(scope.wave ?? 0));
      mkdirSync(dir, { recursive: true, mode: 0o700 }); const claim = join(dir, createHash("sha256").update(rel).digest("hex").slice(0, 32));
      try { writeFileSync(claim, who, { flag: "wx", mode: 0o600 }); } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
        if (readFileSync(claim, "utf8") !== who) return { allow: false, reason: `${rel} is being written by another agent in this wave. Do not touch it; report to the coordinator, who can run it after the wave.` };
      }
    }
    return { allow: true };
  } catch { return { allow: false, reason: "could not verify the path; refusing" }; }
}
