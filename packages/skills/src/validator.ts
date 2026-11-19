import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { redactString } from "@factory/telemetry";
import { canonicalJson, digestOfJson, listTree, treeDigest, type TreeEntry } from "./digest";
import { FrontmatterError, parseSkillMd } from "./frontmatter";

export type Severity = "error" | "warning" | "info";
export interface Finding { code: string; severity: Severity; file?: string; detail: string }
export interface PermissionManifest { tools: string[]; network: string[]; writeScopes: string[]; dataClasses: string[] }
export type RuntimeName = "claude_code_cli" | "codex_cli" | "local_model";
export interface SkillManifest {
  schemaVersion: "2.2"; slug: string; version: string; digest: string;
  origin: { uri: string; type: "local" | "upload" | "git" | "catalog"; revision?: string; license?: string; licenseReview?: "approved" | "blocked" | "pending" };
  permissions: PermissionManifest;
  /** Runtimes the AUTHOR claims; nothing here is verified compatibility (see runtimeVerified). */
  runtimeCompatibility: RuntimeName[];
  dependencies: Array<{ slug: string; digest: string }>;
}
export interface ValidationPolicy {
  allowedLicenses: readonly string[];
  /** Hosts that are always denied (metered model inference). */
  deniedHosts: readonly string[];
  /** Maximum permissions this tenant policy can ever grant to a skill. */
  maxPermissions?: Partial<PermissionManifest>;
  version: string;
}
export interface LicenseReview { spdx: string; reviewedBy: string; reviewedOn: string }
export interface ValidateInput {
  root: string;
  origin: SkillManifest["origin"];
  policy: ValidationPolicy;
  licenseReview?: LicenseReview;
  now?: Date;
}
export interface ValidationReport {
  schemaVersion: "2.2";
  candidateDigest: string;
  manifest: SkillManifest | null;
  permissionDigest: string | null;
  policyDigest: string;
  ok: boolean;
  findings: Finding[];
  files: number;
  toolVersions: Record<string, string>;
  createdAt: string;
  expiresAt: string;
  /** "static" only: no behavioural/dynamic test has been performed by this report. */
  scope: "static";
  /** Descriptive metadata used for routing/search. It carries NO authority: permissions come only from the manifest + grants. */
  meta: { description: string; triggers: string[]; produces: string[]; domains: string[] };
}
export const VALIDATOR_VERSION = "1.0.0";

