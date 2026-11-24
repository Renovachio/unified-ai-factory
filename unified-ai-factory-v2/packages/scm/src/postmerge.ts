import type { Sql } from "@factory/db";

export type CiState = "success" | "failure" | "pending" | "unavailable";
/** Injected reader of the merge commit's combined CI status (GitHub in production). `unavailable` = could not be determined. */
export interface CiStatusPort { combinedStatus(repo: { owner: string; name: string }, sha: string): Promise<CiState> }
export interface PostmergeRecorder { recordPostmerge(jobId: string, r: { ok: boolean; detail: string }): Promise<void> }
export interface WatchResult { checked: number; healthy: string[]; failed: string[]; waiting: string[] }

/**
 * Post-merge CI watcher (ACT-07). For each job in POSTMERGE_MONITOR, reads the merge commit's CI status and records the outcome once.
 * Fail closed: failure, or no conclusive status before `timeoutMinutes`, is recorded as a failed post-merge (incident + circuit breaker);
 * "unavailable" never counts as healthy. Pending within the window just waits.
 */
export async function watchPostmerge(sql: Sql, deps: { ci: CiStatusPort; coordinator: PostmergeRecorder; timeoutMinutes?: number; now?: Date }): Promise<WatchResult> {
  const now = deps.now ?? new Date(); const limitMs = (deps.timeoutMinutes ?? 60) * 60_000;
  const rows = await sql<{ id: string; sha: string | null; owner: string; name: string; since: Date }[]>`
    SELECT j.id, mi.github_merge_sha AS sha, r.owner, r.name, j.updated_at AS since
    FROM jobs j JOIN repositories r ON r.id = j.repository_id
    LEFT JOIN merge_intents mi ON mi.job_id = j.id AND mi.status = 'merged'
    WHERE j.state = 'POSTMERGE_MONITOR' ORDER BY j.updated_at LIMIT 100`;
  const res: WatchResult = { checked: rows.length, healthy: [], failed: [], waiting: [] };
  for (const j of rows) {
    const expired = now.getTime() - j.since.getTime() > limitMs;
    let state: CiState = "unavailable";
    if (j.sha) { try { state = await deps.ci.combinedStatus({ owner: j.owner, name: j.name }, j.sha); } catch { state = "unavailable"; } }
    const record = async (ok: boolean, detail: string, bucket: string[]) => {
      try { await deps.coordinator.recordPostmerge(j.id, { ok, detail }); bucket.push(j.id); } catch { res.waiting.push(j.id); } // already recorded by someone else / raced: leave it
    };
    if (state === "success") await record(true, "main CI green after merge", res.healthy);
    else if (state === "failure") await record(false, "main CI failed after merge", res.failed);
    else if (expired) await record(false, `no conclusive CI status within ${deps.timeoutMinutes ?? 60} minutes (${j.sha ? state : "merge sha unknown"})`, res.failed);
    else res.waiting.push(j.id);
  }
  return res;
}
