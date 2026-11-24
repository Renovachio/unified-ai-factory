import { GATE_STEP_IDS, normalizeRepoPath, protectedPathHits, type RiskLevel, maxRisk } from "@factory/domain";
import { SchemaRegistry } from "@factory/runtimes";
import { z } from "zod";

const AcId = z.string().regex(/^AC-\d{1,3}$/);
const TaskId = z.string().regex(/^T-\d{1,3}$/);
const CheckId = z.string().regex(/^C-\d{1,3}$/);
const RepoPath = z.string().min(1).max(300).refine((p) => normalizeRepoPath(p) !== null, "must be a repo-relative path without traversal");

export const RequirementsSchema = z.strictObject({
  acceptance_criteria: z.array(z.strictObject({
    id: AcId, text: z.string().min(1).max(1000), observable: z.string().min(1).max(500),
  })).min(1).max(40),
  assumptions: z.array(z.string().max(500)).max(30).default([]),
  out_of_scope: z.array(z.string().max(500)).max(30).default([]),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

export const DesignSchema = z.strictObject({
  approach: z.string().min(1).max(4000),
  files_affected: z.array(z.strictObject({ path: RepoPath, change: z.enum(["add", "modify", "delete"]) })).min(1).max(200),
  threat_notes: z.array(z.string().max(500)).max(30).default([]),
  risks: z.array(z.string().max(500)).max(30).default([]),
});
export type Design = z.infer<typeof DesignSchema>;

export const SpecSchema = z.strictObject({
  tasks: z.array(z.strictObject({
    id: TaskId, title: z.string().min(1).max(300), files: z.array(RepoPath).max(100), covers: z.array(AcId).min(1), checks: z.array(CheckId).min(1),
  })).min(1).max(100),
  checks: z.array(z.strictObject({
    id: CheckId, description: z.string().min(1).max(500), covers: z.array(AcId).min(1),
    /** Executable binding: a deterministic gate step, or a test file created/changed by a task. */
    runs: z.union([z.strictObject({ gate_step: z.enum(GATE_STEP_IDS) }), z.strictObject({ test_file: RepoPath })]),
  })).min(1).max(200),
  test_strategy: z.string().max(4000).default(""),
});
export type Spec = z.infer<typeof SpecSchema>;

export function registerSpecSchemas(registry: SchemaRegistry): SchemaRegistry {
  return registry
    .register("schema://analyst", { schema: RequirementsSchema, hint: `{"acceptance_criteria":[{"id":"AC-1","text":"...","observable":"how a tester observes it"}],"assumptions":[],"out_of_scope":[]} — every AC must be observable and testable; preserve intake AC ids` })
    .register("schema://architect", { schema: DesignSchema, hint: `{"approach":"...","files_affected":[{"path":"src/x.ts","change":"add|modify|delete"}],"threat_notes":[],"risks":[]} — repo-relative paths only` })
    .register("schema://spec", { schema: SpecSchema, hint: `{"tasks":[{"id":"T-1","title":"...","files":["src/x.ts"],"covers":["AC-1"],"checks":["C-1"]}],"checks":[{"id":"C-1","description":"...","covers":["AC-1"],"runs":{"gate_step":"unit"}|{"test_file":"tests/x.test.ts"}}],"test_strategy":"..."} — every AC needs a task and an executable check` });
}

export type TraceCode =
  | "ac-uncovered-by-task" | "ac-uncovered-by-check" | "ac-dropped" | "unknown-ac" | "unknown-check" | "check-not-executable"
  | "file-outside-design" | "duplicate-id" | "task-without-matching-check" | "check-covers-mismatch";

export interface TraceError { code: TraceCode; id: string; message: string }
export interface TraceRow { ac: string; text: string; tasks: string[]; checks: string[] }
export interface TraceResult {
  ok: boolean;
  errors: TraceError[];
  matrix: TraceRow[];
  protectedPaths: Array<{ path: string; level: "HIGH" | "CRITICAL" }>;
  riskFloor: RiskLevel;
}

/**
 * Enforces acceptance-criteria traceability: every AC is implemented by >= 1 task AND verified by >= 1 EXECUTABLE check
 * (a known gate step, or a test file that some task creates), nothing dangles, no intake AC is dropped, no task touches files
 * the architect did not declare, and protected-path touches raise the risk floor.
 */
export function validateTraceability(i: { intakeAcIds?: readonly string[]; requirements: Requirements; design: Design; spec: Spec }): TraceResult {
  const errors: TraceError[] = [];
  const err = (code: TraceCode, id: string, message: string) => errors.push({ code, id, message });
  const acs = new Map(i.requirements.acceptance_criteria.map((a) => [a.id, a]));
  const dup = (ids: string[], kind: string) => { const seen = new Set<string>(); for (const id of ids) { if (seen.has(id)) err("duplicate-id", id, `duplicate ${kind} id`); seen.add(id); } };
  dup(i.requirements.acceptance_criteria.map((a) => a.id), "acceptance criterion");
  dup(i.spec.tasks.map((t) => t.id), "task");
  dup(i.spec.checks.map((c) => c.id), "check");

  for (const id of i.intakeAcIds ?? []) if (!acs.has(id)) err("ac-dropped", id, `intake criterion ${id} is missing from the requirements`);

  const checks = new Map(i.spec.checks.map((c) => [c.id, c]));
  const designPaths = new Set(i.design.files_affected.map((f) => normalizeRepoPath(f.path)));
  const taskFiles = new Set(i.spec.tasks.flatMap((t) => t.files.map((f) => normalizeRepoPath(f))));

  for (const t of i.spec.tasks) {
    for (const ac of t.covers) if (!acs.has(ac)) err("unknown-ac", t.id, `task ${t.id} covers unknown ${ac}`);
    for (const c of t.checks) if (!checks.has(c)) err("unknown-check", t.id, `task ${t.id} references unknown check ${c}`);
    for (const f of t.files) if (!designPaths.has(normalizeRepoPath(f))) err("file-outside-design", t.id, `task ${t.id} touches ${f}, which the design does not declare`);
    const covered = new Set(t.checks.flatMap((c) => checks.get(c)?.covers ?? []));
    for (const ac of t.covers) if (acs.has(ac) && !covered.has(ac) && t.checks.every((c) => checks.has(c))) err("task-without-matching-check", t.id, `task ${t.id} covers ${ac} but none of its checks verify ${ac}`);
  }
  for (const c of i.spec.checks) {
    for (const ac of c.covers) if (!acs.has(ac)) err("unknown-ac", c.id, `check ${c.id} covers unknown ${ac}`);
    if ("test_file" in c.runs) {
      const tf = normalizeRepoPath(c.runs.test_file);
      if (!tf || !taskFiles.has(tf) || !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(tf))
        err("check-not-executable", c.id, `check ${c.id} points at ${c.runs.test_file}, which no task creates or which is not a test file`);
    }
  }

  const matrix: TraceRow[] = i.requirements.acceptance_criteria.map((a) => {
    const tasks = i.spec.tasks.filter((t) => t.covers.includes(a.id)).map((t) => t.id);
    const ch = i.spec.checks.filter((c) => c.covers.includes(a.id)).map((c) => c.id);
    if (tasks.length === 0) err("ac-uncovered-by-task", a.id, `${a.id} is not implemented by any task`);
    if (ch.length === 0) err("ac-uncovered-by-check", a.id, `${a.id} has no executable check`);
    return { ac: a.id, text: a.text, tasks, checks: ch };
  });

  const protectedPaths = protectedPathHits([...new Set([...taskFiles, ...designPaths])].filter((p): p is string => !!p));
  const riskFloor = protectedPaths.reduce<RiskLevel>((r, h) => maxRisk(r, h.level), "LOW");
  return { ok: errors.length === 0, errors, matrix, protectedPaths, riskFloor };
}
