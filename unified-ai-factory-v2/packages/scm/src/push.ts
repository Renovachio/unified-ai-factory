import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SAFE_GIT_ENV, sanitizeGitDir } from "@factory/sandboxes";
import { FACTORY_BRANCH } from "./client";

const run = promisify(execFile);

export class PushRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRefused";
  }
}

export interface PushInput {
  repoDir: string;
  remoteUrl: string;
  branch: string; // factory/<job>
  sha: string;
  /** Short-lived branch_write installation token. Supplied by the control plane; never present in the sandbox. */
  token?: string;
  /** Tests only: permit file:// or local-path remotes. */
  allowLocalRemote?: boolean;
}

const HTTPS_GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

/**
 * Trusted-side push of an exact commit to factory/<job>. Runs OUTSIDE the sandbox (the sandbox holds no credential).
 * Never forces, never deletes, never targets anything but refs/heads/factory/*, and re-sanitizes the untrusted repo
 * (hooks, config) before invoking git.
 */
export async function pushFactoryBranch(input: PushInput): Promise<{ pushed: boolean }> {
  if (!FACTORY_BRANCH.test(input.branch)) throw new PushRefused(`refusing to push to non-factory branch: ${input.branch}`);
  if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new PushRefused("sha must be a full 40-hex commit id");
  if (!input.allowLocalRemote && !HTTPS_GITHUB.test(input.remoteUrl)) throw new PushRefused("remote must be https://github.com/<owner>/<repo>");
  sanitizeGitDir(input.repoDir);
  const home = mkdtempSync(join(tmpdir(), "push-home-"));
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: home, ...SAFE_GIT_ENV,
    ...(input.allowLocalRemote ? { GIT_ALLOW_PROTOCOL: "file" } : {}),
    ...(input.token
      ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}` }
      : {}),
  };
  try {
    const git = (args: string[]) => run("git", ["-C", input.repoDir, ...args], { env, timeout: 120_000, maxBuffer: 1_000_000 });
    let kind = "";
    try {
      kind = (await git(["cat-file", "-t", input.sha])).stdout.trim();
    } catch {
      throw new PushRefused("sha does not exist in the repository");
    }
    if (kind !== "commit") throw new PushRefused("sha is not a commit in the repository");
    const extra = input.allowLocalRemote ? ["-c", "protocol.file.allow=always"] : [];
    try {
      await run("git", ["-C", input.repoDir, ...extra, "push", "--porcelain", "--no-verify", "--no-recurse-submodules", input.remoteUrl, `${input.sha}:refs/heads/${input.branch}`], { env, timeout: 120_000, maxBuffer: 1_000_000 });
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? e).replace(/Authorization:[^\n]*/gi, "[REDACTED]");
      throw new PushRefused(`push rejected: ${msg.split("\n")[0]}`);
    }
    return { pushed: true };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
