import { selectRuntime, type BlockReason, type SelectionInput } from "@factory/runtimes";
import type { TaskContext, TaskExecutor } from "./index";

/**
 * Wraps an executor so a task only starts when an eligible runtime exists for its role (ACT-01 ordered selection).
 * When none does, the task is NOT run and the failure carries an operator-visible block reason; there is no fallback to another source.
 */
export function selectingExecutor(
  inputFor: (ctx: TaskContext) => Omit<SelectionInput, "role"> & { role: string },
  run: (ctx: TaskContext, selected: NonNullable<ReturnType<typeof selectRuntime>["selected"]>) => ReturnType<TaskExecutor>,
): TaskExecutor {
  return async (ctx) => {
    const decision = selectRuntime(inputFor(ctx));
    await ctx.report("runtime.selection", { selected: decision.selected ? `${decision.selected.adapterId}/${decision.selected.modelId}` : null, blockReason: decision.blockReason ?? null, log: decision.log });
    if (!decision.selected) return { ok: false, payload: { blocked: true, blockReason: decision.blockReason as BlockReason, log: decision.log } };
    return run(ctx, decision.selected);
  };
}
