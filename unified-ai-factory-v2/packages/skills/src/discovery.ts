import { readFileSync } from "node:fs";
import { digestOfJson } from "./digest";

export type SourceKind = "local" | "upload" | "catalog" | "git";
export type TrustTier = "user" | "project" | "organization" | "vendor" | "community" | "unknown";
export interface SkillSource { id: string; kind: SourceKind; enabled: boolean; trustTier: TrustTier; uri: string; network: string[] }
export interface SourcesConfig { schemaVersion: 1; sources: SkillSource[] }
export function loadSources(path: string): SourcesConfig {
  const c = JSON.parse(readFileSync(path, "utf8")) as SourcesConfig;
  if (c.schemaVersion !== 1 || !Array.isArray(c.sources)) throw new Error("bad skill-sources config");
  const seen = new Set<string>();
  for (const s of c.sources) {
    if (seen.has(s.id)) throw new Error(`duplicate source id ${s.id}`); seen.add(s.id);
    if (s.kind !== "local" && s.kind !== "upload" && s.network.length === 0) throw new Error(`source ${s.id} declares no network allowlist`);
    for (const h of s.network) if (/^(api\.)?(anthropic|openai)\.com$/.test(h)) throw new Error(`source ${s.id} lists a metered model host`);
  }
  return c;
}

export type ReviewStatus = "unverified" | "scanned" | "license_reviewed" | "blocked";
export interface CatalogEntry {
  sourceId: string;
  /** Canonical URI of the exact item (repo URL + path). */
  uri: string;
  slug: string;
  name: string;
  description: string;
  /** Pinned upstream commit SHA or content digest. Absent => entry is unpinned and cannot be fetched for import. */
  revision?: string;
  license?: string;
  updatedAt?: string;
  trustTier: TrustTier;
  reviewStatus: ReviewStatus;
  /** Why this entry is not importable (missing license, unreachable, unpinned...). It is never silently replaced by another entry. */
  blockedReasons: string[];
  requiredTools: string[];
  requiredNetwork: string[];
  runtimes: string[];
}
export interface RawCatalogItem { uri: string; slug?: string; name?: string; description?: string; revision?: string; license?: string; updatedAt?: string; tools?: string[]; network?: string[]; runtimes?: string[] }
/** Network port: injected, so unit tests run offline and production wires a bounded, allowlisted fetch. */
export interface CatalogPort { list(source: SkillSource): Promise<RawCatalogItem[]> }

const SHA = /^[0-9a-f]{40}$|^sha256:[0-9a-f]{64}$/;
export function normalizeEntry(source: SkillSource, raw: RawCatalogItem, allowedLicenses: readonly string[]): CatalogEntry {
  const blocked: string[] = [];
  let host = "";
  try { const u = new URL(raw.uri); host = u.hostname; if (u.protocol !== "https:" && u.protocol !== "file:") blocked.push("non-https canonical URI"); } catch { blocked.push("invalid canonical URI"); }
  if (source.kind !== "local" && source.kind !== "upload" && host && !source.network.some((n) => host === n || host.endsWith("." + n))) blocked.push(`host ${host} is not in the source's allowlist`);
  if (!raw.revision || !SHA.test(raw.revision)) blocked.push("no pinned immutable revision (commit SHA or sha256)");
  if (!raw.license) blocked.push("no license: code reuse prohibited");
  else if (!allowedLicenses.includes(raw.license)) blocked.push(`license ${raw.license.slice(0, 30)} needs review`);
  const slug = (raw.slug ?? raw.name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(slug)) blocked.push("cannot derive a valid slug");
  return {
    sourceId: source.id, uri: raw.uri, slug, name: raw.name ?? slug, description: (raw.description ?? "").slice(0, 400), ...(raw.revision ? { revision: raw.revision } : {}), ...(raw.license ? { license: raw.license } : {}), ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    trustTier: source.trustTier, reviewStatus: "unverified", blockedReasons: blocked, requiredTools: raw.tools ?? [], requiredNetwork: raw.network ?? [], runtimes: raw.runtimes ?? [],
  };
}

