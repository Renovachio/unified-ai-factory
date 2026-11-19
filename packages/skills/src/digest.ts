import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const sha256 = (b: Uint8Array | string): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/** Deterministic JSON (sorted keys) so digests of structures never depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
export const digestOfJson = (v: unknown): string => sha256(canonicalJson(v));

export interface TreeEntry { path: string; sha256: string; size: number; executable: boolean }
/** Lists a directory tree (no symlinks allowed: they are reported, never followed). */
export function listTree(root: string): { entries: TreeEntry[]; symlinks: string[] } {
  const entries: TreeEntry[] = []; const symlinks: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name); const st = lstatSync(p); const rel = relative(root, p).split(sep).join("/");
      if (st.isSymbolicLink()) symlinks.push(rel);
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) entries.push({ path: rel, sha256: sha256(readFileSync(p)), size: st.size, executable: (st.mode & 0o111) !== 0 });
    }
  };
  walk(root);
  return { entries, symlinks };
}
/** Content address of a package: sorted (path, file digest, executable bit). Any byte, name or mode change changes the digest. */
export const treeDigest = (entries: readonly TreeEntry[]): string => digestOfJson(entries.map((e) => [e.path, e.sha256, e.executable]).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)));
