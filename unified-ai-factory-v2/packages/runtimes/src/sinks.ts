import type { EventSink } from "./types";

/** Adapts normalized agent events onto the fenced task-event reporter (runner `ctx.report`). */
export const toTaskReporter =
  (report: (type: string, payload?: Record<string, unknown>) => Promise<void>): EventSink =>
  async (e) => report(e.type, { run_id: e.run_id, agent_sequence: e.sequence, ...e.payload });
