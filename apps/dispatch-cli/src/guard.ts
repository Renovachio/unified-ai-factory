// `dispatch guard-write`: a Claude Code PreToolUse hook for file-writing tools. Allows a write only inside Dispatch's work folder (the throwaway copies);
// everything else is denied with exit code 2 and a reason Claude can read. Fail closed: unparseable input, a missing path or any error denies.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type GuardResult = { allow: true } | { allow: false; reason: string };
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Resolve a path that may not exist yet through its nearest existing ancestor, so symlinks are judged by where they really point. */
function realish(p: string): string {
  let cur = resolve(p); const rest: string[] = [];
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) break; rest.unshift(basename(cur)); cur = up; }
  return join(realpathSync(cur), ...rest);
}
export function guardWrite(inputJson: string, workRoot: string): GuardResult {
  try {
    const i = JSON.parse(inputJson) as { tool_name?: unknown; tool_input?: Record<string, unknown>; cwd?: unknown };
    if (typeof i.tool_name !== "string" || !WRITE_TOOLS.has(i.tool_name)) return { allow: false, reason: "this guard only expects file-writing tools" };
    const target = i.tool_input?.file_path ?? i.tool_input?.notebook_path;
    if (typeof target !== "string" || target === "" || target.includes("\0")) return { allow: false, reason: "no file path given" };
    const abs = isAbsolute(target) ? target : resolve(typeof i.cwd === "string" ? i.cwd : process.cwd(), target);
    const root = realpathSync(workRoot); const real = realish(abs);
    if (real === root || !real.startsWith(root + sep)) return { allow: false, reason: `writes are only allowed inside the Dispatch work copy (${root}); ${basename(real)} is outside it. Use the workspace path returned by dispatch_start_run.` };
    return { allow: true };
  } catch { return { allow: false, reason: "could not verify the path; refusing" }; }
}
