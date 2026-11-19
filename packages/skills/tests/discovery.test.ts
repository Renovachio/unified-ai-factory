import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { boundedFetchJson, loadSources, refreshCatalog, searchCatalog, type CatalogPort, type RawCatalogItem, type SkillSource, type SourcesConfig } from "../src/index";

const LIC = ["MIT", "Apache-2.0"];
const SHA = "a".repeat(40);
const gh = (id: string, enabled = true): SkillSource => ({ id, kind: "git", enabled, trustTier: "community", uri: "https://github.com/x/y", network: ["github.com"] });
const port = (items: Record<string, RawCatalogItem[] | Error>): CatalogPort => ({ list: async (s) => { const v = items[s.id]; if (v instanceof Error) throw v; return v ?? []; } });

describe("config", () => {
  test("the shipped config lists the v2.2 candidate sources, all DISABLED, with network allowlists and no model hosts", () => {
    const c = loadSources(join(import.meta.dir, "../../../config/skill-sources.json"));
    expect(c.sources.length).toBeGreaterThanOrEqual(7);
    expect(c.sources.every((s) => s.enabled === false)).toBe(true);
    expect(c.sources.find((s) => s.id === "pm-skills")?.network).toContain("github.com");
  });
  test("a remote source without an allowlist, or a metered host, is rejected at load", () => {
    const p = join(import.meta.dir, "tmp-src.json");
    const w = (s: unknown) => Bun.write(p, JSON.stringify(s));
    return (async () => {
      await w({ schemaVersion: 1, sources: [{ id: "a", kind: "git", enabled: false, trustTier: "community", uri: "https://x", network: [] }] });
      expect(() => loadSources(p)).toThrow(/no network allowlist/);
      await w({ schemaVersion: 1, sources: [{ id: "a", kind: "git", enabled: false, trustTier: "community", uri: "https://x", network: ["api.openai.com"] }] });
      expect(() => loadSources(p)).toThrow(/metered/);
      (await import("node:fs")).rmSync(p);
    })();
  });
});

describe("SAI-02 catalog: provenance, pinning, blocked-not-replaced (T-02, T-03, T-04)", () => {
  const good: RawCatalogItem = { uri: "https://github.com/x/y/tree/main/skills/prd-writer", name: "PRD Writer", description: "Write product requirement documents from research notes", revision: SHA, license: "MIT", updatedAt: "2026-10-01", tools: ["Read"], runtimes: ["local_model"] };
  test("entries carry canonical URI, pinned revision, license, trust tier; all start unverified and never installable", async () => {
    const cfg: SourcesConfig = { schemaVersion: 1, sources: [gh("s1")] };
    const { entries, status } = await refreshCatalog(cfg, port({ s1: [good] }), LIC);
    expect(status).toEqual([{ sourceId: "s1", state: "ok", entries: 1 }]);
    expect(entries[0]).toMatchObject({ uri: good.uri, revision: SHA, license: "MIT", trustTier: "community", reviewStatus: "unverified", blockedReasons: [] });
    const hits = searchCatalog(entries, "write a PRD from research");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ installable: false });
    expect(hits[0]!.rationale.join(" ")).toMatch(/name matches "prd"/);
    expect(hits[0]!.installRestrictions.join(" ")).toMatch(/unverified/);
  });
  test("missing license, unpinned revision, wrong host and unreviewed license are blocked with reasons", async () => {
    const cfg: SourcesConfig = { schemaVersion: 1, sources: [gh("s1")] };
    const { entries } = await refreshCatalog(cfg, port({ s1: [
      { uri: good.uri.replace("skills/prd-writer", "a1"), name: "a1x", description: "Write product requirement documents", revision: SHA }, { ...good, uri: "https://github.com/x/y/a2", name: "a2x", revision: "main" },
      { ...good, uri: "https://evil.test/x/y/a3", name: "a3x" }, { ...good, uri: "https://github.com/x/y/a4", name: "a4x", license: "GPL-3.0-only" }, { ...good, uri: "http://github.com/x/y/a5", name: "a5x" },
    ] }), LIC);
    const reasons = Object.fromEntries(entries.map((e) => [e.name, e.blockedReasons.join("|")]));
    expect(reasons.a1x).toMatch(/no license/); expect(reasons.a2x).toMatch(/no pinned/); expect(reasons.a3x).toMatch(/allowlist/); expect(reasons.a4x).toMatch(/needs review/); expect(reasons.a5x).toMatch(/non-https/);
    expect(searchCatalog(entries, "a1x").every((h) => h.installRestrictions.length > 0)).toBe(true);
  });
  test("an unreachable source is reported and its entries are not silently replaced by another source's", async () => {
    const cfg: SourcesConfig = { schemaVersion: 1, sources: [gh("down"), gh("up"), gh("off", false)] };
    const { entries, status } = await refreshCatalog(cfg, port({ down: new Error("ECONNREFUSED"), up: [{ ...good, uri: "https://github.com/x/y/other", name: "Other Thing" }] }), LIC);
    expect(status.map((s) => [s.sourceId, s.state])).toEqual([["down", "unreachable"], ["up", "ok"], ["off", "disabled"]]);
    expect(entries.map((e) => e.sourceId)).toEqual(["up"]);
  });
  test("same uri@revision from two sources collapses to the higher trust tier; a different revision stays separate", async () => {
    const vendor: SkillSource = { ...gh("v"), trustTier: "vendor" };
    const { entries } = await refreshCatalog({ schemaVersion: 1, sources: [gh("c"), vendor] }, port({ c: [good], v: [good, { ...good, revision: "b".repeat(40) }] }), LIC);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.revision === SHA)?.trustTier).toBe("vendor");
  });
  test("search never returns installable entries and filters by runtime", async () => {
    const { entries } = await refreshCatalog({ schemaVersion: 1, sources: [gh("s")] }, port({ s: [good, { ...good, uri: "https://github.com/x/y/cli", name: "PRD CLI Helper", runtimes: ["claude_code_cli"] }] }), LIC);
    expect(searchCatalog(entries, "prd", { runtime: "local_model" })).toHaveLength(1);
    expect(searchCatalog(entries, "prd").every((h) => h.installable === false)).toBe(true);
    expect(searchCatalog(entries, "zz")).toEqual([]);
  });
  test("bounded fetch refuses non-allowlisted hosts, http, redirects and oversized bodies", async () => {
    const s = gh("s");
    await expect(boundedFetchJson("https://evil.test/x", s)).rejects.toThrow(/blocked/);
    await expect(boundedFetchJson("http://github.com/x", s)).rejects.toThrow(/blocked/);
    const big = (async () => new Response("x".repeat(100))) as unknown as typeof fetch;
    await expect(boundedFetchJson("https://github.com/x", s, { fetchImpl: big, maxBytes: 10 })).rejects.toThrow(/too large/);
    const ok = (async () => Response.json({ a: 1 })) as unknown as typeof fetch;
    expect(await boundedFetchJson("https://api.github.com/x", s, { fetchImpl: ok })).toEqual({ a: 1 });
  });
});
