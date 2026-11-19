// Local, read-only evidence for AGT-002/003: (1) with the SHIPPED config the adapters are blocked and the CLI is never executed;
// (2) the installed CLI's version is read (a harmless `--version`, no inference, no login state used) so an operator can decide what to allowlist.
// Usage: bun scripts/live-cli-probe.ts <claude-code|codex> <absolute path to the CLI>
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectBackend, buildSandboxEnv, createWorkspace, runSandboxed, teardownWorkspace } from "../packages/sandboxes/src/index";
import { ClaudeCodeSubscriptionCliAdapter, InferenceSourcePolicy, loadPolicyConfig } from "../packages/runtimes/src/index";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const [id = "claude-code", exe = ""] = process.argv.slice(2);
const root = join(import.meta.dir, "..");
const wsRoot = mkdtempSync(join(tmpdir(), "live-probe-"));
const report: Record<string, unknown> = { adapter: id, executable: exe.replace(process.env.HOME ?? "\u0000", "~"), installed: existsSync(exe), at: new Date().toISOString() };

const adapter = new ClaudeCodeSubscriptionCliAdapter({
  executable: exe, policy: new InferenceSourcePolicy(loadPolicyConfig(join(root, "config"))), env: { PATH: process.env.PATH ?? "" },
  backend: detectBackend(), workspaceRoot: wsRoot, loadContext: async () => "{}",
});
report.shippedConfigProbe = id === "claude-code" ? await adapter.probe() : "n/a (codex adapter probe is covered in tests)";

if (existsSync(exe)) {
  const ws = createWorkspace(wsRoot, "ver");
  const r = await runSandboxed({ backend: detectBackend(), workspaceRoot: ws.root, cwd: ws.repoDir, command: exe, args: ["--version"], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 20_000, readOnlyPaths: [dirname(realpathSync(exe))] });
  report.versionCommand = { exitCode: r.exitCode, stdout: r.stdout.trim().slice(0, 200), stderr: r.stderr.trim().slice(0, 200) };
  teardownWorkspace(wsRoot, ws);
}
mkdirSync(join(root, "evidence", id === "claude-code" ? "AGT-002" : "AGT-003"), { recursive: true });
writeFileSync(join(root, "evidence", id === "claude-code" ? "AGT-002" : "AGT-003", "live-probe.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
