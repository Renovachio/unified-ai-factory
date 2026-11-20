import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marketplaceJson, runPlugin, type PluginDeps } from "../src/commands/plugin";

function deps(over: Partial<PluginDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "plug-")); const src = join(root, "src-plugin"); mkdirSync(join(src, ".claude-plugin"), { recursive: true }); writeFileSync(join(src, ".claude-plugin/plugin.json"), "{}");
  const ran: string[][] = []; const out: string[] = []; const err: string[] = [];
  const d: PluginDeps = { home: join(root, "home"), plugin: () => src, which: () => "/bin/claude", run: async (c, a) => { ran.push([c, ...a]); return { code: 0, out: "" }; }, out: (s) => out.push(s), err: (s) => err.push(s), ...over };
  return { d, ran, out, err, root, done: () => rmSync(root, { recursive: true, force: true }) };
}
describe("dispatch plugin install: Claude Code plugin, launched by nobody", () => {
  test("builds a local marketplace from the shipped plugin and installs it through claude's own plugin commands", async () => {
    const t = deps(); try {
      expect(await runPlugin("install", t.d)).toBe(0);
      expect(JSON.parse(readFileSync(join(t.d.home, "marketplace/.claude-plugin/marketplace.json"), "utf8"))).toEqual(JSON.parse(marketplaceJson())); expect(existsSync(join(t.d.home, "marketplace/dispatch/.claude-plugin/plugin.json"))).toBe(true);
      expect(t.ran.map((r) => r.slice(1).join(" "))).toEqual(["plugin marketplace remove dispatch-local", `plugin marketplace add ${join(t.d.home, "marketplace")}`, "plugin install dispatch@dispatch-local"]);
      expect(t.ran.every((r) => !r.includes("-p") && !r.some((x) => x.startsWith("/dispatch:")))).toBe(true); // it never starts a Claude session
    } finally { t.done(); }
  });
  test("reports failures and missing pieces; uninstall removes plugin then marketplace; unknown subcommand is a usage error", async () => {
    const a = deps({ which: () => null }); expect(await runPlugin("install", a.d)).toBe(1); expect(a.err.join("")).toContain("not found"); a.done();
    const b = deps({ plugin: () => undefined }); expect(await runPlugin("install", b.d)).toBe(1); b.done();
    const c = deps({ run: async (_c, args) => ({ code: args[1] === "install" ? 1 : 0, out: "boom" }) }); expect(await runPlugin("install", c.d)).toBe(1); expect(c.err.join("")).toContain("boom"); c.done();
    const d = deps(); expect(await runPlugin("uninstall", d.d)).toBe(0); expect(d.ran.map((r) => r.slice(1).join(" "))).toEqual(["plugin uninstall dispatch@dispatch-local", "plugin marketplace remove dispatch-local"]); d.done();
    const e = deps(); expect(await runPlugin("nope", e.d)).toBe(2); e.done();
  });
});
