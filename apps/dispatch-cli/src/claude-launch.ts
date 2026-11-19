import { join } from "node:path";

/** Environment variables Claude Code is started with: an ALLOWLIST. Nothing else from your shell (API keys, cloud/GitHub tokens, proxies) is passed on. */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|LANG|LC_[A-Z]+|TMPDIR|TZ|NO_COLOR|SSL_CERT_FILE)$/;
export function claudeEnv(src: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && ENV_ALLOW.test(k)) out[k] = v;
  return out;
}

export interface ClaudeLaunch { command: string; args: string[]; cwd: string; env: Record<string, string> }
/**
 * How Dispatch starts Claude Code for a job. `--restricted` removes Bash/code-running tools and web fetch, ignores your personal settings and confines
 * file tools to the working folders; Opus coordinates; the work folder is added; writes inside it are pre-approved, anything else (e.g. your project)
 * still asks YOU. The plugin supplies the planner command, the cheaper agents, the tool server and the write guard.
 */
export function buildClaudeLaunch(o: { claude: string; pluginDir: string; projectPath: string; workDir: string; env: Record<string, string | undefined> }): ClaudeLaunch {
  const rules = [`Edit(/${o.workDir}/**)`, `Write(/${o.workDir}/**)`].join(",");
  return {
    command: o.claude, cwd: o.projectPath, env: claudeEnv(o.env),
    args: ["/dispatch:work", "--restricted", "--model", "opus", "--plugin-dir", o.pluginDir, "--add-dir", o.workDir, "--allowedTools", rules],
  };
}
export const workDirOf = (home: string): string => join(home, "work");
