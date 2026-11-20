// Builds the installable Dispatch package: compiled single binary + dashboard + migrations + installer, with SHA256SUMS and a tarball.
// Usage: bun scripts/package-dispatch.ts [--out dist]
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DISPATCH_VERSION } from "../apps/dispatch-cli/src/version";

const root = resolve(import.meta.dir, ".."); const outIdx = process.argv.indexOf("--out");
const outBase = resolve(root, outIdx > -1 ? (process.argv[outIdx + 1] as string) : "dist");
const target = `${process.platform}-${process.arch}`; const name = `dispatch-${DISPATCH_VERSION}-${target}`; const pkg = join(outBase, name);
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) => { const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } }); if (r.status !== 0) { console.error(`FAILED: ${cmd} ${args.join(" ")}`); process.exit(1); } };

rmSync(pkg, { recursive: true, force: true }); mkdirSync(join(pkg, "bin"), { recursive: true });
console.log("1/4 dashboard (standalone build)");
run("bunx", ["next", "build"], join(root, "apps/web"), { DISPATCH_STANDALONE: "1" });
const sa = join(root, "apps/web/.next/standalone");
cpSync(join(root, "apps/web/.next/static"), join(sa, "apps/web/.next/static"), { recursive: true });
if (existsSync(join(root, "apps/web/public"))) cpSync(join(root, "apps/web/public"), join(sa, "apps/web/public"), { recursive: true });
cpSync(sa, join(pkg, "dashboard"), { recursive: true, verbatimSymlinks: true });
console.log("2/4 compiled binary");
run("bun", ["build", "--compile", join(root, "apps/dispatch-cli/src/main.ts"), "--outfile", join(pkg, "bin/dispatch")], root);
chmodSync(join(pkg, "bin/dispatch"), 0o755);
console.log("3/4 migrations + installer");
cpSync(join(root, "migrations"), join(pkg, "migrations"), { recursive: true });
cpSync(join(root, "config"), join(pkg, "config"), { recursive: true }); // read-only policy/qualification config shown by /models
cpSync(join(root, "packaging/dispatch/claude-plugin"), join(pkg, "claude-plugin"), { recursive: true }); // Claude Code plugin: planner command, tiered agents, tool server config
for (const f of ["install.sh", "uninstall.sh"]) { cpSync(join(root, "packaging/dispatch", f), join(pkg, f)); chmodSync(join(pkg, f), 0o755); }
writeFileSync(join(pkg, "VERSION"), DISPATCH_VERSION + "\n");
console.log("4/4 checksums + tarball");
const files: string[] = []; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
walk(pkg);
const sums = files.filter((f) => !f.endsWith("SHA256SUMS")).sort().map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${relative(pkg, f)}`).join("\n") + "\n";
writeFileSync(join(pkg, "SHA256SUMS"), sums);
const tgz = join(outBase, `${name}.tar.gz`); run("tar", ["-czf", tgz, "-C", outBase, name], root);
console.log(`\npackage: ${pkg}\ntarball: ${tgz}\nsha256:  ${createHash("sha256").update(readFileSync(tgz)).digest("hex")}`);
