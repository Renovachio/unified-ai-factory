import { existsSync, realpathSync, statSync, accessSync, constants } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";

export type LocalFolder = { ok: true; path: string; name: string; isGit: boolean; id: string; missing?: boolean } | { ok: false; reason: string };

/** Places a project must never be rooted at or inside: the filesystem root, system trees, and credential stores. A project is a folder the factory may later read and change. */
const FORBIDDEN_TREES = ["/System", "/usr", "/bin", "/sbin", "/etc", "/private", "/var", "/dev", "/Library", "/Applications", "/opt", "/cores", "/Volumes"];
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker", ".npmrc", ".netrc", "Library", ".Trash"];
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Validate a user-supplied folder for use as a LOCAL project. Pure with respect to the database; reads the filesystem only to resolve and inspect.
 * Symlinks are resolved first, so a link into a forbidden place is judged by where it really points. The resolved real path is the project's identity.
 */
export function validateLocalFolder(input: string, o: { cwd?: string; home?: string; dispatchHome?: string; allowMissing?: boolean } = {}): LocalFolder {
  const home = o.home ?? homedir(); const cwd = o.cwd ?? process.cwd();
  if (typeof input !== "string" || input.trim() === "" || input.length > 1024 || input.includes("\0")) return { ok: false, reason: "not a valid folder path" };
  let raw = input.trim();
  if (raw === "~") raw = home; else if (raw.startsWith("~/")) raw = join(home, raw.slice(2));
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  let real: string; let missing = false; let writeCheck = "";
  if (!existsSync(abs)) {
    if (!o.allowMissing) return { ok: false, reason: `no such folder: ${abs}` };
    // A folder to be created: judge the path it WOULD have, by resolving its nearest existing ancestor (symlinks included) and re-appending the rest.
    let anc = abs; const rest: string[] = [];
    while (!existsSync(anc)) { const parent = resolve(anc, ".."); if (parent === anc) return { ok: false, reason: "no existing parent folder" }; rest.unshift(basename(anc)); anc = parent; }
    let ancReal: string; try { ancReal = realpathSync(anc); } catch { return { ok: false, reason: "cannot resolve parent folder" }; }
    try { if (!statSync(ancReal).isDirectory()) return { ok: false, reason: `${anc} is a file, so a folder cannot be created inside it` }; } catch { return { ok: false, reason: "cannot read parent folder" }; }
    real = join(ancReal, ...rest); missing = true; writeCheck = ancReal;
  } else {
    try { real = realpathSync(abs); } catch { return { ok: false, reason: "cannot resolve folder" }; }
    let st; try { st = statSync(real); } catch { return { ok: false, reason: "cannot read folder" }; }
    if (!st.isDirectory()) return { ok: false, reason: "that is a file, not a folder" };
    try { accessSync(real, constants.R_OK | constants.X_OK); } catch { return { ok: false, reason: "the folder is not readable by you" }; }
  }
  const realHome = existsSync(home) ? realpathSync(home) : home;
  if (real === "/" ) return { ok: false, reason: "refusing the filesystem root" };
  if (real === realHome) return { ok: false, reason: "refusing your whole home folder; choose a specific project folder inside it" };
  // System trees are off limits, except STRICTLY INSIDE this user's temp directory (e.g. throw-away projects); the temp directory itself and its parents stay refused.
  let tmpReal = ""; try { tmpReal = realpathSync(tmpdir()); } catch { /* no temp dir */ }
  const strictlyInTmp = tmpReal !== "" && real !== tmpReal && inside(real, tmpReal);
  if (!inside(real, realHome) && !strictlyInTmp && FORBIDDEN_TREES.some((t) => inside(real, t))) return { ok: false, reason: "refusing a system folder" };
  for (const d of SECRET_DIRS) if (inside(real, join(realHome, d))) return { ok: false, reason: `refusing ${d}: it holds credentials or application data` };
  const dh = o.dispatchHome; if (dh && existsSync(dh) && inside(real, realpathSync(dh))) return { ok: false, reason: "refusing Dispatch's own data folder" };
  if (inside(realHome, real)) return { ok: false, reason: "refusing a folder that contains your home folder" };
  if (writeCheck) { try { accessSync(writeCheck, constants.W_OK | constants.X_OK); } catch { return { ok: false, reason: `you cannot create folders inside ${writeCheck}` }; } } // after the policy rules, so a forbidden place is named as forbidden
  return { ok: true, path: real, name: basename(real) || real, isGit: !missing && existsSync(join(real, ".git")), id: createHash("sha256").update(real).digest("hex").slice(0, 32), ...(missing ? { missing: true } : {}) };
}
