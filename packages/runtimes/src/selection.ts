import { InferenceSourcePolicy } from "./policy";
import { PolicyViolation } from "@factory/sandboxes";
import { checkQualification, CRITICAL_ROLES, type QualificationRegistry } from "./qualification";
import type { RuntimeRecord } from "./discovery";

/** Operator-visible block reasons (existing blocked state + reason; no new job state is introduced). */
export type BlockReason = "RUNTIME_UNAVAILABLE" | "PROVIDER_NOT_APPROVED" | "MODEL_NOT_QUALIFIED" | "INFERENCE_POLICY_DENIED" | "SANDBOX_NOT_ENFORCED";

export interface SelectionCandidate {
  adapterId: string;
  authMode: "subscription_cli" | "local_model";
  modelId: string;
  promptVersion: string;
  toolsetDigest: string;
  endpoints?: string[];
  /** Discovery record for CLI/engine runtimes. */
  discovered?: RuntimeRecord;
}
export interface SelectionInput {
  role: string;
  candidates: SelectionCandidate[];
  policy: InferenceSourcePolicy;
  qualification: QualificationRegistry;
  env: Readonly<Record<string, string | undefined>>;
  /** Result of the sandbox enforcement self-test (fail closed when false). */
  sandboxEnforced: boolean;
  now?: Date;
}
export interface SelectionDecision {
  selected: SelectionCandidate | null;
  blockReason?: BlockReason;
  /** One audit line per check per candidate, in evaluation order. */
  log: string[];
}

/**
 * Ordered checks: installed -> usage permitted -> role qualified -> sandbox authorised -> no metered inference -> logged.
 * The FIRST candidate passing every check wins. If a role is critical only a qualified candidate can ever win; there is no silent fallback.
 */
export function selectRuntime(i: SelectionInput): SelectionDecision {
  const log: string[] = [];
  let worst: BlockReason = "RUNTIME_UNAVAILABLE";
  const rank: BlockReason[] = ["RUNTIME_UNAVAILABLE", "PROVIDER_NOT_APPROVED", "MODEL_NOT_QUALIFIED", "SANDBOX_NOT_ENFORCED", "INFERENCE_POLICY_DENIED"];
  const note = (r: BlockReason) => { if (rank.indexOf(r) > rank.indexOf(worst)) worst = r; };
  if (i.candidates.length === 0) log.push("no candidate runtimes configured");
  for (const c of i.candidates) {
    const tag = `${c.adapterId}/${c.modelId}`;
    if (c.authMode === "subscription_cli" || c.discovered) {
      if (!c.discovered?.found || !c.discovered.version) { log.push(`${tag}: RUNTIME_UNAVAILABLE (${c.discovered?.detail ?? "no discovery record"})`); continue; }
    }
    // metered inference / forbidden env / endpoint policy and provider terms are both enforced by the central policy
    try {
      i.policy.check({ adapterId: c.adapterId, authMode: c.authMode, env: i.env, ...(c.endpoints ? { endpoints: c.endpoints } : {}), ...(c.discovered?.executablePath && c.discovered.version ? { executable: { path: c.discovered.executablePath, version: c.discovered.version } } : {}), ...(i.now ? { now: i.now } : {}) });
    } catch (e) {
      const code = e instanceof PolicyViolation ? e.code : "policy";
      const reason: BlockReason = code === "terms-not-approved" ? "PROVIDER_NOT_APPROVED" : code === "executable-not-allowlisted" || code === "version-unsupported" ? "RUNTIME_UNAVAILABLE" : "INFERENCE_POLICY_DENIED";
      log.push(`${tag}: ${reason} (${code})`); note(reason); continue;
    }
    if ((CRITICAL_ROLES as readonly string[]).includes(i.role)) {
      const q = checkQualification(i.qualification, { adapterId: c.adapterId, modelId: c.modelId, role: i.role, promptVersion: c.promptVersion, toolsetDigest: c.toolsetDigest }, i.now);
      if (!q.ok) { log.push(`${tag}: MODEL_NOT_QUALIFIED (${q.reasons.join("; ")})`); note("MODEL_NOT_QUALIFIED"); continue; }
    }
    if (!i.sandboxEnforced) { log.push(`${tag}: SANDBOX_NOT_ENFORCED`); note("SANDBOX_NOT_ENFORCED"); continue; }
    log.push(`${tag}: selected for ${i.role}`);
    return { selected: c, log };
  }
  return { selected: null, blockReason: worst, log };
}
