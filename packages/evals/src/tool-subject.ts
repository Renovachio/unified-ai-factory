import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSandboxEnv, createWorkspace, runSandboxed, teardownWorkspace, type SandboxBackend } from "@factory/sandboxes";
import { InferencePolicyHolder, runToolLoop, ToolHost, toolsetDigest } from "./tool-deps";
import type { BuilderTask } from "./fixtures";
import type { EvalSubject, Timed } from "./subjects";

export interface ToolLoopBuilderOptions {
  id: string;
  endpoint: string;
  modelId: string;
  policy: InferencePolicyHolder;
  backend: SandboxBackend;
  workspaceRoot: string;
  /** Delegate for review/risk (the builder qualification only measures building). */
  other: EvalSubject;
  bunPath: string;
  extraBody?: Record<string, unknown>;
  maxIterations?: number;
  maxWallMs?: number;
}

/**
 * Builder subject that exercises the REAL tool loop (ACT-06: builder qualification must include real tool use).
 * The model sees the task, a stub file and a PUBLIC smoke check only; the hidden acceptance tests stay out of its reach and are run afterwards by the benchmark.
 */
export class ToolLoopBuilderSubject implements EvalSubject {
  readonly id: string;
  readonly toolsetDigest = toolsetDigest(["smoke"]);
  constructor(private readonly o: ToolLoopBuilderOptions) { this.id = o.id; }
  review: EvalSubject["review"] = (t) => this.o.other.review(t);
  riskHint: EvalSubject["riskHint"] = (t) => this.o.other.riskHint(t);

  async build(task: BuilderTask): Promise<Timed<{ content: string }>> {
    const started = Date.now();
    const ws = createWorkspace(this.o.workspaceRoot, `b${task.id}`);
    try {
      const fn = /function\s+(\w+)/.exec(task.signature)?.[1] ?? "main";
      mkdirSync(join(ws.repoDir, "src"), { recursive: true });
      writeFileSync(join(ws.repoDir, task.file), `${task.signature} {\n  throw new Error("not implemented");\n}\n`);
      writeFileSync(join(ws.repoDir, "smoke.ts"), `import * as m from "./${task.file.replace(/\.ts$/, "")}";\nconst f = (m as Record<string, unknown>)["${fn}"];\nif (typeof f !== "function") { console.log("FAIL: ${fn} is not exported as a function"); process.exit(1); }\ntry { (f as (...a: never[]) => unknown)(); console.log("smoke ok (no-arg call returned)"); } catch (e) { console.log("smoke: no-arg call threw: " + (e as Error).message); }\nconsole.log("module loads and exports ${fn}; hidden acceptance tests are not available to you.");\n`);
      const env = buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }, { PATH: "/usr/bin:/bin" });
      const smoke = async () => { const r = await runSandboxed({ backend: this.o.backend, workspaceRoot: ws.root, cwd: ws.repoDir, command: this.o.bunPath, args: ["smoke.ts"], env, timeoutMs: 20_000, readOnlyPaths: [this.o.bunPath.replace(/\/[^/]*$/, "")] }); return { exitCode: r.exitCode, output: r.stdout + r.stderr }; };
      const host = new ToolHost({ repoDir: ws.repoDir, checks: { smoke } });
      const res = await runToolLoop({
        endpoint: this.o.endpoint, policy: this.o.policy, env: { PATH: process.env.PATH ?? "" }, modelId: this.o.modelId, host, maxIterations: this.o.maxIterations ?? 10, maxWallMs: this.o.maxWallMs ?? 240_000,
        ...(this.o.extraBody ? { extraBody: this.o.extraBody } : {}),
        system: "You are a careful software engineer. Use the tools to read and edit files. Implement the function in the given file exactly as specified, run the `smoke` check, then reply with a one-line summary and no tool call.",
        task: `Implement ${task.title}.\n\nRequirement: ${task.description}\n\nFile: ${task.file}\nRequired signature: ${task.signature}`,
      });
      const content = readFileSync(join(ws.repoDir, task.file), "utf8");
      const changed = res.changedFiles.includes(task.file);
      return { value: changed ? { content } : null, ...(changed ? {} : { error: `loop ${res.status}: file not changed` }), timing: { ms: Date.now() - started } };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : "error", timing: { ms: Date.now() - started } };
    } finally { teardownWorkspace(this.o.workspaceRoot, ws); }
  }
}
