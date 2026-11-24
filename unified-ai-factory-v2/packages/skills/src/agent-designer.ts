import { digestOfJson, sha256, type TreeEntry } from "./digest";
import { permissionDigest, policyDigestOf, type Finding, type ValidationPolicy, type ValidationReport } from "./validator";

export interface CapabilityNeed {
  intentKey: string; description: string;
  /** Distinct recurring occurrences (from the gap analyzer). */
  recurrence: number;
  durableGoal: boolean; needsState: boolean; multiStep: boolean;
  toolsNeeded: string[];
  /** Existing agent that already owns this responsibility, if any. */
  overlapsOwner: string | null;
  /** A single-use formatting/transform task. */
  oneOff: boolean;
  missingConnector?: string;
}
export type Shape = "skill" | "agent" | "workflow" | "tool_adapter";
export function decideShape(n: CapabilityNeed): { shape: Shape; reasons: string[] } {
  if (n.missingConnector) return { shape: "tool_adapter", reasons: [`a connector (${n.missingConnector}) is missing; neither a skill nor an agent can supply it`] };
  if (n.overlapsOwner) return { shape: "workflow", reasons: [`responsibility is already owned by agent ${n.overlapsOwner}; extend its workflow instead of adding an overlapping agent`] };
  const missing = [!n.durableGoal && "no durable goal", !n.needsState && "no persistent state", !n.multiStep && "not multi-step", n.toolsNeeded.length === 0 && "no tools needed"].filter(Boolean) as string[];
  if (!n.oneOff && n.recurrence >= 3 && missing.length === 0) return { shape: "agent", reasons: ["durable goal, state, multi-step flow, tools and no overlapping owner: an agent is justified"] };
  return { shape: "skill", reasons: [n.oneOff ? "single-use transform: a skill is sufficient" : "does not meet every agent criterion", ...missing] };
}

/** Authority an agent can NEVER be granted by a manifest, whatever it asks for. */
export const FORBIDDEN_AUTHORITY = ["admin", "policy_write", "merge", "approve", "activate", "registry_write", "secrets_read", "benchmark_write", "grant_permission", "github_merge", "role_assign", "deploy"] as const;
const EXTERNAL_WRITE = /(:write$|_write$|_push$|_send$|_create$|_update$|_delete$)/i;
const CREDENTIAL = /(^credential|secret|token|api_key|oauth)/i;

export interface AgentManifest {
  schemaVersion: "2.2"; name: string; digest: string; purpose: string;
  skills: Array<{ slug: string; digest: string }>; tools: string[]; humanGates: string[];
  runtimeModes: Array<"subscription_cli" | "local_model">; maxRuntimeSeconds: number; dataScopes: string[];
  /** Extra, non-contract descriptive fields live OUTSIDE the digest-bound contract object in `AgentDesign`. */
}
export interface AgentDesign { manifest: AgentManifest; inputs: string[]; outputSchema: Record<string, unknown>; triggers: string[]; failureBehavior: "stop_and_report" | "retry_once_then_stop"; permissionReview: { required: boolean; tools: string[]; reasons: string[] }; denied: string[] }
export class AgentDesignError extends Error { constructor(readonly code: "FORBIDDEN_AUTHORITY" | "BAD_RUNTIME" | "NOT_JUSTIFIED" | "BAD_FIELD", m: string) { super(m); this.name = "AgentDesignError"; } }