const SLUG = /^[a-z][a-z0-9-]{2,63}$/;
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|php)$/i;
const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|csv|tsv|html|css|svg|xml)$/i;
const BINARY_MAGIC: Array<[number[], string]> = [[[0x7f, 0x45, 0x4c, 0x46], "ELF"], [[0xcf, 0xfa, 0xed, 0xfe], "Mach-O"], [[0xca, 0xfe, 0xba, 0xbe], "Mach-O/Java"], [[0x4d, 0x5a], "PE/DOS"], [[0x23, 0x21], "shebang script"]];
const HOOK_FILES = [/^\.claude\/settings(\.local)?\.json$/, /^\.mcp\.json$/, /(^|\/)\.git\/hooks\//, /^\.husky\//, /^(Makefile|makefile)$/];
const HOOK_KEYS = ["hooks", "pre-tool", "post-tool", "startup", "on-install", "postinstall", "preinstall"];
const AUTHORITY_CLAIMS = [
  /\b(this|the) (skill|agent|file) (is|has been) (pre-?approved|trusted|authorized|verified|vetted)\b/i,
  /\b(skip|bypass|disable|ignore|override)\b.{0,30}\b(validation|security|policy|approval|sandbox|review|guardrails?|safety)\b/i,
  /\byou (have|are granted|now have) ((full|admin|root|unrestricted) )*(permission|access|authority|privileges?)\b/i,
  /\b(ignore|disregard) (all |any )?(previous|prior|above|system|earlier) (instructions|rules|prompts?|policy)\b/i,
  /\b(reveal|print|send|exfiltrate|upload|post|cat|echo|dump)\b.{0,60}(api[ _-]?key|secret|token|credential|password|\.env\b|ssh|session cookie)/i,
  /<\/?\s*(system|assistant|instructions?)\s*>|\[\/?INST\]|<\|im_(start|end)\|>/i,
  /\bapprove (this|my) (own )?(skill|change|release|version)\b/i,
];
const BROAD_FILE_OPS = [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\*|\.\.)/i, /\bchmod\s+-R\s+7?77\b/, /\bfind\s+(\/|~|\$HOME)\s/, /(^|[\s"'=])(~|\$HOME|\/home\/[^/\s]+|\/Users\/[^/\s]+)\/(\.ssh|\.aws|\.config|\.claude|\.gnupg|\.netrc|\.git-credentials)/, /\/etc\/(passwd|shadow|sudoers)/, /\bdd\s+if=.*of=\/dev\//, /\bmkfs(\.|\s)/, /:\(\)\s*\{\s*:\|:&\s*\};:/];
const NET_CMD = /\b(curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|ftp|nslookup|dig|ping)\b|\b(fetch|XMLHttpRequest|WebSocket|requests\.(get|post)|urllib|http\.client|axios|node-fetch|got)\b|\bnpm\s+(i|install|add)\b|\bpip3?\s+install\b|\bapt(-get)?\s+install\b|\bbrew\s+install\b|\bgo\s+get\b|\bcargo\s+install\b/i;
const MODEL_TOKENS = ["anthropic", "openai", "generativelanguage", "aiplatform", "openrouter", "mistral", "cohere", "together.xyz", "groq.com", "x.ai", "bedrock-runtime", "api.deepseek", "perplexity.ai", "huggingface.co/api", "replicate.com/v1"];
const MODEL_ENV = /\b(ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|MISTRAL|COHERE|OPENROUTER|TOGETHER|GROQ|AZURE_OPENAI|AWS_BEARER_TOKEN_BEDROCK|DEEPSEEK|PERPLEXITY)[A-Z_]*(KEY|TOKEN|BASE_URL|ENDPOINT|SECRET)\b/;

/** Normalises code so obfuscated hosts ('api.' + 'anthropic' + '.com', \x61nthropic, base64) still match the denied tokens. */
export function deobfuscate(src: string): string {
  let s = src.replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/["'`]\s*(\+|\.concat\(|,|\))?\s*["'`]/g, "").replace(/\$\{?[A-Za-z_]+\}?/g, "").replace(/["'`+\s]/g, "");
  const extra: string[] = [];
  for (const m of src.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)) { try { const d = Buffer.from(m[0], "base64").toString("utf8"); if (/^[\x20-\x7e]{6,}$/.test(d)) extra.push(d); } catch { /* not base64 */ } }
  return (s + " " + extra.join(" ")).toLowerCase();
}

const permsDigestInput = (p: PermissionManifest) => ({ tools: [...p.tools].sort(), network: [...p.network].sort(), writeScopes: [...p.writeScopes].sort(), dataClasses: [...p.dataClasses].sort() });
export const permissionDigest = (p: PermissionManifest): string => digestOfJson(permsDigestInput(p));
export const policyDigestOf = (p: ValidationPolicy): string => digestOfJson(p);

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : v.split(",").map((x) => x.trim()).filter(Boolean));

export function validateSkillTree(i: ValidateInput): ValidationReport {
  const now = i.now ?? new Date();
  const findings: Finding[] = [];
  const add = (code: string, severity: Severity, detail: string, file?: string) => findings.push({ code, severity, detail, ...(file ? { file } : {}) });
  const { entries, symlinks } = listTree(i.root);
  const digest = treeDigest(entries);
  for (const s of symlinks) add("SYMLINK", "error", "symbolic links are not allowed in a skill package", s);
  const byPath = new Map<string, TreeEntry>(entries.map((e) => [e.path, e]));

  let manifest: SkillManifest | null = null;
  const skillMd = byPath.get("SKILL.md");
  if (!skillMd) add("SKILL_MD_MISSING", "error", "SKILL.md is required at the package root");
  let body = ""; let fm: ReturnType<typeof parseSkillMd> | null = null;
  if (skillMd) {
    try { fm = parseSkillMd(readFileSync(join(i.root, "SKILL.md"), "utf8")); body = fm.body; } catch (e) { add("FRONTMATTER_INVALID", "error", e instanceof FrontmatterError ? e.message : "unreadable SKILL.md", "SKILL.md"); }
  }
  const perms: PermissionManifest = { tools: [], network: [], writeScopes: [], dataClasses: [] };
  if (fm) {
    const d = fm.data;
    const slug = String(d.name ?? "");
    if (!SLUG.test(slug)) add("NAME_INVALID", "error", `name must match ${SLUG} (got "${slug.slice(0, 40)}")`, "SKILL.md");
    if (typeof d.description !== "string" || d.description.length < 10) add("DESCRIPTION_MISSING", "error", "description (>= 10 chars) is required", "SKILL.md");
    perms.tools = list(d["allowed-tools"] ?? d.tools); perms.network = list(d.network); perms.writeScopes = list(d.writeScopes ?? d["write-scopes"]); perms.dataClasses = list(d.dataClasses ?? d["data-classes"]);
    for (const k of HOOK_KEYS) if (k in d) add("STARTUP_HOOK", "error", `frontmatter key "${k}" declares automatic behaviour`, "SKILL.md");
    const rt = list(d.runtimes).filter((r): r is RuntimeName => ["claude_code_cli", "codex_cli", "local_model"].includes(r));
    const unknownRt = list(d.runtimes).filter((r) => !["claude_code_cli", "codex_cli", "local_model"].includes(r));
    if (unknownRt.length) add("RUNTIME_UNKNOWN", "error", `unknown runtimes: ${unknownRt.join(", ")}`, "SKILL.md");
    if (rt.length === 0) add("RUNTIME_UNDECLARED", "error", "declare at least one runtime in `runtimes` (claude_code_cli | codex_cli | local_model); compatibility is never assumed", "SKILL.md");
    const lic = typeof d.license === "string" ? d.license : undefined;
    let licenseReview: "approved" | "blocked" | "pending" = "pending";
    if (!lic) add("LICENSE_MISSING", "error", "no license declared: metadata may be indexed but code reuse/installation is blocked pending review", "SKILL.md");
    else if (i.policy.allowedLicenses.includes(lic)) licenseReview = "approved";
    else if (i.licenseReview && i.licenseReview.spdx === lic && i.licenseReview.reviewedBy) licenseReview = "approved";
    else add("LICENSE_UNREVIEWED", "error", `license "${lic.slice(0, 40)}" is not on the allowlist and has no recorded review`, "SKILL.md");
    if (!lic && i.licenseReview?.reviewedBy) { /* a human review cannot invent a license; it still blocks */ }
    if (SLUG.test(slug)) manifest = { schemaVersion: "2.2", slug, version: typeof d.version === "string" ? d.version : "0.0.0", digest, origin: { ...i.origin, ...(lic ? { license: lic } : {}), licenseReview }, permissions: perms, runtimeCompatibility: rt, dependencies: [] };
  }
  // permission ceiling from tenant policy
  const cap = i.policy.maxPermissions;
  if (cap) for (const k of ["tools", "network", "writeScopes", "dataClasses"] as const) { const allowed = cap[k]; if (allowed) { const over = perms[k].filter((x) => !allowed.includes(x)); if (over.length) add("PERMISSION_EXCEEDS_POLICY", "error", `${k}: ${over.join(", ").slice(0, 100)} not permitted by tenant policy`, "SKILL.md"); } }

  const hasScript = entries.filter((e) => SCRIPT_EXT.test(e.path));
  for (const e of entries) {
    if (HOOK_FILES.some((r) => r.test(e.path))) add("STARTUP_HOOK", "error", "file can trigger behaviour automatically (hooks/MCP config/build file)", e.path);
    if (e.executable) add("EXEC_BIT", "error", "executable permission bit set", e.path);
    const buf = readFileSync(join(i.root, e.path));
    for (const [magic, name] of BINARY_MAGIC) if (name !== "shebang script" && magic.every((b, k) => buf[k] === b)) add("EXECUTABLE_BINARY", "error", `${name} binary content`, e.path);
    const isScript = SCRIPT_EXT.test(e.path) || (buf[0] === 0x23 && buf[1] === 0x21);
    if (isScript) add("SCRIPT_PRESENT", "info", "script: never executed by discovery/validation; needs an explicit `subprocess` grant", e.path);
    if (!isScript && !TEXT_EXT.test(e.path) && e.path !== "SKILL.md" && !/(^|\/)(LICENSE|NOTICE|README)[^/]*$/i.test(e.path)) { if (buf.includes(0)) add("UNKNOWN_BINARY", "error", "non-text file of unknown type", e.path); }
    if (buf.length === 0 || buf.includes(0)) continue;
    const text = buf.toString("utf8");
    if (redactString(text) !== text) add("SECRET_EMBEDDED", "error", "secret-like material present (redacted from report)", e.path);
    const norm = deobfuscate(text);
    const hits = [...i.policy.deniedHosts, ...MODEL_TOKENS].filter((h) => norm.includes(h.toLowerCase()));
    if (hits.length || MODEL_ENV.test(text)) add("MODEL_API_USAGE", "error", `metered model-inference reference (${[...new Set(hits)].slice(0, 3).join(", ") || "credential variable"}), including obfuscated forms`, e.path);
    if (isScript || /^```(sh|bash|zsh|python|js|ts|javascript)/m.test(text)) {
      if (NET_CMD.test(text) && perms.network.length === 0) add("NETWORK_WITHOUT_GRANT", "error", "network-capable command/library used but no `network` destinations are declared", e.path);
      for (const m of text.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)) { const host = (m[1] as string).toLowerCase(); if (!perms.network.some((n) => host === n || host.endsWith("." + n))) add("UNDECLARED_ENDPOINT", "error", `endpoint ${host} is not in the declared network allowlist`, e.path); }
      for (const re of BROAD_FILE_OPS) if (re.test(text)) { add("BROAD_FILE_OPERATION", "error", "destructive or credential-adjacent file operation", e.path); break; }
    }
    if (SCRIPT_EXT.test(e.path) && !perms.tools.includes("subprocess")) add("SCRIPT_WITHOUT_GRANT", "error", "script shipped without a `subprocess` tool grant", e.path);
    if (/package\.json$/.test(e.path)) { try { const j = JSON.parse(text) as Record<string, Record<string, string>>; for (const sect of ["dependencies", "devDependencies", "optionalDependencies"]) for (const [n, v] of Object.entries(j[sect] ?? {})) if (!/^\d+\.\d+\.\d+$/.test(v)) add("DEPENDENCY_UNPINNED", "error", `${n}@${v} is not an exact version`, e.path); for (const h of ["preinstall", "install", "postinstall", "prepare"]) if (j.scripts?.[h]) add("STARTUP_HOOK", "error", `package script "${h}" runs on install`, e.path); } catch { add("MANIFEST_INVALID", "error", "package.json is not valid JSON", e.path); } }
    if (/requirements[^/]*\.txt$/.test(e.path)) for (const l of text.split("\n")) if (l.trim() && !l.startsWith("#") && !/==\S/.test(l)) add("DEPENDENCY_UNPINNED", "error", `unpinned requirement: ${l.slice(0, 50)}`, e.path);
    if (/\.md$/i.test(e.path)) {
      const sev = (c: string) => { for (const re of AUTHORITY_CLAIMS) if (re.test(c)) return true; return false; };
      if (sev(e.path === "SKILL.md" ? body : text)) add("INJECTION_AUTHORITY_CLAIM", "error", "instruction text claims authority, asks to bypass controls, or requests secrets; skill text can never override policy", e.path);
      for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const ref = m[1] as string;
        if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("#")) continue;
        const target = normalize(join(dirname(e.path), ref)).split("\\").join("/");
        if (target.startsWith("..") || ref.startsWith("/")) add("REFERENCE_ESCAPES_PACKAGE", "error", `reference ${ref.slice(0, 60)} leaves the package`, e.path);
        else if (!byPath.has(target) && !entries.some((x) => x.path.startsWith(target + "/"))) add("REFERENCE_MISSING", "error", `referenced file ${ref.slice(0, 60)} is not in the package`, e.path);
      }
    }
  }
  void hasScript;
  const ok = !findings.some((f) => f.severity === "error");
  return {
    schemaVersion: "2.2", candidateDigest: digest, manifest, permissionDigest: manifest ? permissionDigest(manifest.permissions) : null, policyDigest: policyDigestOf(i.policy), ok, findings, files: entries.length,
    meta: { description: typeof fm?.data.description === "string" ? fm.data.description.slice(0, 400) : "", triggers: list(fm?.data.triggers).slice(0, 20), produces: list(fm?.data.produces).slice(0, 20), domains: list(fm?.data.domains).slice(0, 10) }, toolVersions: { validator: VALIDATOR_VERSION, runtime: `bun ${Bun.version}` }, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(), scope: "static",
  };
}

