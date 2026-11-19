/** Wire shapes shared by the terminal, the dashboard and the menu-bar app. Text that originates from users or projects is marked `untrusted` and must be rendered as data. */
export interface FeedEvent { eventId: string; globalSeq: number; jobId: string; sequence: number; type: string; at: string; payload: Record<string, unknown> }
export interface JobView { id: string; projectId: string; project: string; state: string; revision: number; risk: string; prNumber: number | null; title: { text: string; trust: "untrusted" }; paused: boolean; updatedAt: string }
export interface Summary { jobs: { inFlight: number; waitingOnHuman: number; total: number }; approvals: { pending: number; jobDecisions: number; capabilityApprovals: number }; projects: number; workers: { active: number } }
export interface Snapshot { cursor: number; generatedAt: string; jobs: JobView[]; summary: Summary }
export interface FeedPage { events: FeedEvent[]; cursor: number }

export class ApiError extends Error { constructor(readonly status: number, readonly title: string, readonly detail?: string, readonly code?: string) { super(`${status} ${title}${detail ? `: ${detail}` : ""}`); this.name = "ApiError"; } }
/** The request may or may not have been applied (timeout, connection loss, 5xx). Retry with the SAME key via `client.retry`; never create a fresh mutation. */
export class OutcomeUnknown extends Error { constructor(readonly mutation: PendingMutation, readonly cause2: unknown) { super(`outcome unknown for ${mutation.method} ${mutation.path} (idempotency key ${mutation.key.slice(0, 8)}…)`); this.name = "OutcomeUnknown"; } }
export class StaleRevision extends ApiError { constructor(detail?: string) { super(409, "Stale revision", detail, "stale"); this.name = "StaleRevision"; } }

export interface PendingMutation { key: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; expectedRevision?: number; attempts: number }