export function buildAgentDesign(i: { name: string; purpose: string; need: CapabilityNeed; skills: Array<{ slug: string; digest: string }>; tools: string[]; inputs: string[]; outputSchema: Record<string, unknown>; triggers: string[]; dataScopes: string[]; maxRuntimeSeconds: number; runtimeModes: AgentManifest["runtimeModes"]; failureBehavior?: AgentDesign["failureBehavior"]; extraHumanGates?: string[] }): AgentDesign {
  const shape = decideShape(i.need);
  if (shape.shape !== "agent") throw new AgentDesignError("NOT_JUSTIFIED", `an agent is not justified: ${shape.shape} — ${shape.reasons.join("; ")}`);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(i.name) || i.purpose.length < 10 || i.maxRuntimeSeconds < 1 || i.maxRuntimeSeconds > 86_400) throw new AgentDesignError("BAD_FIELD", "invalid name, purpose or timeout");
  const bad = i.tools.filter((t) => (FORBIDDEN_AUTHORITY as readonly string[]).includes(t.toLowerCase()) || /^(admin|policy|merge|approve|activate)[:_.]/i.test(t));
  if (bad.length) throw new AgentDesignError("FORBIDDEN_AUTHORITY", `agents cannot hold administrator, policy, approval, activation or merge authority: ${bad.join(", ")}`);
  if (i.runtimeModes.length === 0 || i.runtimeModes.some((m) => m !== "subscription_cli" && m !== "local_model")) throw new AgentDesignError("BAD_RUNTIME", "only subscription_cli or local_model runtimes are allowed");
  const external = i.tools.filter((t) => EXTERNAL_WRITE.test(t)); const cred = i.tools.filter((t) => CREDENTIAL.test(t));
  const humanGates = [...new Set(["approve_activation", ...(external.length ? ["approve_external_write"] : []), ...(cred.length ? ["approve_credential_use"] : []), ...(i.extraHumanGates ?? [])])];
  const body = { schemaVersion: "2.2" as const, name: i.name, purpose: i.purpose, skills: [...i.skills].sort((a, b) => (a.slug < b.slug ? -1 : 1)), tools: [...new Set(i.tools)].sort(), humanGates: humanGates.sort(), runtimeModes: [...new Set(i.runtimeModes)].sort(), maxRuntimeSeconds: i.maxRuntimeSeconds, dataScopes: [...new Set(i.dataScopes)].sort() };
  const manifest: AgentManifest = { ...body, digest: digestOfJson({ ...body, inputs: i.inputs, outputSchema: i.outputSchema, triggers: i.triggers }) };
  return { manifest, inputs: i.inputs, outputSchema: i.outputSchema, triggers: i.triggers, failureBehavior: i.failureBehavior ?? "stop_and_report", permissionReview: { required: external.length + cred.length > 0, tools: [...external, ...cred], reasons: [...(external.length ? ["external-write tools need a separate permission review"] : []), ...(cred.length ? ["credential-bearing tools need a separate permission review"] : [])] }, denied: [...FORBIDDEN_AUTHORITY] };
}

/** Static report for an agent design, same shape as a skill validation report so the registry can store and approve it uniformly. */
export function validateAgentDesign(d: AgentDesign, policy: ValidationPolicy, now = new Date()): ValidationReport {
  const findings: Finding[] = [];
  const m = d.manifest;
  const add = (code: string, detail: string) => findings.push({ code, severity: "error", detail });
  if (!/^sha256:[0-9a-f]{64}$/.test(m.digest)) add("DIGEST_INVALID", "bad digest");
  if (m.humanGates.length === 0 || !m.humanGates.includes("approve_activation")) add("GATE_MISSING", "approve_activation gate is mandatory");
  if (d.permissionReview.required && !m.humanGates.includes("approve_external_write") && d.permissionReview.tools.some((t) => /write|push|send|tracker/i.test(t))) add("GATE_MISSING", "external-write needs approve_external_write");
  for (const t of m.tools) if ((FORBIDDEN_AUTHORITY as readonly string[]).includes(t.toLowerCase())) add("FORBIDDEN_AUTHORITY", t);
  const denied = new Set(policy.deniedHosts);
  for (const t of m.tools) if ([...denied].some((h) => t.toLowerCase().includes(h.toLowerCase()))) add("MODEL_API_USAGE", t);
  const perms = { tools: m.tools, network: [] as string[], writeScopes: [] as string[], dataClasses: m.dataScopes };
  return { schemaVersion: "2.2", candidateDigest: m.digest, manifest: null, permissionDigest: permissionDigest(perms), policyDigest: policyDigestOf(policy), ok: findings.length === 0, findings, files: 1,
    meta: { description: m.purpose.slice(0, 400), triggers: d.triggers.slice(0, 20), produces: [], domains: [] }, toolVersions: { validator: "agent-1.0.0" }, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(), scope: "static" };
}
/** The file list the registry stores for an agent: the manifest/design document itself, content-addressed. */
export function agentFiles(d: AgentDesign): TreeEntry[] { const doc = JSON.stringify(d); return [{ path: "agent.json", sha256: sha256(doc), size: doc.length, executable: false }]; }
