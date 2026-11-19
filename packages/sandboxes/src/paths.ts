import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

const inside = (base: string, p: string) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);

/**
 * Resolve `rel` under `base`, rejecting absolute paths, NUL bytes, `..` traversal and any symlink
 * (including dangling ones) that would lead outside `base`.
 */
export function resolveInside(base: string, rel: string): string {
  if (rel.includes("\0")) throw new PathEscapeError("NUL byte in path");
  if (isAbsolute(rel)) throw new PathEscapeError(`absolute path not allowed: ${rel}`);
  const realBase = realpathSync(base);
  const target = resolve(realBase, rel);
  if (!inside(realBase, target)) throw new PathEscapeError(`path escapes workspace: ${rel}`);
  let cur = target;
  for (;;) {
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      if (cur === realBase) break;
      cur = dirname(cur);
      continue;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(cur);
      } catch {
        throw new PathEscapeError(`dangling symlink in path: ${rel}`);
      }
      if (!inside(realBase, real)) throw new PathEscapeError(`symlink escapes workspace: ${rel}`);
    } else {
      const real = realpathSync(cur);
      if (!inside(realBase, real)) throw new PathEscapeError(`path escapes workspace via symlinked parent: ${rel}`);
    }
    break;
  }
  return target;
}

/** Lists every symlink under `root` whose target is outside `root` (or dangling). */
export function findEscapingSymlinks(root: string): string[] {
  const realRoot = realpathSync(root);
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        try {
          if (!inside(realRoot, realpathSync(p))) bad.push(p);
        } catch {
          bad.push(p);
        }
      } else if (st.isDirectory()) walk(p);
    }
  };
  if (existsSync(root)) walk(root);
  return bad;
}
