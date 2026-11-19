import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forbiddenEnvNames, PolicyViolation } from "../env";
import { detectBackend, type SandboxBackend } from "../backends";
import { runSandboxed, type RunResult } from "../process";
import { buildSandboxEnv } from "../env";
import { createWorkspace, teardownWorkspace, type Workspace } from "../workspace";
import { signAttestation, verifyAttestation, type SignedAttestation } from "./attestation";
import type { CloudConfig } from "./config";
import { EgressPolicy } from "./egress";
import { QuotaLedger, type ResourceRequest } from "./quota";

export interface SandboxSpec { jobId: string; imageDigest: string; nonce: string; resources: ResourceRequest; labels: Record<string, string> }
export interface SandboxHandle { id: string; jobId: string; attestation: SignedAttestation }

/** Provider-neutral remote sandbox. A real provider (Modal or similar) implements this; none is implemented or verified here. */
export interface RemoteSandboxProvider {
  readonly name: string;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(h: SandboxHandle, cmd: { command: string; args: string[]; timeoutMs: number; stdin?: string }): Promise<RunResult>;
  /** Destination fetch as seen from INSIDE the sandbox (goes through the provider's egress proxy). */
  fetchFromSandbox(h: SandboxHandle, url: string): Promise<{ status: number } | { blocked: string }>;
  destroy(id: string): Promise<void>;
  /** Everything the provider still holds for a job: must be empty after teardown. */
  list(filter: { jobId?: string }): Promise<Array<{ id: string; jobId: string; createdMs: number }>>;
}

/**
 * Test double: a "cloud" that is really a local confined directory. It signs attestations with its own key, applies the egress policy to
 * fetches, strips credentials from the environment and can be told to misbehave (unsigned/stale/wrong-image attestations, host mounts).
 */
export class SimulatedCloudProvider implements RemoteSandboxProvider {
  readonly name = "simulated-cloud";
  private readonly root = mkdtempSync(join(tmpdir(), "simcloud-"));
  private readonly boxes = new Map<string, { ws: Workspace; jobId: string; createdMs: number }>();
  /** Fault injection for attestation tests. */
  misbehave: { badSignature?: boolean; staleMs?: number; hostMounts?: string[]; openNetwork?: boolean; imageDigest?: string; destroyFails?: boolean } = {};
  constructor(private readonly privateKeyPem: string, private readonly egress: EgressPolicy, private readonly backend: SandboxBackend = detectBackend(), private readonly now: () => number = Date.now) {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const id = `sbx_${randomBytes(6).toString("hex")}`;
    const ws = createWorkspace(this.root, `${id}`);
    this.boxes.set(id, { ws, jobId: spec.jobId, createdMs: this.now() });
    const att = signAttestation({
      provider: this.name, sandboxId: id, imageDigest: this.misbehave.imageDigest ?? spec.imageDigest, region: "sim-1", nonce: spec.nonce,
      issuedAtMs: this.now() - (this.misbehave.staleMs ?? 0), claims: { rootless: true, hostMounts: this.misbehave.hostMounts ?? [], networkMode: this.misbehave.openNetwork ? "open" : "egress-proxy" },
    }, this.privateKeyPem);
    if (this.misbehave.badSignature) att.signature = Buffer.from("forged").toString("base64");
    return { id, jobId: spec.jobId, attestation: att };
  }
  async exec(h: SandboxHandle, c: { command: string; args: string[]; timeoutMs: number; stdin?: string }): Promise<RunResult> {
    const b = this.boxes.get(h.id);
    if (!b) throw new Error(`unknown sandbox ${h.id}`);
    return runSandboxed({ backend: this.backend, workspaceRoot: b.ws.root, cwd: b.ws.repoDir, command: c.command, args: c.args, env: buildSandboxEnv({ home: b.ws.homeDir, tmp: b.ws.tmpDir }), timeoutMs: c.timeoutMs, ...(c.stdin !== undefined ? { stdin: c.stdin } : {}) });
  }
  async fetchFromSandbox(_h: SandboxHandle, url: string): Promise<{ status: number } | { blocked: string }> {
    const d = await this.egress.check(url);
    return d.allowed ? { status: 200 } : { blocked: d.reason };
  }
  async destroy(id: string): Promise<void> {
    if (this.misbehave.destroyFails) throw new Error("provider destroy failed");
    const b = this.boxes.get(id);
    if (!b) return; // idempotent
    teardownWorkspace(this.root, b.ws);
    this.boxes.delete(id);
  }
  async list(f: { jobId?: string }) { return [...this.boxes.entries()].filter(([, b]) => !f.jobId || b.jobId === f.jobId).map(([id, b]) => ({ id, jobId: b.jobId, createdMs: b.createdMs })); }
  /** What actually remains on disk for a sandbox (used to verify cleanup beyond the provider's own bookkeeping). */
  residue(id: string): boolean { return existsSync(join(this.root, readdirSync(this.root).find((n) => n.startsWith(id)) ?? "__none__")); }
  dirs() { return readdirSync(this.root).filter((n) => statSync(join(this.root, n)).isDirectory()); }
  stagingDir(name: string) { const d = join(this.root, name); mkdirSync(d, { recursive: true }); return d; }
  dispose() { rmSync(this.root, { recursive: true, force: true }); }
}

