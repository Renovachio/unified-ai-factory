import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { loadAllowlist, UpstreamApprovalsSchema, type Allowlist, type UpstreamApprovals } from "./allowlist";
import { spdxAllowed } from "./spdx";

export interface Finding {
  code:
    | "unpinned-dependency"
    | "unapproved-dependency"
    | "forbidden-package"
    | "disallowed-license"
    | "missing-install"
    | "upstream-source"
    | "upstream-vendoring"
    | "inference-sdk-import"
    | "missing-provenance"
    | "invalid-config";
  subject: string;
  message: string;
}

export interface SbomComponent {
  name: string;
  version: string;
  license: string;
}

export interface LicenseReport {
  ok: boolean;
  findings: Finding[];
  components: SbomComponent[];
}

const SOURCE_DIRS = ["apps", "packages", "config", "scripts", "prompts", "migrations", "tests"];
const UPSTREAM_MARKERS = [/marshal[-_ ]?factory/i, /zazencodes/i, /\bski043\b/i, /software-factory-claude-code/i];
const SDK_IMPORT = /(?:from\s+|require\()\s*["'](@anthropic-ai\/[^"']*|openai|@google\/generative-ai|@google\/genai|cohere-ai|@mistralai\/[^"']*)["']/;
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|sh|py|sql|toml|css|html)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

const posix = (p: string) => p.split(sep).join("/");

function globToRegex(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp("^" + esc + "$");
}

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  license?: unknown;
  licenses?: unknown;
  name?: string;
  version?: string;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function licenseOf(pkg: Pkg): string | undefined {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && "type" in pkg.license) return String((pkg.license as { type: unknown }).type);
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map((l: unknown) => (typeof l === "object" && l && "type" in l ? String((l as { type: unknown }).type) : undefined));
    if (ids.length && ids.every(Boolean)) return ids.join(" OR ");
  }
  return undefined;
}

function workspaceManifests(root: string): string[] {
  const out = [join(root, "package.json")];
  for (const group of ["apps", "packages"]) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const name of readdirSync(g)) {
      const p = join(g, name, "package.json");
      if (existsSync(p)) out.push(p);
    }
  }
  return out.filter(existsSync);
}

function installedPackages(root: string): Array<{ name: string; version: string; pkg: Pkg }> {
  const nm = join(root, "node_modules");
  const found = new Map<string, { name: string; version: string; pkg: Pkg }>();
  const add = (dir: string) => {
    const pkg = readJson<Pkg>(join(dir, "package.json"));
    if (pkg?.name && pkg.version) found.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, pkg });
  };
  const scanNm = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) {
        for (const sub of readdirSync(join(dir, name))) add(join(dir, name, sub));
      } else add(join(dir, name));
    }
  };
  scanNm(nm);
  const bunStore = join(nm, ".bun");
  if (existsSync(bunStore)) for (const entry of readdirSync(bunStore)) scanNm(join(bunStore, entry, "node_modules"));
  return [...found.values()].filter((p) => !p.name.startsWith("@factory/"));
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface CheckOptions {
  root: string;
  allowlistPath?: string;
  upstreamApprovalsPath?: string;
}

