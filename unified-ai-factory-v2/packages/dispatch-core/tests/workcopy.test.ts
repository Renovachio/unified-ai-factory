import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyChanges, changesDigest, copyProject, diffManifests, outOfScope, snapshotTree, WorkCopyError } from "../src/index";

const root = mkdtempSync(join(tmpdir(), "wc-")); let n = 0; let real = ""; let copy = "";
afterAll(() => rmSync(root, { recursive: true, force: true }));
const w = (dir: string, rel: string, body: string) => { const p = join(dir, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
beforeEach(() => {
  const d = join(root, `c${++n}`); real = join(d, "real"); copy = join(d, "copy"); mkdirSync(real, { recursive: true });
  w(real, "notes/a.txt", "alpha\n"); w(real, "notes/b.txt", "beta\n"); w(real, "keep.md", "keep\n"); w(real, ".env", "SECRET=1\n"); w(real, ".git/config", "x"); w(real, "node_modules/p/i.js", "x");
});

describe("work copy", () => {
  test("copies regular files only: secrets, .git, node_modules and symlinks are never copied", () => {
    symlinkSync("/etc/hosts", join(real, "link")); const s = copyProject(real, copy);
    expect(Object.keys(s.manifest).sort()).toEqual(["keep.md", "notes/a.txt", "notes/b.txt"]);
    expect(existsSync(join(copy, ".env"))).toBe(false); expect(existsSync(join(copy, ".git"))).toBe(false); expect(existsSync(join(copy, "link"))).toBe(false);
    expect(s.skipped).toEqual(expect.arrayContaining([".env", ".git", "node_modules", "link"]));
  });
  test("size and file-count limits refuse instead of copying a huge folder", () => {
    expect(() => snapshotTree(real, { maxFiles: 2, maxBytes: 1e9, maxFileBytes: 1e9 })).toThrow(/more than 2 files/);
    expect(() => snapshotTree(real, { maxFiles: 10, maxBytes: 5, maxFileBytes: 1e9 })).toThrow(WorkCopyError);
  });
  test("diff reports adds, edits and deletes; the digest changes with any of them", () => {
    const base = copyProject(real, copy); w(copy, "notes/a.txt", "ALPHA\n"); w(copy, "new/c.txt", "c\n"); rmSync(join(copy, "keep.md"));
    const ch = diffManifests(base.manifest, snapshotTree(copy).manifest);
    expect(ch.map((c) => `${c.kind}:${c.path}`)).toEqual(["delete:keep.md", "add:new/c.txt", "modify:notes/a.txt"].sort((a, b) => a.split(":")[1]!.localeCompare(b.split(":")[1]!)));
    expect(changesDigest(ch)).not.toBe(changesDigest(ch.slice(1)));
  });
  test("changes outside the declared write scopes are detected", () => {
    const base = copyProject(real, copy); w(copy, "notes/a.txt", "x"); w(copy, "other/z.txt", "z");
    expect(outOfScope(diffManifests(base.manifest, snapshotTree(copy).manifest), ["notes/"])).toEqual(["other/z.txt"]);
  });
});

describe("apply (the only step that touches the real folder)", () => {
  test("applies adds, edits and deletes exactly as approved", () => {
    const base = copyProject(real, copy); w(copy, "notes/a.txt", "ALPHA\n"); w(copy, "new/c.txt", "c\n"); rmSync(join(copy, "keep.md"));
    const ch = diffManifests(base.manifest, snapshotTree(copy).manifest);
    expect(applyChanges(real, copy, ch)).toEqual({ ok: true, applied: 3 });
    expect(readFileSync(join(real, "notes/a.txt"), "utf8")).toBe("ALPHA\n"); expect(readFileSync(join(real, "new/c.txt"), "utf8")).toBe("c\n"); expect(existsSync(join(real, "keep.md"))).toBe(false);
    expect(readFileSync(join(real, ".env"), "utf8")).toBe("SECRET=1\n"); // untouched
  });
  test("if you edited the original meanwhile, NOTHING is applied and the conflict is named", () => {
    const base = copyProject(real, copy); w(copy, "notes/a.txt", "ALPHA\n"); w(copy, "notes/b.txt", "BETA\n");
    const ch = diffManifests(base.manifest, snapshotTree(copy).manifest);
    w(real, "notes/a.txt", "my own newer edit\n");
    const r = applyChanges(real, copy, ch); expect(r.ok).toBe(false); if (!r.ok) expect(r.conflicts).toEqual([{ path: "notes/a.txt", reason: expect.stringContaining("changed in your folder") }]);
    expect(readFileSync(join(real, "notes/a.txt"), "utf8")).toBe("my own newer edit\n"); expect(readFileSync(join(real, "notes/b.txt"), "utf8")).toBe("beta\n"); // b not applied either
  });
  test("an add that now exists, a vanished file, and a work copy altered after approval are all conflicts", () => {
    const base = copyProject(real, copy); w(copy, "new.txt", "n\n"); rmSync(join(copy, "keep.md"));
    const ch = diffManifests(base.manifest, snapshotTree(copy).manifest);
    w(real, "new.txt", "someone else\n"); rmSync(join(real, "keep.md"));
    const r = applyChanges(real, copy, ch); expect(r.ok).toBe(false);
    const base2 = copyProject(real, join(root, `x${n}`)); w(join(root, `x${n}`), "notes/a.txt", "approved\n"); const ch2 = diffManifests(base2.manifest, snapshotTree(join(root, `x${n}`)).manifest);
    w(join(root, `x${n}`), "notes/a.txt", "tampered after approval\n"); const r2 = applyChanges(real, join(root, `x${n}`), ch2); expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.conflicts[0]?.reason).toContain("no longer matches"); expect(readFileSync(join(real, "notes/a.txt"), "utf8")).toBe("alpha\n");
  });
  test("a symlink inside the real folder, or an unsafe path, can never be written through", () => {
    const out = join(root, `outside${n}`); mkdirSync(out); symlinkSync(out, join(real, "sneaky"));
    const base = copyProject(real, copy); w(copy, "sneaky/pwn.txt", "x");
    const ch = [{ path: "sneaky/pwn.txt", kind: "add" as const, newHash: snapshotTree(copy).manifest["sneaky/pwn.txt"]! }];
    expect(base.skipped).toContain("sneaky"); expect(applyChanges(real, copy, ch).ok).toBe(false); expect(existsSync(join(out, "pwn.txt"))).toBe(false);
    for (const p of ["../escape.txt", ".git/config", ".env", "/etc/x"]) expect(applyChanges(real, copy, [{ path: p, kind: "add", newHash: "0" }]).ok).toBe(false);
    expect(existsSync(join(root, `c${n}`, "escape.txt"))).toBe(false);
  });
});
