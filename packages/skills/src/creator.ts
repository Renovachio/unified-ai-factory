import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { listTree, treeDigest, type TreeEntry } from "./digest";
import { validateSkillTree, type PermissionManifest, type RuntimeName, type ValidationPolicy, type ValidationReport } from "./validator";

export interface SkillSpec {
  slug: string; description: string; license: string; runtimes: RuntimeName[];
  triggers: string[]; domains: string[]; produces: string[];
  /** Declared permissions; the creator never widens them and never infers any from the body. */
  permissions: PermissionManifest;
  steps: string[];
  /** Illustrative cases kept next to the skill: input/output, claims, edge cases, permission needs, provenance. */
  cases: Array<{ id: string; input: string; expectedOutputContains: string[]; claims: string[]; edge?: boolean }>;
  provenance: { gapIntentKey: string; evidenceDigests: string[]; createdFor: string };
  references?: Record<string, string>;
  /** Optional scripts: written as TEXT only, never executed here; they need `subprocess` in permissions.tools. */
  scripts?: Record<string, string>;
}
/** Pluggable body author: a deterministic template by default; callers may wire an authorised runtime. It only ever returns text. */
export type BodyAuthor = (spec: SkillSpec) => Promise<string> | string;
export const templateAuthor: BodyAuthor = (s) => `# ${s.slug}\n\nUse when: ${s.triggers.join("; ")}.\n\n## Steps\n${s.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\n## Output\nProduce: ${s.produces.join(", ")}. Cite the provenance of every nontrivial claim and list assumptions and open questions.\n`;

export class CreatorError extends Error { constructor(readonly code: "LIVE_ROOT" | "BAD_SPEC" | "NOT_ISOLATED", m: string) { super(m); this.name = "CreatorError"; } }
const q = (s: string) => (/[:#[\]{},&*!|>'"%@`]/.test(s) ? JSON.stringify(s) : s);
const list = (xs: string[]) => `[${xs.map(q).join(", ")}]`;

export interface CandidateResult { dir: string; digest: string; files: TreeEntry[]; report: ValidationReport; status: "READY_FOR_SUBMISSION" | "REJECTED_BY_VALIDATION" }

/**
 * Writes a source-only candidate into a fresh isolated directory under `workBase` and statically validates it. Nothing is executed, nothing is
 * written to a live skill root, nothing is installed. Submission to the registry (state AWAITING_APPROVAL) is a separate, explicit step.
 */
export async function createSkillCandidate(i: { spec: SkillSpec; workBase: string; liveRoots: readonly string[]; policy: ValidationPolicy; author?: BodyAuthor; origin?: { uri: string } }): Promise<CandidateResult> {
  const { spec } = i;
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(spec.slug) || spec.steps.length === 0 || spec.triggers.length === 0 || spec.cases.length === 0) throw new CreatorError("BAD_SPEC", "spec needs a valid slug, triggers, steps and at least one test case");
  mkdirSync(i.workBase, { recursive: true });
  const base = realpathSync(i.workBase);
  for (const live of i.liveRoots) { let lr: string; try { lr = realpathSync(live); } catch { lr = resolve(live); } if (base === lr || base.startsWith(lr + sep) || lr.startsWith(base + sep)) throw new CreatorError("LIVE_ROOT", "work directory overlaps a live skill root; candidates are never generated in or near live roots"); }
  const dir = mkdtempSync(join(base, `cand-${spec.slug}-`));
  const put = (rel: string, content: string) => { const p = join(dir, rel); if (!resolve(p).startsWith(dir + sep)) throw new CreatorError("NOT_ISOLATED", `path escapes work dir: ${rel}`); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content, { mode: 0o600 }); };
  const body = await (i.author ?? templateAuthor)(spec);
  const fm = ["---", `name: ${spec.slug}`, `description: ${q(spec.description)}`, `license: ${spec.license}`, `runtimes: ${list(spec.runtimes)}`, `allowed-tools: ${list(spec.permissions.tools)}`, ...(spec.permissions.network.length ? [`network: ${list(spec.permissions.network)}`] : []), ...(spec.permissions.writeScopes.length ? [`writeScopes: ${list(spec.permissions.writeScopes)}`] : []), ...(spec.permissions.dataClasses.length ? [`dataClasses: ${list(spec.permissions.dataClasses)}`] : []), `triggers: ${list(spec.triggers)}`, `domains: ${list(spec.domains)}`, `produces: ${list(spec.produces)}`, "---", ""].join("\n");
  put("SKILL.md", fm + body);
  put("tests/cases.json", JSON.stringify({ schemaVersion: 1, skill: spec.slug, cases: spec.cases, permissionRequirements: spec.permissions, provenance: spec.provenance }, null, 2) + "\n");
  for (const [p, c] of Object.entries(spec.references ?? {})) put(join("references", p), c);
  for (const [p, c] of Object.entries(spec.scripts ?? {})) { put(join("scripts", p), c); chmodSync(join(dir, "scripts", p), 0o600); }
  const report = validateSkillTree({ root: dir, origin: { uri: i.origin?.uri ?? `factory://creator/${spec.slug}`, type: "upload" }, policy: i.policy });
  const files = listTree(dir).entries;
  return { dir, digest: treeDigest(files), files, report, status: report.ok ? "READY_FOR_SUBMISSION" : "REJECTED_BY_VALIDATION" };
}
