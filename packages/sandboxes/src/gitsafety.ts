import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitSanitizeReport {
  removedHooks: string[];
  droppedConfigKeys: string[];
}

const SAFE_CORE = new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks"]);

interface Entry { section: string; sub?: string; key: string; value: string }

function parse(text: string): Entry[] {
  const out: Entry[] = [];
  let section = "";
  let sub: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const h = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/.exec(line);
    if (h) {
      section = (h[1] as string).toLowerCase();
      sub = h[2];
      if (h[3]) {
        const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(h[3]);
        if (kv) out.push({ section, ...(sub !== undefined ? { sub } : {}), key: (kv[1] as string).toLowerCase(), value: kv[2] ?? "true" });
      }
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv) out.push({ section, ...(sub !== undefined ? { sub } : {}), key: (kv[1] as string).toLowerCase(), value: kv[2] ?? "true" });
  }
  return out;
}

const keep = (e: Entry): boolean => {
  if (e.section === "core") return SAFE_CORE.has(e.key);
  if (e.section === "branch") return e.key === "remote" || e.key === "merge";
  if (e.section === "remote") return e.key === "fetch" || (e.key === "url" && /^https:\/\/[^\s]+$/.test(e.value));
  return false;
};

/**
 * Rewrites .git/config as an allowlist (anything that can execute code or redirect network/credentials is dropped),
 * removes all hooks, and refuses a `.git` file pointing outside the workspace.
 */
export function sanitizeGitDir(repoDir: string): GitSanitizeReport {
  const gitPath = join(repoDir, ".git");
  const report: GitSanitizeReport = { removedHooks: [], droppedConfigKeys: [] };
  if (!existsSync(gitPath)) return report;
  const st = lstatSync(gitPath);
  if (!st.isDirectory()) throw new Error(".git must be a real directory inside the workspace (gitfile/symlink indirection refused)");
  const hooks = join(gitPath, "hooks");
  if (existsSync(hooks)) {
    for (const f of readdirSync(hooks)) {
      rmSync(join(hooks, f), { recursive: true, force: true });
      report.removedHooks.push(f);
    }
  }
  for (const extra of ["info/attributes", "info/exclude", "modules"]) rmSync(join(gitPath, extra), { recursive: true, force: true });
  const cfgPath = join(gitPath, "config");
  const entries = existsSync(cfgPath) ? parse(readFileSync(cfgPath, "utf8")) : [];
  const out: string[] = [];
  const sections = new Map<string, string[]>();
  for (const e of entries) {
    const label = `${e.section}${e.sub !== undefined ? "." + e.sub : ""}.${e.key}`;
    if (!keep(e)) {
      report.droppedConfigKeys.push(label);
      continue;
    }
    const header = e.sub !== undefined ? `[${e.section} "${e.sub.replace(/["\\]/g, "")}"]` : `[${e.section}]`;
    const lines = sections.get(header) ?? [];
    lines.push(`\t${e.key} = ${e.value}`);
    sections.set(header, lines);
  }
  for (const [h, lines] of sections) out.push(h, ...lines);
  out.push("[core]", "\thooksPath = /dev/null", "\tfsmonitor = false", '[protocol "ext"]', "\tallow = never", '[protocol "file"]', "\tallow = never");
  writeFileSync(cfgPath, out.join("\n") + "\n");
  return report;
}

/** Environment that neutralises system/global git configuration and prompts. */
export const SAFE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  GIT_ALLOW_PROTOCOL: "https",
  GIT_OPTIONAL_LOCKS: "0",
};
