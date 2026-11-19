/**
 * Minimal, strict SKILL.md frontmatter reader. Deliberately NOT a YAML implementation: only `key: value` scalars and `key: [a, b]` / `- item`
 * lists are understood; anchors, tags, multi-document streams and anything else are rejected so a skill cannot smuggle behaviour through the parser.
 */
export interface Frontmatter { data: Record<string, string | string[]>; body: string }
export class FrontmatterError extends Error {}

export function parseSkillMd(text: string): Frontmatter {
  if (text.length > 200_000) throw new FrontmatterError("SKILL.md too large");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new FrontmatterError("missing YAML frontmatter block");
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of (m[1] as string).split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (/^\s*[&*!]/.test(raw) || /^[A-Za-z][\w-]*:\s*[&*!|>{]/.test(raw)) throw new FrontmatterError(`unsupported YAML construct: ${raw.slice(0, 40)}`);
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) { (data[listKey] as string[]).push(unquote((item[1] as string).trim())); continue; }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) throw new FrontmatterError(`unparseable frontmatter line: ${raw.slice(0, 40)}`);
    const key = kv[1] as string; const val = (kv[2] as string).trim();
    if (key in data) throw new FrontmatterError(`duplicate key ${key}`);
    if (val === "") { data[key] = []; listKey = key; continue; }
    listKey = null;
    data[key] = val.startsWith("[") && val.endsWith("]") ? val.slice(1, -1).split(",").map((x) => unquote(x.trim())).filter(Boolean) : unquote(val);
  }
  return { data, body: m[2] as string };
}
const unquote = (s: string) => (/^(".*"|'.*')$/.test(s) ? s.slice(1, -1) : s);
