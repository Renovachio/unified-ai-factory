import { appendEvent, type Sql } from "@factory/db";
import { protectedPathHits } from "@factory/domain";
import { digestOf, redactString } from "@factory/telemetry";

export class AutoMergeRefused extends Error {
  constructor(readonly code: "pilot-invalid" | "not-found" | "validation", message: string, readonly reasons: string[] = []) { super(message); this.name = "AutoMergeRefused"; }
}

export type PilotValidator = (report: unknown) => { ok: boolean; reasons: string[]; digest?: string };

export interface AutoMergeCheck { allowed: boolean; reasons: string[] }

const rx = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "<<S>>").replace(/\*\*/g, "<<A>>").replace(/\*/g, "[^/]*").replace(/<<S>>/g, "(?:.*/)?").replace(/<<A>>/g, ".*") + "$");

/**
 * Rollout controls for opt-in LOW-risk auto-merge. INERT by default (migration seeds the global kill switch ENGAGED, repositories are not opted in).
 * These controls only ever REMOVE eligibility; the policy engine decides whether a change is eligible at all (never HIGH/CRITICAL).
 */
export class AutoMergeController {
  constructor(private readonly sql: Sql, private readonly validatePilot: PilotValidator, private readonly now: () => number = Date.now) {}

  private audit(orgId: string | null, actor: string, action: string, resource: string, result: string, reason: string, extra: unknown = {}) {
    return this.sql`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest) VALUES (${orgId}, ${actor}, ${action}, ${resource}, ${result}, ${redactString(reason).slice(0, 800)}, ${digestOf({ action, resource, actor, reason, extra, at: this.now() })})`;
  }

  async global() {
    const [g] = await this.sql<{ kill_switch: boolean; reason: string | null; set_by: string | null; set_at: Date }[]>`SELECT kill_switch, reason, set_by, set_at FROM auto_merge_global WHERE id = 1`;
    return { killSwitch: g?.kill_switch ?? true, reason: g?.reason ?? null, setBy: g?.set_by ?? null, setAt: g?.set_at ?? null };
  }

  /** Engage the kill switch: takes effect on the very next evaluation, for every repository. Any operator may do this. */
  async kill(actor: string, orgId: string, reason: string): Promise<void> {
    await this.sql`UPDATE auto_merge_global SET kill_switch = true, reason = ${redactString(reason).slice(0, 500)}, set_by = ${actor}, set_at = now() WHERE id = 1`;
    await this.audit(orgId, actor, "auto_merge.kill", "auto-merge:global", "ok", reason);
  }
  /** Disarm the kill switch (re-allow auto-merge where repositories are opted in). Restricted to admin/security officer by the API. */
  async disarm(actor: string, orgId: string, reason: string): Promise<void> {
    await this.sql`UPDATE auto_merge_global SET kill_switch = false, reason = ${redactString(reason).slice(0, 500)}, set_by = ${actor}, set_at = now() WHERE id = 1`;
    await this.audit(orgId, actor, "auto_merge.disarm", "auto-merge:global", "ok", reason);
  }

  async enableRepo(i: { actor: string; orgId: string; repositoryId: string; pilotReport: unknown; allowedRisks?: Array<"LOW" | "MEDIUM">; allowedPathGlobs?: string[]; maxPerDay?: number; cooldownMinutes?: number }): Promise<{ signoffDigest: string }> {
    const [repo] = await this.sql<{ id: string }[]>`SELECT id FROM repositories WHERE id = ${i.repositoryId} AND organization_id = ${i.orgId}`;
    if (!repo) throw new AutoMergeRefused("not-found", "repository not found");
    const v = this.validatePilot(i.pilotReport);
    if (!v.ok || !v.digest) {
      await this.audit(i.orgId, i.actor, "auto_merge.enable", `repo:${i.repositoryId}`, "denied", `pilot evidence rejected: ${v.reasons.join("; ")}`);
      throw new AutoMergeRefused("pilot-invalid", "pilot evidence does not satisfy the calibration requirements", v.reasons);
    }
    const risks = i.allowedRisks ?? ["LOW"];
    const globs = i.allowedPathGlobs ?? [];
    if (globs.some((g) => g === "**" || g === "*" || g.length > 200)) throw new AutoMergeRefused("validation", "path allowlist globs must be specific");
    await this.sql`INSERT INTO auto_merge_repo_controls (repository_id, enabled, enabled_by, enabled_on, signoff, signoff_digest, allowed_risks, allowed_path_globs, max_per_day, cooldown_minutes, tripped_at, trip_reason, updated_at)
      VALUES (${i.repositoryId}, true, ${i.actor}, now(), ${this.sql.json(i.pilotReport as never)}, ${v.digest}, ${risks}, ${globs}, ${i.maxPerDay ?? 3}, ${i.cooldownMinutes ?? 30}, NULL, NULL, now())
      ON CONFLICT (repository_id) DO UPDATE SET enabled = true, enabled_by = ${i.actor}, enabled_on = now(), signoff = ${this.sql.json(i.pilotReport as never)}, signoff_digest = ${v.digest}, allowed_risks = ${risks}, allowed_path_globs = ${globs},
        max_per_day = ${i.maxPerDay ?? 3}, cooldown_minutes = ${i.cooldownMinutes ?? 30}, tripped_at = NULL, trip_reason = NULL, updated_at = now()`;
    await this.audit(i.orgId, i.actor, "auto_merge.enable", `repo:${i.repositoryId}`, "ok", `opted in with pilot sign-off ${v.digest}`, { risks, globs });
    return { signoffDigest: v.digest };
  }

