import { createHash } from "node:crypto";

/** Deterministic JSON (sorted keys) so digests are stable across processes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const digestOf = (v: unknown): string => "sha256:" + sha256(canonicalJson(v));