export function runLicenseCheck(opts: CheckOptions): LicenseReport {
  const { root } = opts;
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  let allow: Allowlist;
  try {
    allow = loadAllowlist(opts.allowlistPath ?? join(root, "licenses/allowlist.yaml"));
  } catch (e) {
    return { ok: false, findings: [{ code: "invalid-config", subject: "licenses/allowlist.yaml", message: String(e) }], components: [] };
  }
  const allowedLicenses = new Set(allow.allowedLicenses);
  const forbidden = new Set(allow.forbiddenPackages);

  // 1. Provenance register
  const prov = join(root, "docs/third-party/PROVENANCE.md");
  if (!existsSync(prov) || readFileSync(prov, "utf8").trim().length === 0) {
    add({ code: "missing-provenance", subject: "docs/third-party/PROVENANCE.md", message: "provenance register missing or empty" });
  }
  if (existsSync(join(root, ".gitmodules"))) {
    add({ code: "upstream-vendoring", subject: ".gitmodules", message: "git submodules are prohibited until legal approval" });
  }

  // 2. Direct dependencies: pinned, approved, not forbidden
  const approved = new Map(allow.packages.map((p) => [`${p.name}@${p.version}`, p]));
  for (const manifest of workspaceManifests(root)) {
    const rel = posix(relative(root, manifest));
    const pkg = readJson<Pkg>(manifest);
    if (!pkg) {
      add({ code: "invalid-config", subject: rel, message: "unreadable package.json" });
      continue;
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (name.startsWith("@factory/") || spec.startsWith("workspace:")) continue;
        const subject = `${rel}:${name}@${spec}`;
        if (forbidden.has(name)) add({ code: "forbidden-package", subject, message: `${name} is forbidden (metered inference / prohibited)` });
        if (!EXACT.test(spec)) {
          add({ code: "unpinned-dependency", subject, message: "dependency must be an exact version" });
          continue;
        }
        const rec = approved.get(`${name}@${spec}`);
        if (!rec) add({ code: "unapproved-dependency", subject, message: `${name}@${spec} is not in licenses/allowlist.yaml` });
        else if (!spdxAllowed(rec.license, allowedLicenses))
          add({ code: "disallowed-license", subject, message: `approval record license ${rec.license} is not allowed` });
      }
    }
  }

  // 3. Installed (transitive) licenses
  const installed = installedPackages(root);
  const components: SbomComponent[] = [];
  if (installed.length === 0) {
    add({ code: "missing-install", subject: "node_modules", message: "no installed packages found; run a frozen install before the license check" });
  }
  const exceptionRes = allow.exceptions.map((e) => globToRegex(e.name));
  for (const { name, version, pkg } of installed.sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version))) {
    const license = licenseOf(pkg);
    components.push({ name, version, license: license ?? "UNKNOWN" });
    const subject = `${name}@${version}`;
    if (forbidden.has(name)) add({ code: "forbidden-package", subject, message: `${name} is forbidden` });
    if (!spdxAllowed(license, allowedLicenses) && !exceptionRes.some((r) => r.test(name)))
      add({ code: "disallowed-license", subject, message: `license ${license ?? "UNKNOWN"} is not allowlisted` });
  }

  // 4. Source scan for upstream copies and inference SDK imports
  let approvals: UpstreamApprovals = { schemaVersion: 1, approvals: [] };
  const apPath = opts.upstreamApprovalsPath ?? join(root, "licenses/upstream-approvals.yaml");
  if (existsSync(apPath)) {
    try {
      approvals = UpstreamApprovalsSchema.parse(parse(readFileSync(apPath, "utf8")));
    } catch (e) {
      add({ code: "invalid-config", subject: "licenses/upstream-approvals.yaml", message: String(e) });
    }
  }
  const excludes = allow.scanExclude.map(globToRegex);
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = posix(relative(root, file));
      if (excludes.some((r) => r.test(rel))) continue;
      if (/(^|\/)vendor\//.test(rel)) add({ code: "upstream-vendoring", subject: rel, message: "vendored code is prohibited without approval" });
      if (!TEXT_EXT.test(rel) || statSync(file).size > 1_000_000) continue;
      const text = readFileSync(file, "utf8");
      const digest = createHash("sha256").update(text).digest("hex");
      const hasApproval = approvals.approvals.some((a) => a.path === rel && a.sha256 === digest);
      if (UPSTREAM_MARKERS.some((m) => m.test(text) || m.test(rel)) && !hasApproval)
        add({ code: "upstream-source", subject: rel, message: "references or appears copied from an upstream project without an approval record for this exact content hash" });
      if (SDK_IMPORT.test(text)) add({ code: "inference-sdk-import", subject: rel, message: "direct model-inference SDK import is forbidden" });
    }
  }

  return { ok: findings.length === 0, findings, components };
}

export function generateSbom(components: SbomComponent[]): unknown {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    components: components.map((c) => ({
      type: "library",
      name: c.name,
      version: c.version,
      purl: `pkg:npm/${c.name.replace("@", "%40")}@${c.version}`,
      licenses: [{ expression: c.license }],
    })),
  };
}
