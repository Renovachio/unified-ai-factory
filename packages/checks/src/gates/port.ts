import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Sql } from "@factory/db";
import type { FileArtifactStore, GatePort, JobCtx } from "@factory/orchestrator";
import { buildSandboxEnv, createWorkspace, teardownWorkspace, type SandboxBackend } from "@factory/sandboxes";
import { fetchWorkspaceRepo } from "@factory/scm";
import { digestOf } from "@factory/telemetry";
import { EvidenceSigner, verifyEvidence, type GateEvidence, type SignedEvidence } from "./evidence";
import { checkDefiningChanges, loadLockedManifest, ManifestTampered } from "./manifest";
import { runGates } from "./runner";

export interface GatePortDeps {
  sql: Sql;
  store: FileArtifactStore;
  signer: EvidenceSigner;
  configDir: string;
  profile: string;
  backend: SandboxBackend;
  workspaceRoot: string;
  remoteFor: (repositoryId: string) => Promise<{ url: string; allowLocalRemote?: boolean }>;
  tokenFor?: (repositoryId: string) => Promise<string | undefined>;
  /** Pinned executables the manifest may name. Defaults to the current bun (real path). */
  executables?: Record<string, string>;
  repoName?: (repositoryId: string) => Promise<string>;
}

/** Files changed by the job's candidates (from the immutable candidate descriptors). */
async function changedFiles(d: GatePortDeps, jobId: string): Promise<string[]> {
  const rows = await d.sql<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${jobId} AND (kind ~ '^build\\.r[0-9]+\\.json$' OR kind ~ '^test-plan\\.r[0-9]+\\.json$')`;
  const files = new Set<string>();
  for (const r of rows) {
    try { for (const f of (JSON.parse(d.store.get(r.digest).toString("utf8")) as { files?: Array<{ path: string }> }).files ?? []) files.add(f.path); } catch { /* unreadable descriptor: treated as no info; evidence still binds to SHA */ }
  }
  return [...files];
}

/** Classes that must go straight to a human instead of burning automated fix attempts. */
export const ESCALATE_IMMEDIATELY: readonly string[] = ["manifest-mismatch", "checks-tampered", "head-mismatch"];

export function createGatePort(d: GatePortDeps): GatePort {
  const bunPath = realpathSync(process.execPath);
  const executables = d.executables ?? { bun: bunPath };
  return {
    async run(job: JobCtx, headSha: string, baseSha: string) {
      let loaded;
      try {
        loaded = loadLockedManifest(d.configDir, d.profile);
      } catch (e) {
        // Altered, unpinned, malformed or non-allowlisted manifest: fail closed, never run anything, never pass.
        const configDigest = e instanceof ManifestTampered ? e.actual : digestOf({ invalid: String(e).slice(0, 200) });
        return { verdict: "error" as const, configDigest, resultsDigest: digestOf({ error: "manifest-mismatch", head: headSha }), failureClass: "manifest-mismatch" };
      }
      const { manifest, digest } = loaded;
      const ws = createWorkspace(d.workspaceRoot, `gate-${job.id.slice(0, 8)}`);
      try {
        const remote = await d.remoteFor(job.repositoryId);
        const token = await d.tokenFor?.(job.repositoryId);
        await fetchWorkspaceRepo({ repoDir: ws.repoDir, remoteUrl: remote.url, sha: headSha, ...(token ? { token } : {}), ...(remote.allowLocalRemote ? { allowLocalRemote: true } : {}) });
        const changed = await changedFiles(d, job.id);
        const defining = checkDefiningChanges(changed, manifest.protectedPaths);
        const res = await runGates({
          manifest, repoDir: ws.repoDir, workspaceRoot: ws.root, expectedHead: headSha, backend: d.backend,
          env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), executables, readOnlyPaths: [dirname(bunPath)],
          putLog: (t) => d.store.put(t).digest,
        });
        let failureClass: string | undefined;
        let verdict: "pass" | "fail" | "error" = "pass";
        if (!res.headVerified) { verdict = "error"; failureClass = "head-mismatch"; }
        else if (defining.length > 0) { verdict = "fail"; failureClass = "checks-tampered"; }
        else if (!res.allPassed) { verdict = "fail"; failureClass = res.worktreeMutated && !res.failedStep ? "worktree-mutated" : res.failedStep; }
        const evidence: GateEvidence = {
          schema: "factory.gate-evidence/1", jobId: job.id, repo: d.repoName ? await d.repoName(job.repositoryId) : job.repositoryId, headSha, baseSha,
          manifestProfile: manifest.profile, manifestDigest: digest, steps: res.steps, verdict, ...(failureClass ? { failureClass } : {}),
          checkDefiningChanges: defining, worktreeMutated: res.worktreeMutated,
          runner: { backend: d.backend.name, os: process.platform, arch: process.arch, bun: process.versions.bun ?? "unknown" }, createdAt: new Date().toISOString(),
        };
        const signed = d.signer.sign(evidence);
        const stored = d.store.put(JSON.stringify(signed));
        await d.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status) VALUES (${job.id}, ${`gate.r${job.round}.json`}, ${stored.digest}, ${stored.uri}, ${stored.bytes}, 'clean') ON CONFLICT (job_id, kind, digest) DO NOTHING`;
        return { verdict, configDigest: digest, resultsDigest: stored.digest, ...(failureClass ? { failureClass } : {}) };
      } finally {
        teardownWorkspace(d.workspaceRoot, ws);
      }
    },
  };
}

/**
 * Independent re-verification used by the merge coordinator: finds the PASS evidence recorded for the EXACT head/base, loads it from
 * the content-addressed store (integrity-checked), verifies the signature and every binding.
 */
export async function verifyStoredGateEvidence(d: { sql: Sql; store: FileArtifactStore; publicKeyPem: string }, q: { jobId: string; headSha: string; baseSha: string; manifestDigest: string }): Promise<{ ok: boolean; reasons: string[] }> {
  const [row] = await d.sql<{ results_digest: string; verdict: string }[]>`
    SELECT results_digest, verdict FROM gate_results WHERE job_id = ${q.jobId} AND head_sha = ${q.headSha} AND base_sha = ${q.baseSha} AND gate_config_digest = ${q.manifestDigest} AND verdict = 'pass' ORDER BY created_at DESC LIMIT 1`;
  if (!row) return { ok: false, reasons: ["no-pass-evidence-for-exact-head-base-manifest"] };
  let signed: SignedEvidence;
  try { signed = JSON.parse(d.store.get(row.results_digest).toString("utf8")) as SignedEvidence; } catch (e) { return { ok: false, reasons: [`evidence-unreadable:${e instanceof Error ? e.message : "error"}`] }; }
  return verifyEvidence(signed, d.publicKeyPem, { headSha: q.headSha, baseSha: q.baseSha, manifestDigest: q.manifestDigest, jobId: q.jobId });
}