  async disableRepo(actor: string, orgId: string, repositoryId: string, reason: string): Promise<void> {
    await this.sql`UPDATE auto_merge_repo_controls SET enabled = false, updated_at = now() WHERE repository_id = ${repositoryId}`;
    await this.audit(orgId, actor, "auto_merge.disable", `repo:${repositoryId}`, "ok", reason);
  }

  /** Circuit breaker: stops auto-merge for the repository until an administrator re-arms it. */
  async trip(repositoryId: string, reason: string, actor = "auto-merge-breaker"): Promise<void> {
    await this.sql`UPDATE auto_merge_repo_controls SET tripped_at = now(), trip_reason = ${redactString(reason).slice(0, 500)}, updated_at = now() WHERE repository_id = ${repositoryId}`;
    await this.audit(null, actor, "auto_merge.trip", `repo:${repositoryId}`, "ok", reason);
  }
  async rearm(actor: string, orgId: string, repositoryId: string, reason: string): Promise<void> {
    await this.sql`UPDATE auto_merge_repo_controls SET tripped_at = NULL, trip_reason = NULL, updated_at = now() WHERE repository_id = ${repositoryId}`;
    await this.audit(orgId, actor, "auto_merge.rearm", `repo:${repositoryId}`, "ok", reason);
  }

  /** Operator override for ONE job: it can only be merged with a human approval. */
  async holdJob(actor: string, orgId: string, jobId: string, reason: string): Promise<void> {
    const [j] = await this.sql<{ id: string }[]>`SELECT j.id FROM jobs j JOIN repositories r ON r.id = j.repository_id WHERE j.id = ${jobId} AND r.organization_id = ${orgId}`;
    if (!j) throw new AutoMergeRefused("not-found", "job not found");
    await this.sql.begin(async (tx) => { await appendEvent(tx, { jobId, type: "auto_merge.hold", source: "api", actorId: actor, payload: { reason: redactString(reason) } }); });
    await this.audit(orgId, actor, "auto_merge.hold", `job:${jobId}`, "ok", reason);
  }

  /** True only for repositories that are opted in WITH a recorded pilot sign-off (feeds the policy engine's `calibrated` input). */
  async calibrated(repositoryId: string): Promise<boolean> {
    const [c] = await this.sql<{ ok: boolean }[]>`SELECT (enabled AND signoff_digest IS NOT NULL) AS ok FROM auto_merge_repo_controls WHERE repository_id = ${repositoryId}`;
    return c?.ok ?? false;
  }

