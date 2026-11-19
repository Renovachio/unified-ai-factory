import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArchiveRejected, verifyQuarantineIntact, enumerateSkills, importArchive, importToQuarantine, InventoryError, isPrivatePath, makeWritable, previewSkillDir, type ApprovedRoot } from "../src/index";
import { makeZip } from "./zip-helper";

const base = realpathSync(mkdtempSync(join(tmpdir(), "inv-")));
afterAll(() => { makeWritable(base); rmSync(base, { recursive: true, force: true }); });
let n = 0;
const MD = (name: string) => `---\nname: ${name}\ndescription: Does a useful thing for product managers\nlicense: MIT\nruntimes: [local_model]\nallowed-tools: [Read, Grep]\nnetwork: [example.com]\n---\nUse [tpl](references/t.md) and [web](https://example.com/x).\n`;
function mkRoot(skills: Record<string, Record<string, string>>): ApprovedRoot {
  const path = join(base, `root${n++}`); mkdirSync(path, { recursive: true });
  for (const [dir, files] of Object.entries(skills)) for (const [f, c] of Object.entries(files)) { const p = join(path, dir, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
  return { id: `r${n}`, path, scope: "user", approvedBy: "u1" };
}

describe("SAI-01 inventory: read-only preview of approved roots (T-01)", () => {
  test("lists a skill's name, tools, references and scripts without running anything", () => {
    const root = mkRoot({ "pm/story": { "SKILL.md": MD("story-writer"), "references/t.md": "tpl", "scripts/run.sh": "touch /tmp/SHOULD_NOT_EXIST_" + process.pid }, "other/x": { "notes.txt": "no skill here" } });
    const found = enumerateSkills(root);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "story-writer", declaredTools: ["Read", "Grep"], declaredRuntimes: ["local_model"], declaredNetwork: ["example.com"], references: ["references/t.md"], scripts: ["scripts/run.sh"], relPath: "pm/story", license: "MIT" });
    expect(existsSync("/tmp/SHOULD_NOT_EXIST_" + process.pid)).toBe(false);
    expect(JSON.stringify(found)).not.toContain(base); // no absolute filesystem locations leak into previews
  });
  test("malformed frontmatter is reported as a problem, not thrown or guessed", () => {
    const root = mkRoot({ a: { "SKILL.md": "no frontmatter" }, b: { "SKILL.md": "---\nname: &x y\n---\n" } });
    const found = enumerateSkills(root);
    expect(found.map((f) => f.problems.length > 0)).toEqual([true, true]);
  });
});

describe("approved roots only; private and out-of-root paths are unreadable (T-04, T-28)", () => {
  test("private credential/system paths are refused even when 'approved'", () => {
    expect(isPrivatePath("/etc/ssh")).toBe(true);
    expect(isPrivatePath(join(process.env.HOME ?? "/root", ".ssh"))).toBe(true);
    expect(isPrivatePath(join(process.env.HOME ?? "/root", ".aws/x"))).toBe(true);
    expect(isPrivatePath(join(base, "ok"))).toBe(false);
    for (const p of ["/etc", join(process.env.HOME ?? "/root", ".ssh")]) {
      if (existsSync(p)) expect(() => enumerateSkills({ id: "x", path: p, scope: "user", approvedBy: "u" })).toThrow(InventoryError);
    }
  });
  test("a symlink inside the root cannot lead the scanner outside it; a symlinked root into private space is refused", () => {
    const outside = join(base, `secret${n++}`); mkdirSync(outside); writeFileSync(join(outside, "SKILL.md"), MD("leaked-skill"));
    const root = mkRoot({ ok: { "SKILL.md": MD("ok-skill") } });
    symlinkSync(outside, join(root.path, "evil"));
    const found = enumerateSkills(root);
    expect(found.map((f) => f.name)).toEqual(["ok-skill"]);
    expect(() => previewSkillDir(root, outside)).toThrow(/outside the approved root/);
    expect(() => previewSkillDir(root, join(root.path, "evil"))).toThrow(/outside the approved root/);
  });
  test("a revoked source can neither be scanned nor imported", () => {
    const root = mkRoot({ a: { "SKILL.md": MD("revokable") } });
    const revoked = { ...root, revokedAt: new Date().toISOString() };
    expect(() => enumerateSkills(revoked)).toThrow(/revoked/);
    expect(() => importToQuarantine(revoked, join(root.path, "a"), join(base, "q-rev"))).toThrow(/revoked/);
  });
});