export class CloudDenied extends Error {
  constructor(readonly code: "disabled" | "quota" | "attestation" | "credentials" | "teardown", message: string, readonly detail?: unknown) { super(message); this.name = "CloudDenied"; }
}

export interface CloudRunInput {
  jobId: string;
  imageDigest: string;
  resources: ResourceRequest;
  command: string;
  args: string[];
  timeoutMs: number;
  stdin?: string;
  /** Environment/secret names the caller wants inside the sandbox. Credential-like names are refused. */
  env?: Record<string, string>;
  signal?: AbortSignal;
}
export interface CloudRunResult { run: RunResult; sandboxId: string; teardownVerified: true }

/**
 * Controller: disabled unless the operator enabled cloud; reserves infrastructure quota; creates a sandbox and REFUSES to run anything
 * unless its attestation verifies; refuses credential transfer; always destroys the sandbox and verifies nothing remains.
 */
export class CloudSandboxController {
  constructor(private readonly cfg: CloudConfig, private readonly provider: RemoteSandboxProvider, readonly quota: QuotaLedger, private readonly now: () => number = Date.now) {}

  async run(i: CloudRunInput): Promise<CloudRunResult> {
    if (!this.cfg.enabled) throw new CloudDenied("disabled", "cloud execution is disabled (operator opt-in required)");
    const bad = forbiddenEnvNames(i.env ?? {});
    if (bad.length) throw new CloudDenied("credentials", `credential transfer to a cloud sandbox is forbidden (${bad.join(", ")})`, { names: bad });
    if (!this.cfg.images.allowedDigests.includes(i.imageDigest)) throw new CloudDenied("attestation", "image digest is not allowlisted");
    const q = this.quota.reserve(i.resources);
    if (!q.ok) throw new CloudDenied("quota", `infrastructure quota: ${q.reason}`, { reason: q.reason });
    const started = this.now();
    const nonce = randomBytes(16).toString("hex");
    let handle: SandboxHandle | undefined;
    try {
      handle = await this.provider.create({ jobId: i.jobId, imageDigest: i.imageDigest, nonce, resources: i.resources, labels: { job: i.jobId } });
      const v = verifyAttestation(handle.attestation, { publicKeyPem: this.cfg.attestation.providerPublicKeyPem as string, allowedImageDigests: this.cfg.images.allowedDigests, nonce, sandboxId: handle.id, maxAgeSeconds: this.cfg.attestation.maxAgeSeconds, nowMs: this.now() });
      if (!v.ok) throw new CloudDenied("attestation", `sandbox attestation rejected: ${v.reasons.join(", ")}`, { reasons: v.reasons });
      const timeoutMs = Math.min(i.timeoutMs, this.cfg.limits.maxWallSecondsPerSandbox * 1000);
      const execP = this.provider.exec(handle, { command: i.command, args: i.args, timeoutMs, ...(i.stdin !== undefined ? { stdin: i.stdin } : {}) });
      const abort = new Promise<never>((_, rej) => i.signal?.addEventListener("abort", () => rej(new CloudDenied("teardown", "cancelled")), { once: true }));
      const run = await Promise.race([execP, abort]);
      return { run, sandboxId: handle.id, teardownVerified: await this.teardown(handle.id, i.jobId, q.reservationId, started) };
    } catch (e) {
      if (handle) await this.teardown(handle.id, i.jobId, q.reservationId, started).catch(() => undefined);
      else this.quota.release(q.reservationId, 0);
      throw e;
    }
  }

  private async teardown(id: string, jobId: string, reservationId: string, startedMs: number): Promise<true> {
    try {
      await this.provider.destroy(id);
      const left = await this.provider.list({ jobId });
      if (left.some((x) => x.id === id)) throw new CloudDenied("teardown", `sandbox ${id} still exists after destroy`);
      return true;
    } finally {
      this.quota.release(reservationId, (this.now() - startedMs) / 1000);
    }
  }

  /** Destroys sandboxes older than the TTL (crash recovery / leaked resources). Returns the ids removed. */
  async sweepOrphans(): Promise<string[]> {
    const ttl = this.cfg.limits.sandboxTtlSeconds * 1000;
    const removed: string[] = [];
    for (const s of await this.provider.list({})) if (this.now() - s.createdMs > ttl) { await this.provider.destroy(s.id); removed.push(s.id); }
    return removed;
  }
}

export { PolicyViolation };
