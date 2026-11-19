import type { Sql } from "@factory/db";

export type Runtime = "claude_code_cli" | "codex_cli" | "local_model";
export type Autonomy = "suggest" | "draft" | "act_with_gate";
/** Structured need. `granted` is the permission envelope the TASK/OPERATOR grants; skill text never widens it. */
export interface TaskRequirements {
  organizationId: string;
  workspaceId?: string;
  /** Role whose qualification is required (e.g. "pm.user_story"). */
  role: string;
  domain: string;
  desiredArtifacts: string[];
  runtime: Runtime;
  autonomy: Autonomy;
  granted: { tools: string[]; network: string[]; writeScopes: string[]; dataClasses: string[] };
  /** Minimum qualification score (0..1) accepted for this task. */
  minQuality?: number;
  keywords?: string[];
  now?: Date;
}
export interface Qualification { role: string; runtime: Runtime; score: number; sampleSize: number; expiresAt: string; revokedAt: string | null; comparisonId: string }
export interface ApprovedCapability {
  versionId: string; kind: "skill" | "agent"; slug: string; digest: string; state: string; revision: number;
  description: string; triggers: string[]; produces: string[]; domains: string[];
  permissions: { tools: string[]; network: string[]; writeScopes: string[]; dataClasses: string[] };
  runtimes: Runtime[];
  qualifications: Qualification[];
  /** Observed historical quality 0..1 over `historySamples` runs, when telemetry is opted in. */
  history?: { quality: number; samples: number };
}
export interface Rejection { slug: string; versionId: string; reason: string; code: "NOT_ACTIVE" | "NOT_APPROVED" | "RUNTIME_INCOMPATIBLE" | "UNQUALIFIED" | "QUALIFICATION_EXPIRED" | "QUALIFICATION_REVOKED" | "BELOW_MIN_QUALITY" | "PERMISSION_EXCEEDS_GRANT" | "NO_COVERAGE" }
export interface RankedCandidate { versionId: string; slug: string; digest: string; kind: "skill" | "agent"; score: number; coverage: number; qualification: { comparisonId: string; score: number; sampleSize: number }; explanation: string[] }
export type MatchResult =
  | { status: "matched"; selected: RankedCandidate[]; composed: boolean; gaps: string[]; rejected: Rejection[]; explanation: string[] }
  | { status: "blocked"; code: "NO_SUPPORTED_ROUTE"; selected: []; gaps: string[]; rejected: Rejection[]; explanation: string[] };

const subset = (a: readonly string[], b: readonly string[]) => a.every((x) => b.includes(x));
const norm = (s: string) => s.toLowerCase();
const tokens = (xs: readonly string[]) => new Set(xs.flatMap((x) => norm(x).split(/[^a-z0-9]+/)).filter((t) => t.length > 2));

/**
 * Ranks ONLY approved, active, version-pinned, role-qualified, runtime-compatible capabilities whose declared permissions fit the grant.
 * There is no fallback: when nothing qualifies the result is a structured `blocked` state, never an ad hoc downgrade to unqualified or metered inference.
 */