  async status(orgId: string) {
    const repos = await this.sql<{ repository_id: string; owner: string; name: string; enabled: boolean; enabled_by: string | null; signoff_digest: string | null; allowed_risks: string[]; allowed_path_globs: string[]; max_per_day: number; cooldown_minutes: number; tripped_at: Date | null; trip_reason: string | null }[]>`
      SELECT c.repository_id, r.owner, r.name, c.enabled, c.enabled_by, c.signoff_digest, c.allowed_risks, c.allowed_path_globs, c.max_per_day, c.cooldown_minutes, c.tripped_at, c.trip_reason
      FROM auto_merge_repo_controls c JOIN repositories r ON r.id = c.repository_id WHERE r.organization_id = ${orgId} ORDER BY r.owner, r.name`;
    const [today] = await this.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM merge_intents mi JOIN repositories r ON r.id = mi.repository_id WHERE r.organization_id = ${orgId} AND mi.auto AND mi.status = 'merged' AND mi.updated_at > now() - interval '24 hours'`;
    return {
      global: await this.global(), autoMergesLast24h: today?.c ?? 0,
      repositories: repos.map((r) => ({ repositoryId: r.repository_id, repository: `${r.owner}/${r.name}`, enabled: r.enabled, enabledBy: r.enabled_by, signoffDigest: r.signoff_digest, allowedRisks: r.allowed_risks, allowedPathGlobs: r.allowed_path_globs, maxPerDay: r.max_per_day, cooldownMinutes: r.cooldown_minutes, tripped: r.tripped_at !== null, tripReason: r.trip_reason })),
    };
  }

  /** Every control that can veto an otherwise-eligible LOW-risk change. Pure removal of eligibility; recorded in the audit log when the outcome changes. */
  async evaluate(job: { id: string; repositoryId: string; headSha: string; risk: string; changedFiles: readonly string[] | null }): Promise<AutoMergeCheck> {
    const reasons: string[] = [];
    const g = await this.global();
    if (g.killSwitch) reasons.push(`global kill switch is engaged${g.reason ? ` (${g.reason})` : ""}`);
    const [c] = await this.sql<{ enabled: boolean; signoff_digest: string | null; allowed_risks: string[]; allowed_path_globs: string[]; max_per_day: number; cooldown_minutes: number; tripped_at: Date | null; trip_reason: string | null }[]>`SELECT enabled, signoff_digest, allowed_risks, allowed_path_globs, max_per_day, cooldown_minutes, tripped_at, trip_reason FROM auto_merge_repo_controls WHERE repository_id = ${job.repositoryId}`;
    if (!c || !c.enabled) reasons.push("repository has not opted in to auto-merge");
    else {
      if (!c.signoff_digest) reasons.push("no recorded pilot sign-off");
      if (c.tripped_at) reasons.push(`circuit breaker tripped: ${c.trip_reason ?? "post-merge failure"}`);
      if (!c.allowed_risks.includes(job.risk)) reasons.push(`risk ${job.risk} is not in this repository's auto-merge allowlist`);
      if (job.changedFiles === null) reasons.push("changed files unknown");
      else {
        if (c.allowed_path_globs.length > 0) { const res = c.allowed_path_globs.map(rx); for (const f of job.changedFiles) if (!res.some((r) => r.test(f))) reasons.push(`file ${f} is outside the auto-merge path allowlist`); }
        const prot = protectedPathHits(job.changedFiles);
        if (prot.length) reasons.push(`protected paths touched (${prot.map((p) => p.path).slice(0, 3).join(", ")})`);
      }
      const [n] = await this.sql<{ c: number; last: Date | null }[]>`SELECT count(*)::int AS c, max(mi.updated_at) AS last FROM merge_intents mi WHERE mi.repository_id = ${job.repositoryId} AND mi.auto AND mi.status = 'merged' AND mi.updated_at > ${new Date(this.now() - 86_400_000)}`;
      if ((n?.c ?? 0) >= c.max_per_day) reasons.push(`daily auto-merge limit reached (${c.max_per_day})`);
      if (n?.last && this.now() - n.last.getTime() < c.cooldown_minutes * 60_000) reasons.push(`cooldown: ${c.cooldown_minutes} min since the last auto-merge`);
    }
    const [hold] = await this.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM events WHERE job_id = ${job.id} AND type = 'auto_merge.hold'`;
    if ((hold?.c ?? 0) > 0) reasons.push("an operator placed this job on hold (human approval required)");
    const out = { allowed: reasons.length === 0, reasons };
    // audit only when the outcome for this exact head changes (avoids one row per orchestrator tick)
    const d = digestOf({ job: job.id, head: job.headSha, allowed: out.allowed, reasons });
    const [seen] = await this.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM audit_entries WHERE resource = ${`job:${job.id}`} AND action = 'auto_merge.decision' AND digest = ${d}`;
    if (!seen?.c) await this.sql`INSERT INTO audit_entries (actor, action, resource, result, reason, digest) VALUES ('auto-merge-gate', 'auto_merge.decision', ${`job:${job.id}`}, ${out.allowed ? "allowed" : "denied"}, ${out.reasons.join("; ").slice(0, 800) || "all controls satisfied"}, ${d})`;
    return out;
  }
}