export interface SourceStatus { sourceId: string; state: "ok" | "disabled" | "unreachable"; error?: string; entries: number }
/** Reads indexed metadata only. A failing source is reported as unreachable; its entries are NOT replaced by those of another source. */
export async function refreshCatalog(cfg: SourcesConfig, port: CatalogPort, allowedLicenses: readonly string[]): Promise<{ entries: CatalogEntry[]; status: SourceStatus[] }> {
  const entries: CatalogEntry[] = []; const status: SourceStatus[] = [];
  for (const s of cfg.sources) {
    if (!s.enabled) { status.push({ sourceId: s.id, state: "disabled", entries: 0 }); continue; }
    try { const raw = await port.list(s); const e = raw.map((r) => normalizeEntry(s, r, allowedLicenses)); entries.push(...e); status.push({ sourceId: s.id, state: "ok", entries: e.length }); }
    catch (err) { status.push({ sourceId: s.id, state: "unreachable", error: String((err as Error).message ?? err).slice(0, 200), entries: 0 }); }
  }
  // exact duplicates (same canonical uri + revision) collapse to the highest trust tier; different revisions stay separate
  const rank: Record<TrustTier, number> = { organization: 5, vendor: 4, project: 3, user: 3, community: 2, unknown: 1 };
  const byKey = new Map<string, CatalogEntry>();
  for (const e of entries) { const k = `${e.uri}@${e.revision ?? ""}`; const cur = byKey.get(k); if (!cur || rank[e.trustTier] > rank[cur.trustTier]) byKey.set(k, e); }
  return { entries: [...byKey.values()], status };
}

export interface SearchHit { entry: CatalogEntry; score: number; rationale: string[]; installable: false; installRestrictions: string[] }
const tok = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
/** Search never activates or downloads anything: `installable` is always false; hits explain WHY they matched and what blocks them. */
export function searchCatalog(entries: readonly CatalogEntry[], query: string, opts: { runtime?: string; limit?: number } = {}): SearchHit[] {
  const q = [...new Set(tok(query))]; if (q.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const e of entries) {
    const name = new Set(tok(`${e.name} ${e.slug}`)), desc = new Set(tok(e.description));
    const rationale: string[] = []; let score = 0;
    for (const t of q) { if (name.has(t)) { score += 3; rationale.push(`name matches "${t}"`); } else if (desc.has(t)) { score += 1; rationale.push(`description matches "${t}"`); } }
    if (score === 0) continue;
    if (opts.runtime && e.runtimes.length && !e.runtimes.includes(opts.runtime)) continue;
    const restrictions = [...e.blockedReasons];
    if (e.reviewStatus === "unverified") restrictions.push("unverified: must be fetched into quarantine, scanned and license-reviewed before use");
    if (e.requiredTools.length) rationale.push(`requires tools: ${e.requiredTools.join(", ")}`);
    if (e.requiredNetwork.length) rationale.push(`requires network: ${e.requiredNetwork.join(", ")}`);
    hits.push({ entry: e, score, rationale, installable: false, installRestrictions: restrictions });
  }
  return hits.sort((a, b) => b.score - a.score || (a.entry.uri < b.entry.uri ? -1 : 1)).slice(0, opts.limit ?? 20);
}
export const catalogDigest = (e: readonly CatalogEntry[]): string => digestOfJson(e);

/** Bounded HTTPS JSON fetch for production wiring; refuses hosts outside the source allowlist and oversized bodies. Not used unless a source is enabled. */
export async function boundedFetchJson(url: string, source: SkillSource, opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !source.network.some((n) => u.hostname === n || u.hostname.endsWith("." + n))) throw new Error(`blocked fetch to ${u.hostname}`);
  const res = await (opts.fetchImpl ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > (opts.maxBytes ?? 2_000_000)) throw new Error("response too large");
  return JSON.parse(new TextDecoder().decode(buf));
}
