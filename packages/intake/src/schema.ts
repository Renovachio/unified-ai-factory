import type { SchemaRegistry } from "@factory/runtimes";
import { z } from "zod";

/**
 * The ONLY shape an intake agent may return. Strict: any attempt to smuggle policy-like fields (gates, reviewers, merge,
 * approvals, risk overrides below the deterministic floor) is rejected outright rather than ignored.
 */
export const IntakeDecisionSchema = z.strictObject({
  decision: z.enum(["accept", "needs_info", "reject"]),
  summary: z.string().max(2000),
  risk_hint: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  acceptance_criteria: z.array(z.strictObject({ id: z.string().regex(/^AC-\d{1,3}$/), text: z.string().min(1).max(1000) })).max(30).default([]),
  questions: z.array(z.string().min(1).max(500)).max(10).default([]),
  uncertainties: z.array(z.string().max(500)).max(20).default([]),
  reject_reason: z.string().max(500).optional(),
});
export type IntakeDecision = z.infer<typeof IntakeDecisionSchema>;

/** Register on the composition root's registry so intake output is validated against the strict schema. */
export function registerIntakeSchema(registry: SchemaRegistry): SchemaRegistry {
  return registry.register("schema://intake", {
    schema: IntakeDecisionSchema,
    hint: `{"decision":"accept|needs_info|reject","summary":"<=2000 chars","risk_hint":"LOW|MEDIUM|HIGH|CRITICAL (optional)","acceptance_criteria":[{"id":"AC-1","text":"observable, testable outcome"}],"questions":["..."],"uncertainties":["..."],"reject_reason":"(optional)"} — no other keys`,
  });
}
