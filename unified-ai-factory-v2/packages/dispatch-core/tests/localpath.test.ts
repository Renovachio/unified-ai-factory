import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLocalFolder } from "../src/index";

test("the temp directory and its parents are refused; only folders strictly inside it are allowed", () => {
  const t = realpathSync(tmpdir()); expect(validateLocalFolder(t, { home: "/nonexistent-home" }).ok).toBe(false); expect(validateLocalFolder(join(t, ".."), { home: "/nonexistent-home" }).ok).toBe(false);
});

let home = ""; let work = "";
beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dsp-home-"))); work = join(home, "code", "notes"); mkdirSync(join(work, ".git"), { recursive: true }); mkdirSync(join(home, ".ssh")); mkdirSync(join(home, "plain")); writeFileSync(join(home, "file.txt"), "x");
  mkdirSync(join(home, "Library/Application Support/Dispatch"), { recursive: true }); symlinkSync(join(home, ".ssh"), join(home, "innocent")); symlinkSync(work, join(home, "alias"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
const v = (p: string, extra: { dispatchHome?: string; cwd?: string } = {}) => validateLocalFolder(p, { home, ...extra });

describe("local project folders (safety)", () => {
  test("an ordinary folder is accepted; its real path is the identity; git is detected", () => {
    expect(v(work)).toMatchObject({ ok: true, path: work, name: "notes", isGit: true }); expect(v(join(home, "plain"))).toMatchObject({ ok: true, isGit: false });
  });
  test("relative, ~ and symlinked paths resolve to the same real folder (no duplicate projects)", () => {
    const a = v(work); const b = v("code/notes", { cwd: home }); const c = v(join(home, "alias")); const d = validateLocalFolder("~/code/notes", { home });
    for (const x of [b, c, d]) expect(x).toMatchObject({ ok: true, path: work }); expect(a.ok && b.ok && c.ok && a.id === b.id && b.id === c.id).toBe(true);
  });
  test("refuses root, home itself, a parent of home, system trees, credential stores, app data and Dispatch's own data", () => {
    for (const p of ["/", home, join(home, ".."), "/etc", "/usr/local", "/System", "/Library", join(home, ".ssh"), join(home, "Library")]) expect(v(p).ok).toBe(false);
    expect(v(join(home, "Library/Application Support/Dispatch"), { dispatchHome: join(home, "Library/Application Support/Dispatch") }).ok).toBe(false);
  });
  test("a symlink is judged by where it really points", () => { expect(v(join(home, "innocent"))).toMatchObject({ ok: false, reason: expect.stringContaining(".ssh") }); });
  test("files, missing paths, NUL bytes, empty and oversized input are refused", () => {
    for (const p of [join(home, "file.txt"), join(home, "nope"), "a\0b", "", "   ", "x".repeat(2000)]) expect(v(p).ok).toBe(false);
  });

  test("a missing folder is planned (not created) only with allowMissing, judged by the path it would have", () => {
    const nu = join(home, "code", "brand-new", "deep"); expect(v(nu).ok).toBe(false);
    expect(validateLocalFolder(nu, { home, allowMissing: true })).toMatchObject({ ok: true, missing: true, path: join(work, "..", "brand-new", "deep").replace(/\/notes\/\.\.\//, "/") });
    expect(validateLocalFolder(join(home, "innocent", "x"), { home, allowMissing: true }).ok).toBe(false); // symlink into ~/.ssh
    expect(validateLocalFolder(join(home, ".ssh", "new"), { home, allowMissing: true }).ok).toBe(false);
    expect(validateLocalFolder("/etc/newthing", { home, allowMissing: true }).ok).toBe(false);
    expect(validateLocalFolder(join(home, "file.txt", "sub"), { home, allowMissing: true }).ok).toBe(false); // parent is a file
    expect(validateLocalFolder(join(home, "Library", "x"), { home, allowMissing: true }).ok).toBe(false);
  });
});
