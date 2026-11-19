import { z } from "zod";

/** Model tiers an agent may be assigned. Relative cost weights are a planning heuristic, NOT token counts. */
export const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const TIER_COST: Readonly<Record<ModelTier, number>> = { haiku: 1, sonnet: 3, opus: 15 };

const PROTECTED = [/^\.git(\/|$)/, /^\.github(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.env(\.|$|\/)/, /(^|\/)\.ssh(\/|$)/];
export const safeRelPath = (p: string): boolean =>
  p.length > 0 && p.length <= 500 && !p.includes("\0") && !p.startsWith("/") && !p.startsWith("~") && !p.includes("\\") &&
  !p.split("/").some((seg) => seg === ".." || seg === ".") && !PROTECTED.some((re) => re.test(p.replace(/\/+$/, "")));

const Path = z.string().refine(safeRelPath, "must be a relative path inside the project (no .., absolute, .git, .github, .env or node_modules)");
export const PlanTaskSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "id: lowercase letters, digits, - or _ (max 40)"),
  goal: z.string().min(1).max(2000),
  model: z.enum(MODEL_TIERS),
  /** Files or folders (trailing "/") the agent is expected to read. Informational: reading is not restricted by the plan. */
  reads: z.array(Path).max(50).default([]),
  /** Files or folders (trailing "/") the agent may change. Anything changed outside this list is rejected when the run is finished. */
  writes: z.array(Path).max(50).default([]),
  dependsOn: z.array(z.string()).max(12).default([]),
});
export const PlanSchema = z.strictObject({ summary: z.string().min(1).max(2000), tasks: z.array(PlanTaskSchema).min(1).max(40) });
export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export interface PlanLimits { maxTasks: number; maxOpusTasks: number; maxParallel: number }
export const DEFAULT_PLAN_LIMITS: PlanLimits = { maxTasks: 12, maxOpusTasks: 2, maxParallel: 4 };

export type PlanCheck = { ok: true; plan: Plan; waves: string[][]; cost: number; byModel: Record<ModelTier, number> } | { ok: false; errors: string[] };

const norm = (p: string) => p.replace(/\/+$/, "");
/** Two write scopes overlap when equal or one is a folder containing the other. */
export const writesOverlap = (a: string, b: string): boolean => { const x = norm(a); const y = norm(b); return x === y || x.startsWith(y + "/") || y.startsWith(x + "/"); };

/**
 * Validate an agent-proposed plan. Pure. The plan is UNTRUSTED input (a model produced it): strict schema, bounded size, dependency order,
 * and tasks that may run at the same time must write to disjoint paths (otherwise they would overwrite each other).
 */
export function validatePlan(raw: unknown, limits: PlanLimits = DEFAULT_PLAN_LIMITS): PlanCheck {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "plan"}: ${i.message}`) };
  const plan = parsed.data; const errors: string[] = [];
  if (plan.tasks.length > limits.maxTasks) errors.push(`too many tasks (${plan.tasks.length} > ${limits.maxTasks})`);
  const opus = plan.tasks.filter((t) => t.model === "opus").length;
  if (opus > limits.maxOpusTasks) errors.push(`too many opus tasks (${opus} > ${limits.maxOpusTasks}); use a cheaper model for execution`);
  const ids = new Set<string>();
  for (const t of plan.tasks) { if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`); ids.add(t.id); }
  for (const t of plan.tasks) for (const d of t.dependsOn) { if (!ids.has(d)) errors.push(`${t.id} depends on unknown task ${d}`); if (d === t.id) errors.push(`${t.id} depends on itself`); }
  if (errors.length) return { ok: false, errors };

  // Layered topological order: a wave is every task whose dependencies are all done.
  const done = new Set<string>(); const waves: string[][] = []; let left = [...plan.tasks];
  while (left.length) {
    const ready = left.filter((t) => t.dependsOn.every((d) => done.has(d)));
    if (!ready.length) return { ok: false, errors: [`dependency cycle among: ${left.map((t) => t.id).join(", ")}`] };
    for (let i = 0; i < ready.length; i += limits.maxParallel) waves.push(ready.slice(i, i + limits.maxParallel).map((t) => t.id)); // cap parallelism by splitting a wave
    // Writes must be disjoint across everything that could run in the same layer (not only within a capped slice).
    for (let i = 0; i < ready.length; i++) for (let j = i + 1; j < ready.length; j++) {
      const a = ready[i]; const b = ready[j]; if (!a || !b) continue;
      for (const wa of a.writes) for (const wb of b.writes) if (writesOverlap(wa, wb)) errors.push(`${a.id} and ${b.id} could run in parallel but both write ${wa === wb ? wa : `${wa} / ${wb}`}; make one depend on the other`);
    }
    for (const t of ready) done.add(t.id);
    left = left.filter((t) => !done.has(t.id));
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 10) };
  const byModel: Record<ModelTier, number> = { haiku: 0, sonnet: 0, opus: 0 };
  for (const t of plan.tasks) byModel[t.model]++;
  return { ok: true, plan, waves, cost: plan.tasks.reduce((n, t) => n + TIER_COST[t.model], 0), byModel };
}

/** A path a task changed is allowed only if it is inside one of the task's declared write scopes. */
export const withinWrites = (path: string, writes: string[]): boolean => writes.some((w) => { const x = norm(w); return path === x || path.startsWith(x + "/"); });
