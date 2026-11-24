import { describe, expect, test } from "bun:test";
import { validatePlan, safeRelPath, writesOverlap, withinWrites, TIER_COST } from "../src/index";

const t = (id: string, o: Record<string, unknown> = {}) => ({ id, goal: "do " + id, model: "haiku", reads: [], writes: [], dependsOn: [], ...o });
const plan = (tasks: unknown[]) => ({ summary: "s", tasks });

describe("plan validation (the plan is untrusted model output)", () => {
  test("a valid plan gets dependency waves, a cost and a per-model count", () => {
    const r = validatePlan(plan([t("read", { reads: ["notes.txt"] }), t("write-a", { model: "sonnet", writes: ["out/a.md"], dependsOn: ["read"] }), t("write-b", { model: "sonnet", writes: ["out/b.md"], dependsOn: ["read"] }), t("review", { model: "opus", dependsOn: ["write-a", "write-b"] })]));
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.waves).toEqual([["read"], ["write-a", "write-b"], ["review"]]);
    expect(r.byModel).toEqual({ haiku: 1, sonnet: 2, opus: 1 }); expect(r.cost).toBe(TIER_COST.haiku + 2 * TIER_COST.sonnet + TIER_COST.opus);
  });
  test("parallel tasks may not write the same file or a containing folder; ordering them fixes it", () => {
    const bad = validatePlan(plan([t("a", { writes: ["docs/"] }), t("b", { writes: ["docs/x.md"] })]));
    expect(bad.ok).toBe(false); if (!bad.ok) expect(bad.errors[0]).toContain("could run in parallel");
    expect(validatePlan(plan([t("a", { writes: ["docs/"] }), t("b", { writes: ["docs/x.md"], dependsOn: ["a"] })])).ok).toBe(true);
    expect(writesOverlap("a/", "a/b")).toBe(true); expect(writesOverlap("a", "ab")).toBe(false);
  });
  test("cycles, unknown/self dependencies, duplicates, too many tasks and too many opus tasks are refused", () => {
    expect(validatePlan(plan([t("a", { dependsOn: ["b"] }), t("b", { dependsOn: ["a"] })]))).toMatchObject({ ok: false });
    expect(validatePlan(plan([t("a", { dependsOn: ["zz"] })]))).toMatchObject({ ok: false });
    expect(validatePlan(plan([t("a", { dependsOn: ["a"] })]))).toMatchObject({ ok: false });
    expect(validatePlan(plan([t("a"), t("a")]))).toMatchObject({ ok: false });
    expect(validatePlan(plan(Array.from({ length: 13 }, (_, i) => t(`t${i}`))))).toMatchObject({ ok: false });
    const o = validatePlan(plan([t("a", { model: "opus" }), t("b", { model: "opus" }), t("c", { model: "opus" })])); expect(o.ok).toBe(false); if (!o.ok) expect(o.errors.join()).toContain("opus");
  });
  test("unknown models/keys, bad ids and unsafe paths are refused", () => {
    for (const bad of [t("a", { model: "gpt-4" }), t("a", { extra: 1 }), t("A B"), t("a", { writes: ["../x"] }), t("a", { writes: ["/etc/passwd"] }), t("a", { writes: [".git/config"] }), t("a", { writes: [".env"] }), t("a", { reads: ["~/.ssh/id_rsa"] }), t("a", { writes: ["node_modules/x"] })])
      expect(validatePlan(plan([bad])).ok).toBe(false);
    expect(validatePlan({ summary: "s" }).ok).toBe(false); expect(validatePlan(null).ok).toBe(false); expect(validatePlan(plan([]))).toMatchObject({ ok: false });
  });
  test("parallelism is capped by splitting a layer into waves", () => {
    const r = validatePlan(plan(Array.from({ length: 6 }, (_, i) => t(`t${i}`, { writes: [`f${i}.txt`] }))), { maxTasks: 12, maxOpusTasks: 2, maxParallel: 4 });
    expect(r.ok && r.waves.map((w) => w.length)).toEqual([4, 2]);
  });
  test("path helpers", () => {
    expect(safeRelPath("src/a.ts")).toBe(true); expect(safeRelPath("docs/")).toBe(true);
    for (const p of ["", "..", "a/../b", "/a", "~/a", "a\\b", ".github/workflows/x.yml", ".env.local", "x/.env", "a\0b"]) expect(safeRelPath(p)).toBe(false);
    expect(withinWrites("docs/a.md", ["docs/"])).toBe(true); expect(withinWrites("docsx/a.md", ["docs/"])).toBe(false); expect(withinWrites("a.md", ["a.md"])).toBe(true);
  });
});
