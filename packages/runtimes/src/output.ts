import { validateReview, type ReviewerResult } from "@factory/contracts";
import { z } from "zod";
import { isReviewRole, type AgentRole } from "./types";

export class OutputRejected extends Error {
  constructor(readonly code: "schema" | "sha-mismatch" | "too-large" | "not-json", message: string) {
    super(message);
    this.name = "OutputRejected";
  }
}

export interface OutputSchemaEntry { schema: z.ZodType; hint: string }
/**
 * Explicit (non-global) registry of strict output schemas keyed by `schema://<role>`. Roles without an entry fall back to the
 * generic artifact shape, i.e. fail closed.
 */
export class SchemaRegistry {
  private readonly m = new Map<string, OutputSchemaEntry>();
  register(uri: string, entry: OutputSchemaEntry): this { this.m.set(uri, entry); return this; }
  get(uri: string | undefined): OutputSchemaEntry | undefined { return uri ? this.m.get(uri) : undefined; }
}

const ArtifactOutput = z.strictObject({ artifactUri: z.string().min(1).max(2000), summary: z.string().max(10_000).optional(), candidateSha: z.string().regex(/^[a-f0-9]{40}$/).optional() });
export type ArtifactOutput = z.infer<typeof ArtifactOutput>;

/**
 * Model output is untrusted: parse as JSON, enforce a size cap, validate against the role's schema, and (for reviews) require the
 * result to be bound to the exact candidate SHA requested. Anything else is rejected and can never count as a PASS.
 */
export function parseRoleOutput(role: AgentRole, raw: unknown, opts: { maxBytes: number; expectedSha?: string | undefined; schemaUri?: string | undefined; schemas?: SchemaRegistry | undefined }): ReviewerResult | ArtifactOutput {
  let value = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw) > opts.maxBytes) throw new OutputRejected("too-large", "output exceeds maxOutputBytes");
    try { value = JSON.parse(raw); } catch { throw new OutputRejected("not-json", "output is not valid JSON"); }
  } else if (Buffer.byteLength(JSON.stringify(raw) ?? "") > opts.maxBytes) throw new OutputRejected("too-large", "output exceeds maxOutputBytes");
  if (isReviewRole(role)) {
    const v = validateReview(value);
    if (!v.ok || !v.value) throw new OutputRejected("schema", `review output invalid: ${v.errors.join("; ")}`);
    const want = role.replace("review_", "");
    if (v.value.reviewerRole !== want) throw new OutputRejected("schema", `reviewerRole ${v.value.reviewerRole} does not match role ${role}`);
    if (opts.expectedSha && v.value.candidateSha !== opts.expectedSha) throw new OutputRejected("sha-mismatch", "review is not bound to the requested candidate SHA");
    return v.value;
  }
  const entry = opts.schemas?.get(opts.schemaUri);
  if (entry) {
    const r = entry.schema.safeParse(value);
    if (!r.success) throw new OutputRejected("schema", `${opts.schemaUri} output invalid: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ")}`);
    return r.data as ArtifactOutput;
  }
  const p = ArtifactOutput.safeParse(value);
  if (!p.success) throw new OutputRejected("schema", `artifact output invalid: ${p.error.message}`);
  return p.data;
}
