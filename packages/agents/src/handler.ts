import type { Sql } from "@factory/db";
import { z } from "zod";
import { DesignSchema, RequirementsSchema, SpecSchema, validateTraceability, type TraceResult } from "./spec";

interface Store { get(digest: string): Buffer; put(data: string): { digest: string; uri: string; bytes: number } }

export interface SpecValidation {
  ok: boolean;
  errors: string[];
  riskFloor: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  traceabilityDigest?: string;
  specDigest?: string;
  trace?: TraceResult;
}

async function load<T>(sql: Sql, store: Store, jobId: string, kind: string, schema: z.ZodType<T>): Promise<{ value: T; digest: string } | string> {
  const [a] = await sql<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${jobId} AND kind = ${kind} ORDER BY created_at DESC LIMIT 1`;
  if (!a) return `missing artifact ${kind}`;
  try {
    const r = schema.safeParse(JSON.parse(store.get(a.digest).toString("utf8")));
    return r.success ? { value: r.data, digest: a.digest } : `${kind} invalid: ${r.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  } catch (e) { return `${kind} unreadable: ${e instanceof Error ? e.message : "error"}`; }
}

/** Validates the analyst/architect/spec artifacts for a job and stores the traceability matrix. Re-validation of artifacts is independent of the adapter's checks. */
export function createSpecHandler(d: { sql: Sql; store: Store }) {
  return {
    async validate(job: { id: string }): Promise<SpecValidation> {
      const req = await load(d.sql, d.store, job.id, "requirements.json", RequirementsSchema);
      const des = await load(d.sql, d.store, job.id, "design.json", DesignSchema);
      const spec = await load(d.sql, d.store, job.id, "spec.json", SpecSchema);
      const bad = [req, des, spec].filter((x): x is string => typeof x === "string");
      if (bad.length) return { ok: false, errors: bad, riskFloor: "LOW" };
      // Intake ACs (latest intake artifact) must all survive into the requirements.
      const [ia] = await d.sql<{ digest: string }[]>`SELECT digest FROM artifacts WHERE job_id = ${job.id} AND kind LIKE 'intake.r%.json' ORDER BY created_at DESC LIMIT 1`;
      let intakeAcIds: string[] = [];
      if (ia) {
        try { intakeAcIds = ((JSON.parse(d.store.get(ia.digest).toString("utf8")) as { acceptance_criteria?: Array<{ id: string }> }).acceptance_criteria ?? []).map((a) => a.id); } catch { intakeAcIds = []; }
      }
      const r = req as { value: z.infer<typeof RequirementsSchema> };
      const trace = validateTraceability({ intakeAcIds, requirements: r.value, design: (des as { value: z.infer<typeof DesignSchema> }).value, spec: (spec as { value: z.infer<typeof SpecSchema> }).value });
      const stored = d.store.put(JSON.stringify({ matrix: trace.matrix, protectedPaths: trace.protectedPaths, riskFloor: trace.riskFloor, errors: trace.errors }));
      await d.sql`INSERT INTO artifacts (job_id, kind, digest, storage_uri, byte_length, redaction_status) VALUES (${job.id}, 'traceability.json', ${stored.digest}, ${stored.uri}, ${stored.bytes}, 'clean') ON CONFLICT (job_id, kind, digest) DO NOTHING`;
      return { ok: trace.ok, errors: trace.errors.map((e) => `${e.code}: ${e.message}`), riskFloor: trace.riskFloor, traceabilityDigest: stored.digest, specDigest: (spec as { digest: string }).digest, trace };
    },
  };
}
