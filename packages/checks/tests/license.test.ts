import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLicenseCheck, spdxAllowed } from "../src/license/index";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

interface Fixture {
  deps?: Record<string, string>;
  installed?: Array<{ name: string; version: string; license: string }>;
  sources?: Record<string, string>;
  approvals?: string;
  provenance?: boolean;
}

function fixture(f: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), "lic-"));
  dirs.push(root);
  const deps = f.deps ?? { good: "1.0.0" };
  put(root, "package.json", JSON.stringify({ name: "x", dependencies: deps }));
  put(
    root,
    "licenses/allowlist.yaml",
    `schemaVersion: 1
allowedLicenses: [MIT, ISC]
forbiddenPackages: [openai]
scanExclude: []
packages:
  - { name: good, version: "1.0.0", license: MIT, approvedBy: t, approvedOn: "2026-01-01", allowedModes: [runtime] }
exceptions: []
`,
  );
  if (f.approvals) put(root, "licenses/upstream-approvals.yaml", f.approvals);
  if (f.provenance !== false) put(root, "docs/third-party/PROVENANCE.md", "# register\n");
  for (const p of f.installed ?? [{ name: "good", version: "1.0.0", license: "MIT" }])
    put(root, `node_modules/${p.name}/package.json`, JSON.stringify(p));
  for (const [rel, text] of Object.entries(f.sources ?? {})) put(root, rel, text);
  return root;
}

const codes = (root: string) => runLicenseCheck({ root }).findings.map((x) => x.code);

describe("license gate", () => {
  test("clean fixture passes", () => {
    expect(runLicenseCheck({ root: fixture() })).toMatchObject({ ok: true, findings: [] });
  });
  test("new unapproved dependency is blocked", () => {
    const root = fixture({
      deps: { good: "1.0.0", sneaky: "2.0.0" },
      installed: [
        { name: "good", version: "1.0.0", license: "MIT" },
        { name: "sneaky", version: "2.0.0", license: "MIT" },
      ],
    });
    expect(codes(root)).toContain("unapproved-dependency");
  });
  test("version drift from approved record is blocked", () => {
    expect(codes(fixture({ deps: { good: "1.0.1" } }))).toContain("unapproved-dependency");
  });
  test("range specifiers are blocked", () => {
    expect(codes(fixture({ deps: { good: "^1.0.0" } }))).toContain("unpinned-dependency");
  });
  test("forbidden inference SDK is blocked even as transitive install", () => {
    const root = fixture({ installed: [{ name: "good", version: "1.0.0", license: "MIT" }, { name: "openai", version: "9.0.0", license: "MIT" }] });
    expect(codes(root)).toContain("forbidden-package");
  });
  test("disallowed or unknown transitive license is blocked", () => {
    const root = fixture({ installed: [{ name: "good", version: "1.0.0", license: "MIT" }, { name: "gpl", version: "1.0.0", license: "GPL-3.0-only" }] });
    expect(codes(root)).toContain("disallowed-license");
    const unknown = fixture({ installed: [{ name: "good", version: "1.0.0", license: "" }] });
    expect(codes(unknown)).toContain("disallowed-license");
  });
  test("missing install fails closed", () => {
    expect(codes(fixture({ installed: [] }))).toContain("missing-install");
  });
  test("missing provenance register fails", () => {
    expect(codes(fixture({ provenance: false }))).toContain("missing-provenance");
  });
  test("upstream source reference/import fails; exact-hash approval passes", () => {
    const text = '// copied from github.com/ski043/marshal-factory\nexport const x = 1;\n';
    const root = fixture({ sources: { "packages/a/src/x.ts": text } });
    expect(codes(root)).toContain("upstream-source");
    const sha = createHash("sha256").update(text).digest("hex");
    const approved = fixture({
      sources: { "packages/a/src/x.ts": text },
      approvals: `schemaVersion: 1\napprovals:\n  - { path: packages/a/src/x.ts, sha256: ${sha}, upstream: u, upstreamCommit: ${"a".repeat(40)}, license: MIT, approvedBy: legal }\n`,
    });
    expect(codes(approved)).not.toContain("upstream-source");
    // content changed after approval -> approval no longer applies
    put(approved, "packages/a/src/x.ts", text + "// edit\n");
    expect(codes(approved)).toContain("upstream-source");
  });
  test("vendored upstream directory and direct inference SDK import fail", () => {
    const root = fixture({ sources: { "packages/a/vendor/z.txt": "x", "apps/api/src/m.ts": 'import OpenAI from "openai";\n' } });
    expect(codes(root)).toEqual(expect.arrayContaining(["upstream-vendoring", "inference-sdk-import"]));
  });
  test("invalid allowlist fails closed", () => {
    const root = fixture();
    put(root, "licenses/allowlist.yaml", "schemaVersion: 2\n");
    expect(codes(root)).toEqual(["invalid-config"]);
  });
});

describe("spdx", () => {
  const allowed = new Set(["MIT", "ISC"]);
  test("expressions", () => {
    expect(spdxAllowed("MIT", allowed)).toBe(true);
    expect(spdxAllowed("(MIT OR GPL-3.0)", allowed)).toBe(true);
    expect(spdxAllowed("MIT AND GPL-3.0", allowed)).toBe(false);
    expect(spdxAllowed("GPL-3.0", allowed)).toBe(false);
    expect(spdxAllowed("((MIT", allowed)).toBe(false);
    expect(spdxAllowed(undefined, allowed)).toBe(false);
  });
});