describe("quarantine import (T-05)", () => {
  test("copies to a read-only, digest-named quarantine; a duplicate digest never rewrites the existing copy", () => {
    const root = mkRoot({ s: { "SKILL.md": MD("dup-skill"), "references/t.md": "tpl" } });
    const q = join(base, `q${n++}`);
    const a = importToQuarantine(root, join(root.path, "s"), q);
    expect(a.duplicateOf).toBeUndefined();
    expect(a.quarantineDir).toContain(a.digest.replace(":", "-"));
    expect(readFileSync(join(a.quarantineDir, "SKILL.md"), "utf8")).toBe(MD("dup-skill"));
    expect(statSync(join(a.quarantineDir, "SKILL.md")).mode & 0o222).toBe(0); // read-only
    expect(() => writeFileSync(join(a.quarantineDir, "SKILL.md"), "tamper")).toThrow();
    const b = importToQuarantine(root, join(root.path, "s"), q);
    expect(b.duplicateOf).toBe(a.digest);
    expect(statSync(join(a.quarantineDir, "SKILL.md")).mtimeMs).toBe(statSync(join(b.quarantineDir, "SKILL.md")).mtimeMs);
    makeWritable(q);
  });
  test("a changed source produces a different digest and a separate quarantine entry", () => {
    const root = mkRoot({ s: { "SKILL.md": MD("chg-skill") } });
    const q = join(base, `q${n++}`);
    const a = importToQuarantine(root, join(root.path, "s"), q);
    writeFileSync(join(root.path, "s", "SKILL.md"), MD("chg-skill") + "\nmore\n");
    const b = importToQuarantine(root, join(root.path, "s"), q);
    expect(b.digest).not.toBe(a.digest);
    expect(existsSync(a.quarantineDir) && existsSync(b.quarantineDir)).toBe(true);
    makeWritable(q);
  });
  test("packages with symlinks or without SKILL.md are not imported", () => {
    const root = mkRoot({ s: { "SKILL.md": MD("sym-skill") }, t: { "x.md": "no skill" } });
    symlinkSync("/etc/passwd", join(root.path, "s", "pw"));
    expect(() => importToQuarantine(root, join(root.path, "s"), join(base, `q${n++}`))).toThrow(/symbolic links/);
    expect(() => importToQuarantine(root, join(root.path, "t"), join(base, `q${n++}`))).toThrow(/SKILL.md missing/);
  });
  test("uploaded archives go through the hardened extractor; traversal and bombs never reach quarantine", () => {
    const q = join(base, `q${n++}`); const scratch = join(base, `sc${n++}`); mkdirSync(scratch);
    const evil = makeZip([{ name: "../../outside.txt", data: "x" }]);
    expect(() => importArchive(evil, q, scratch, "u")).toThrow(ArchiveRejected);
    expect(existsSync(join(base, "outside.txt"))).toBe(false);
    const ok = makeZip([{ name: "my-skill/SKILL.md", data: MD("zip-skill"), deflate: true }, { name: "my-skill/references/t.md", data: "tpl" }]);
    const r = importArchive(ok, q, scratch, "u");
    expect(r.preview).toMatchObject({ name: "zip-skill", files: 2 });
    expect(readdirOrEmpty(scratch)).toEqual([]); // scratch cleaned up
    makeWritable(q);
  });
});
import { readdirSync } from "node:fs";
const readdirOrEmpty = (p: string) => { try { return readdirSync(p); } catch { return []; } };
void chmodSync;

describe("TOCTOU: bytes are re-verified immediately before use", () => {
  test("a quarantined package that is altered after approval fails closed", () => {
    const root = mkRoot({ s: { "SKILL.md": MD("toctou-skill") } });
    const q = join(base, `q${n++}`);
    const imp = importToQuarantine(root, join(root.path, "s"), q);
    expect(verifyQuarantineIntact(imp.quarantineDir, imp.digest)).toEqual({ ok: true });
    makeWritable(imp.quarantineDir);
    writeFileSync(join(imp.quarantineDir, "SKILL.md"), MD("toctou-skill") + "\nevil");
    expect(verifyQuarantineIntact(imp.quarantineDir, imp.digest)).toMatchObject({ ok: false, reason: expect.stringMatching(/changed/) });
    symlinkSync("/etc/passwd", join(imp.quarantineDir, "link"));
    expect(verifyQuarantineIntact(imp.quarantineDir, imp.digest)).toMatchObject({ ok: false, reason: expect.stringMatching(/symlink/) });
    makeWritable(q);
  });
});
