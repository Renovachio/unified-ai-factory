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
/** Settings passed with --settings (still honoured in restricted mode): a PreToolUse hook on every file-writing tool, for the WHOLE session including subagents. */
export function guardSettings(guardCommand: string): string {
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: guardCommand }] }] } });
}
/** The ONLY tool server Claude gets: this binary's `mcp`. With --strict-mcp-config your claude.ai connectors (Drive, Docs, Atlassian…) and other servers are not loaded. */
export function mcpConfig(cmd: string, args: string[]): string { return JSON.stringify({ mcpServers: { dispatch: { command: cmd, args } } }); }
/** Built-in tools available to the session and every subagent: read/search, write/edit, and the subagent tool. No shell, web search, schedulers, notifiers or worktrees. */
export const AGENT_TOOLS = "Task,Read,Glob,Grep,Write,Edit";
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
export function buildClaudeLaunch(o: { claude: string; pluginDir: string; projectPath: string; workDir: string; env: Record<string, string | undefined>; guardCommand: string; mcpCommand: { cmd: string; args: string[] } }): ClaudeLaunch {
  const rules = [`Edit(/${o.workDir}/**)`, `Write(/${o.workDir}/**)`].join(",");
  return {
    command: o.claude, cwd: o.projectPath, env: claudeEnv(o.env),
    args: ["/dispatch:work", "--restricted", "--model", "opus", "--plugin-dir", o.pluginDir, "--add-dir", o.workDir, "--allowedTools", rules, "--settings", guardSettings(o.guardCommand), "--tools", AGENT_TOOLS, "--mcp-config", mcpConfig(o.mcpCommand.cmd, o.mcpCommand.args), "--strict-mcp-config"],
  };
}
export const workDirOf = (home: string): string => join(home, "work");
