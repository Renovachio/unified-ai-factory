import { appendEvent, type Sql } from "@factory/db";
import { forbiddenEnvNames } from "@factory/sandboxes";
import { digestOf, redactString } from "@factory/telemetry";

/** Credentials that may NEVER be handed to any worker (local or cloud), and that the broker never stores or issues at all. */
export const MODEL_CREDENTIAL_KINDS = ["model_api_key", "subscription_login", "cli_session_token", "oauth_refresh_token", "provider_cookie"] as const;
export const WORKER_FORBIDDEN_KINDS = [...MODEL_CREDENTIAL_KINDS, "ssh_key", "cloud_provider_token", "github_merge", "github_branch_write", "github_read", "database_url", "signing_key"] as const;

export interface WorkerIdentity { workerId: string; mode: "local" | "cloud"; orgId: string }
export type WorkerRequestOutcome = { granted: false; reason: string; workerQuarantined: boolean };

/**
 * The secret broker boundary. Workers (T3, untrusted) get NOTHING from it: repository access is mediated by trusted-side code that holds
 * the short-lived installation tokens, and model auth is provider-managed on the operator machine. A worker asking for a credential is
 * denied and audited; a worker asking for a model/login/session credential — or ANY cloud worker asking for anything — is quarantined.
 */
export class SecretBroker {
  constructor(private readonly sql: Sql, private readonly issuers: { github?: (role: "read" | "branch_write" | "merge", repo: { owner: string; name: string }) => Promise<string> } = {}) {}

  async requestForWorker(w: WorkerIdentity, kind: string, detail?: string): Promise<WorkerRequestOutcome> {
    const modelOrLogin = (MODEL_CREDENTIAL_KINDS as readonly string[]).includes(kind);
    const quarantine = modelOrLogin || w.mode === "cloud" || kind === "ssh_key" || kind === "cloud_provider_token";
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest)
        VALUES (${w.orgId}, ${`worker:${w.workerId}`}, 'secret.request', ${`credential:${kind.slice(0, 60)}`}, 'denied', ${redactString(`mode=${w.mode}${detail ? ` ${detail}` : ""}`.slice(0, 400))}, ${digestOf({ w: w.workerId, kind, at: Date.now() })})`;
      if (quarantine) {
        await tx`UPDATE workers SET status = 'quarantined' WHERE id = ${w.workerId}`;
        // Expire its leases immediately: the scheduler requeues them with a new fencing token, so this worker is fenced out.
        await tx`UPDATE tasks SET lease_expiry = now() - interval '1 second' WHERE lease_owner = ${w.workerId} AND status IN ('leased','running')`;
        await tx`INSERT INTO audit_entries (organization_id, actor, action, resource, result, reason, digest)
          VALUES (${w.orgId}, 'secret-broker', 'worker.quarantine', ${`worker:${w.workerId}`}, 'ok', ${`requested ${kind.slice(0, 60)} (${w.mode})`}, ${digestOf({ q: w.workerId, kind })})`;
        const jobs = await tx<{ job_id: string }[]>`SELECT DISTINCT job_id FROM tasks WHERE lease_owner = ${w.workerId} OR assigned_worker_id = ${w.workerId}`;
        for (const j of jobs) await appendEvent(tx, { jobId: j.job_id, type: "security.quarantined", source: "secret-broker", payload: { worker_id: w.workerId, reason: "credential-request", kind } });
      }
    });
    return { granted: false, reason: "workers are never issued credentials", workerQuarantined: quarantine };
  }

  /** Control-plane only (no worker-facing route exists). Model credentials are never issued or stored here. */
  async issueGithubToken(role: "read" | "branch_write" | "merge", repo: { owner: string; name: string }): Promise<string> {
    if (!this.issuers.github) throw new Error("no GitHub issuer configured");
    return this.issuers.github(role, repo);
  }
  async issue(kind: string): Promise<never> {
    if ((MODEL_CREDENTIAL_KINDS as readonly string[]).includes(kind)) throw new Error("model API keys and login/session credentials are not supported and are never stored or issued by the broker");
    throw new Error(`unsupported credential kind ${kind}`);
  }
}

/** Refuses to send anything credential-shaped into a worker/sandbox payload (task inputs, env, file manifests). */
export function assertPayloadClean(payload: unknown, label = "payload"): void {
  const s = JSON.stringify(payload) ?? "";
  if (redactString(s) !== s) throw new Error(`${label} contains secret-like material and was not sent`);
  const names = new Set<string>();
  const walk = (v: unknown, d = 0) => { if (d > 8 || !v || typeof v !== "object") return; for (const [k, x] of Object.entries(v as Record<string, unknown>)) { names.add(k); walk(x, d + 1); } };
  walk(payload);
  const bad = forbiddenEnvNames(Object.fromEntries([...names].map((n) => [n, "x"])));
  if (bad.length) throw new Error(`${label} contains credential-like field names (${bad.join(", ")})`);
}
