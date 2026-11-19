import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { normalizeRepoPath, protectedPathHits } from "@factory/domain";
import { SAFE_GIT_ENV, sanitizeGitDir } from "@factory/sandboxes";
import { digestOf, sha256 } from "@factory/telemetry";

const run = promisify(execFile);

export class CandidateRejected extends Error {
  constructor(readonly code: "path-outside-scope" | "forbidden-file" | "symlink-escape" | "submodule" | "too-large" | "too-many-files" | "empty" | "bad-state", message: string) {
    super(message);
    this.name = "CandidateRejected";
  }
}

const HTTPS_GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;
const FORBIDDEN_NAMES = /(^|\/)(\.gitattributes|\.gitmodules|\.git|\.gitignore|\.githooks|\.husky)(\/|$)/;

const gitEnv = (home: string, extra: Record<string, string> = {}): Record<string, string> => ({ PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", HOME: home, ...SAFE_GIT_ENV, ...extra });
const tokenEnv = (token?: string): Record<string, string> =>
  token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } : {};

async function git(repoDir: string, args: string[], env: Record<string, string>, opts: { input?: string; maxBuffer?: number } = {}): Promise<string> {
  const p = run("git", ["-C", repoDir, ...args], { env, maxBuffer: opts.maxBuffer ?? 20_000_000, timeout: 120_000, encoding: "utf8" });
  if (opts.input !== undefined) p.child.stdin?.end(opts.input);
  return (await p).stdout;
}

/**
 * Trusted-side checkout of EXACTLY `sha` into repoDir (shallow). The credential, if any, exists only in this process's git env
 * for the duration of the fetch; it is never written to the repository or visible to the sandbox.
 */
export async function fetchWorkspaceRepo(i: { repoDir: string; remoteUrl: string; sha: string; token?: string; allowLocalRemote?: boolean }): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(i.sha)) throw new CandidateRejected("bad-state", "sha must be 40 hex characters");
  if (!i.allowLocalRemote && !HTTPS_GITHUB.test(i.remoteUrl)) throw new CandidateRejected("bad-state", "remote must be https://github.com/<owner>/<repo>");
  mkdirSync(i.repoDir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "fetch-home-"));
  const base = { ...(i.allowLocalRemote ? { GIT_ALLOW_PROTOCOL: "file" } : {}) };
  const env = gitEnv(home, { ...base, ...tokenEnv(i.token) });
  const extra = i.allowLocalRemote ? ["-c", "protocol.file.allow=always"] : [];
  try {
    await git(i.repoDir, ["init", "-q"], env);
    await run("git", ["-C", i.repoDir, ...extra, "fetch", "-q", "--depth=1", "--no-tags", "--no-recurse-submodules", i.remoteUrl, i.sha], { env, timeout: 300_000, maxBuffer: 10_000_000 });
    await git(i.repoDir, ["-c", "core.hooksPath=/dev/null", "checkout", "-q", "--detach", i.sha], env);
    const head = (await git(i.repoDir, ["rev-parse", "HEAD"], env)).trim();
    if (head !== i.sha) throw new CandidateRejected("bad-state", `checked out ${head}, expected ${i.sha}`);
    sanitizeGitDir(i.repoDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export interface CommitCandidateInput {
  repoDir: string;
  parentSha: string;
  /** Exact repo-relative paths the change may touch (from the approved design). Anything else is rejected. */
  allowedPaths: readonly string[];
  message: string;
  /** Deterministic identity and timestamp so identical content yields an identical SHA. */
  identity?: { name: string; email: string };
  dateIso: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface CandidateFile { path: string; mode: string; blobSha: string; status: "A" | "M" | "D" | "R" }
export interface CommitResult {
  headSha: string;
  treeSha: string;
  parentSha: string;
  files: CandidateFile[];
  patch: Buffer;
  patchDigest: string;
  protectedHits: Array<{ path: string; level: "HIGH" | "CRITICAL" }>;
}

/**
 * Turns whatever the (untrusted) builder left in the worktree into ONE reproducible commit, or rejects it. The commit is built
 * with plumbing (add -> write-tree -> commit-tree) from an explicit, allowlisted path set; the agent never creates git objects we trust.
 */
export async function commitCandidate(i: CommitCandidateInput): Promise<CommitResult> {
  const home = mkdtempSync(join(tmpdir(), "commit-home-"));
  const id = i.identity ?? { name: "AI Factory", email: "factory@invalid.example" };
  const env = gitEnv(home, {
    GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email,
    GIT_AUTHOR_DATE: i.dateIso, GIT_COMMITTER_DATE: i.dateIso,
  });
  try {
    const root = resolve(i.repoDir);
    sanitizeGitDir(root);
    const head = (await git(root, ["rev-parse", "HEAD"], env)).trim();
    if (head !== i.parentSha) throw new CandidateRejected("bad-state", `worktree HEAD ${head} is not the expected parent ${i.parentSha}`);
    const allowed = new Set(i.allowedPaths.map((p) => normalizeRepoPath(p)).filter((p): p is string => p !== null));

    const raw = await git(root, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], env);
    const entries = raw.split("\0").filter(Boolean).map((e) => ({ xy: e.slice(0, 2), path: e.slice(3) }));
    if (entries.length === 0) throw new CandidateRejected("empty", "the builder produced no changes");
    if (entries.length > (i.maxFiles ?? 200)) throw new CandidateRejected("too-many-files", `${entries.length} changed files exceed the limit`);

    let total = 0;
    const paths: string[] = [];
    for (const e of entries) {
      const p = normalizeRepoPath(e.path);
      if (p === null || FORBIDDEN_NAMES.test(p)) throw new CandidateRejected("forbidden-file", `refusing path ${JSON.stringify(e.path)}`);
      if (!allowed.has(p)) throw new CandidateRejected("path-outside-scope", `${p} is not declared in the approved design`);
      const abs = join(root, p);
      if (/^[ MARC?]D$|^D/.test(e.xy) && !statExists(abs)) { paths.push(p); continue; }
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(abs);
        const resolved = normalize(isAbsolute(target) ? target : join(dirname(abs), target));
        if (isAbsolute(target) || relative(root, resolved).startsWith("..") || resolved.split(sep).includes(".git")) throw new CandidateRejected("symlink-escape", `${p} is a symlink that leaves the repository`);
      } else if (st.isDirectory()) {
        throw new CandidateRejected("submodule", `${p} is a nested repository or directory entry`);
      } else {
        if (st.size > (i.maxFileBytes ?? 2_000_000)) throw new CandidateRejected("too-large", `${p} is ${st.size} bytes`);
        total += st.size;
      }
      paths.push(p);
    }
    if (total > (i.maxTotalBytes ?? 10_000_000)) throw new CandidateRejected("too-large", "total changed bytes exceed the limit");

    await git(root, ["--literal-pathspecs", "add", "-A", "--", ...paths], env);
    const treeSha = (await git(root, ["write-tree"], env)).trim();
    const headSha = (await git(root, ["commit-tree", treeSha, "-p", i.parentSha, "-m", i.message], env)).trim();
    const ls = await git(root, ["-c", "core.quotepath=false", "diff-tree", "-r", "--no-renames", "-z", "--raw", i.parentSha, headSha], env);
    const parts = ls.split("\0").filter(Boolean);
    const files: CandidateFile[] = [];
    for (let k = 0; k + 1 < parts.length; k += 2) {
      const meta = (parts[k] as string).split(" "); // :oldmode newmode oldsha newsha status
      files.push({ path: parts[k + 1] as string, mode: (meta[1] ?? "").replace(":", ""), blobSha: meta[3] ?? "", status: (meta[4]?.[0] ?? "M") as CandidateFile["status"] });
    }
    for (const f of files) if (f.mode === "160000") throw new CandidateRejected("submodule", `${f.path} is a gitlink (submodule)`);
    const patch = Buffer.from(await git(root, ["diff", "--binary", "--no-color", "--no-ext-diff", i.parentSha, headSha], env, { maxBuffer: 50_000_000 }), "utf8");
    return { headSha, treeSha, parentSha: i.parentSha, files, patch, patchDigest: "sha256:" + sha256(patch.toString("utf8")), protectedHits: protectedPathHits(files.map((f) => f.path)) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const statExists = (p: string) => { try { statSync(p); return true; } catch { return false; } };

export interface CandidateDescriptor {
  schema: "factory.candidate/1";
  jobId: string; round: number; role: "builder" | "tester";
  parentSha: string; headSha: string; treeSha: string; patchDigest: string; files: CandidateFile[];
  protectedHits: Array<{ path: string; level: string }>;
}
export const descriptorDigest = (d: CandidateDescriptor) => digestOf(d);