export function matchCapabilities(req: TaskRequirements, pool: readonly ApprovedCapability[]): MatchResult {
  const now = (req.now ?? new Date()).getTime();
  const rejected: Rejection[] = []; const ranked: RankedCandidate[] = [];
  const want = tokens([req.domain, ...req.desiredArtifacts, ...(req.keywords ?? [])]);
  for (const c of pool) {
    const rej = (code: Rejection["code"], reason: string) => rejected.push({ slug: c.slug, versionId: c.versionId, code, reason });
    if (c.state !== "approved") { rej("NOT_APPROVED", `version is ${c.state}`); continue; }
    if (!c.runtimes.includes(req.runtime)) { rej("RUNTIME_INCOMPATIBLE", `not declared compatible with ${req.runtime}`); continue; }
    const quals = c.qualifications.filter((q) => q.role === req.role && q.runtime === req.runtime);
    if (quals.length === 0) { rej("UNQUALIFIED", `no qualification for role ${req.role} on ${req.runtime}`); continue; }
    const valid = quals.filter((q) => !q.revokedAt && Date.parse(q.expiresAt) > now);
    if (valid.length === 0) { const anyRevoked = quals.some((q) => q.revokedAt); rej(anyRevoked ? "QUALIFICATION_REVOKED" : "QUALIFICATION_EXPIRED", anyRevoked ? "qualification revoked" : "qualification expired"); continue; }
    const q = valid.reduce((a, b) => (b.score > a.score ? b : a));
    if (req.minQuality !== undefined && q.score < req.minQuality) { rej("BELOW_MIN_QUALITY", `qualified score ${q.score.toFixed(2)} < required ${req.minQuality}`); continue; }
    const over = (["tools", "network", "writeScopes", "dataClasses"] as const).flatMap((k) => c.permissions[k].filter((x) => !req.granted[k].includes(x)).map((x) => `${k}:${x}`));
    if (over.length) { rej("PERMISSION_EXCEEDS_GRANT", `needs ${over.slice(0, 4).join(", ")} which the task does not grant`); continue; }
    const have = tokens([...c.triggers, ...c.domains, ...c.produces, c.description]);
    const need = want.size === 0 ? 1 : [...want].filter((t) => have.has(t)).length / want.size;
    const producesOk = req.desiredArtifacts.length === 0 || req.desiredArtifacts.every((a) => c.produces.map(norm).includes(norm(a)));
    const domainOk = c.domains.length === 0 || c.domains.map(norm).includes(norm(req.domain));
    if (need === 0 || !domainOk) { rej("NO_COVERAGE", `no overlap with domain "${req.domain}" / requested artifacts`); continue; }
    const hist = c.history && c.history.samples >= 5 ? c.history.quality : null;
    const score = 0.5 * need + 0.3 * q.score + 0.1 * (hist ?? q.score) + 0.1 * (producesOk ? 1 : 0);
    ranked.push({ versionId: c.versionId, slug: c.slug, digest: c.digest, kind: c.kind, score, coverage: need, qualification: { comparisonId: q.comparisonId, score: q.score, sampleSize: q.sampleSize },
      explanation: [`coverage ${(need * 100).toFixed(0)}% of requested domain/artifact terms`, `qualified for ${req.role} on ${req.runtime}: score ${q.score.toFixed(2)} over ${q.sampleSize} samples (evidence ${q.comparisonId})`, `permissions ⊆ task grant`, hist === null ? "no (or too little) opted-in history" : `history quality ${hist.toFixed(2)}`, producesOk ? "produces all requested artifacts" : "does not produce every requested artifact"] });
  }
  ranked.sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : 1));
  if (ranked.length === 0) return { status: "blocked", code: "NO_SUPPORTED_ROUTE", selected: [], gaps: [...want], rejected, explanation: [`no approved, qualified, compatible capability for role ${req.role} on ${req.runtime}; no fallback was attempted`] };
  const first = ranked[0] as RankedCandidate;
  const firstCap = pool.find((p) => p.versionId === first.versionId) as ApprovedCapability;
  const selected: RankedCandidate[] = [first];
  let covered = tokens([...firstCap.triggers, ...firstCap.domains, ...firstCap.produces, firstCap.description]);
  // Compose a second capability only when it adds coverage AND the union of declared permissions still fits the grant (declared perms only; never inferred from text).
  for (const r of ranked.slice(1)) {
    const cap = pool.find((p) => p.versionId === r.versionId) as ApprovedCapability;
    const add = [...want].filter((t) => !covered.has(t) && tokens([...cap.triggers, ...cap.domains, ...cap.produces, cap.description]).has(t));
    if (add.length === 0) continue;
    const union = (k: "tools" | "network" | "writeScopes" | "dataClasses") => [...new Set(selected.flatMap((s) => (pool.find((p) => p.versionId === s.versionId) as ApprovedCapability).permissions[k]).concat(cap.permissions[k]))];
    if (!(["tools", "network", "writeScopes", "dataClasses"] as const).every((k) => subset(union(k), req.granted[k]))) { rejected.push({ slug: cap.slug, versionId: cap.versionId, code: "PERMISSION_EXCEEDS_GRANT", reason: "composition would exceed the granted permission envelope" }); continue; }
    selected.push(r); covered = new Set([...covered, ...tokens([...cap.triggers, ...cap.domains, ...cap.produces, cap.description])]);
  }
  const gaps = [...want].filter((t) => !covered.has(t));
  return { status: "matched", selected, composed: selected.length > 1, gaps, rejected, explanation: [`selected ${selected.map((s) => `${s.slug}@${s.digest.slice(0, 15)}`).join(" + ")}`, gaps.length ? `uncovered terms: ${gaps.join(", ")}` : "all requested terms covered"] };
}

/** Loads the approved, ACTIVE pool for an organization from the registry (read-only). */
export async function loadApprovedPool(sql: Sql, org: string, workspace = "default"): Promise<ApprovedCapability[]> {
  const rows = await sql`SELECT v.id, v.kind, v.slug, v.digest, v.state, v.manifest, v.meta, a.revision FROM registry_active a JOIN skill_versions v ON v.id = a.active_version_id
    WHERE a.organization_id = ${org} AND a.workspace_id = ${workspace}`;
  const quals = await sql`SELECT version_id, role, runtime, score, sample_size, expires_at, revoked_at, comparison_id FROM capability_qualifications WHERE organization_id = ${org}`;
  return rows.map((r) => {
    const m = { ...(r.meta as { description?: string; triggers?: string[]; produces?: string[]; domains?: string[] }), ...(r.manifest as { permissions: ApprovedCapability["permissions"]; runtimeCompatibility: Runtime[] }) };
    return { versionId: r.id as string, kind: r.kind as "skill" | "agent", slug: r.slug as string, digest: r.digest as string, state: r.state as string, revision: r.revision as number, description: m.description ?? "", triggers: m.triggers ?? [], produces: m.produces ?? [], domains: m.domains ?? [], permissions: m.permissions, runtimes: m.runtimeCompatibility,
      qualifications: quals.filter((q) => q.version_id === r.id).map((q) => ({ role: q.role as string, runtime: q.runtime as Runtime, score: q.score as number, sampleSize: q.sample_size as number, expiresAt: new Date(q.expires_at as string).toISOString(), revokedAt: q.revoked_at ? new Date(q.revoked_at as string).toISOString() : null, comparisonId: q.comparison_id as string })) };
  });
}