export interface SignedValidationReport { report: ValidationReport; keyId: string; signature: string }
export class ReportSigner {
  private readonly priv: string;
  readonly publicKeyPem: string;
  constructor(readonly keyId: string, privateKeyPem?: string) {
    if (privateKeyPem) { this.priv = privateKeyPem; this.publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }).toString(); }
    else { const k = generateKeyPairSync("ed25519"); this.priv = k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(); this.publicKeyPem = k.publicKey.export({ type: "spki", format: "pem" }).toString(); }
  }
  sign(report: ValidationReport): SignedValidationReport { return { report, keyId: this.keyId, signature: sign(null, Buffer.from(canonicalJson({ report, keyId: this.keyId })), createPrivateKey(this.priv)).toString("base64") }; }
}
export function verifyValidationReport(s: SignedValidationReport, publicKeyPem: string, expect: { digest: string; policyDigest: string; now?: Date }): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let sigOk: boolean;
  try { sigOk = verify(null, Buffer.from(canonicalJson({ report: s.report, keyId: s.keyId })), createPublicKey(publicKeyPem), Buffer.from(s.signature, "base64")); } catch { sigOk = false; }
  if (!sigOk) reasons.push("invalid signature");
  if (s.report.candidateDigest !== expect.digest) reasons.push("report is for a different digest");
  if (s.report.policyDigest !== expect.policyDigest) reasons.push("report was produced under a different policy");
  if (Date.parse(s.report.expiresAt) <= (expect.now ?? new Date()).getTime()) reasons.push("report expired");
  if (!s.report.ok) reasons.push("validation did not pass");
  return { ok: reasons.length === 0, reasons };
}
