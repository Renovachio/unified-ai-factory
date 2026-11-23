import type { Sql } from "@factory/db";
import { MemoryError } from "./domain";
import type { PackTextStore } from "./context";
import { type Actor, approveMemory, conflictsOf, eraseMemory, lockProjectApprovals, type MemoryView, requireActor, requireProject } from "./lifecycle";
import { APPROVER_ROLES } from "./domain";
import { purgePackTextFor } from "./retention";

/**
 * Approval that resolves overlaps with approved memory (MEM-05 decision): approved memory expires only when a new approval
 * conflicts with it AND the approver accepts erasing it. The approver must name EXACTLY the conflicting memories; nothing else
 * can be erased by this call. Each named memory is erased (content, index, pack text) and the new memory is approved, in one
 * database transaction. Pack text is removed after commit; a retry (or the retention sweep) finishes any blob left behind.
 */
export async function approveWithErasure(sql: Sql, store: PackTextStore, actor: Actor, projectId: string, memoryId: string, acceptErasureOf: string[]): Promise<MemoryView> {
  const erased: string[] = [];
  let view: MemoryView;
  try {
    view = await sql.begin(async (tx) => {
      await requireActor(tx, actor, APPROVER_ROLES);
      await requireProject(tx, actor.organizationId, projectId);
      await lockProjectApprovals(tx, projectId);
      const conflicts = (await conflictsOf(tx, actor.organizationId, projectId, memoryId)).map((c) => c.id).sort();
      const accepted = [...new Set(acceptErasureOf)].sort();
      if (conflicts.length !== accepted.length || conflicts.some((id, i) => id !== accepted[i])) {
        throw new MemoryError("CONFLICT_UNRESOLVED", `the erasure decision must name exactly the overlapping memories: ${conflicts.join(", ") || "none"}`);
      }
      for (const id of conflicts) {
        await eraseMemory(tx as unknown as Sql, actor, projectId, id, `overlaps memory ${memoryId}; erasure accepted by approver`);
        erased.push(id);
      }
      return approveMemory(tx as unknown as Sql, actor, projectId, memoryId);
    }) as MemoryView;
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError("DB_REJECTED", String((e as Error).message).slice(0, 200));
  }
  for (const id of erased) await purgePackTextFor(sql, store, actor.organizationId, projectId, id);
  return view;
}
