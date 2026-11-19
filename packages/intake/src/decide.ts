import { effectiveRisk, type RiskLevel } from "@factory/domain";
import { classifyText, type TextClassification } from "./classify";
import { IntakeDecisionSchema, type IntakeDecision } from "./schema";

export type IntakeNext = "SPECIFYING" | "NEEDS_INFO" | "REJECTED";

export interface IntakeOutcome {
  next: IntakeNext;
  risk: RiskLevel;
  decision: IntakeDecision | null;
  classification: TextClassification;
  reasons: string[];
  questions: string[];
  invalid?: string;
}

/**
 * Combines the (untrusted) agent decision with deterministic classification. Invariants:
 *  - risk = max(deterministic floor, model proposal): content and model can only RAISE risk;
 *  - an invalid / policy-smuggling agent output is never accepted (the job asks for information instead of proceeding);
 *  - suspected injection never lowers controls; it raises the floor and is recorded.
 */
export function decideIntake(agentOutput: unknown, text: { title: string; description: string; feedback: string[] }): IntakeOutcome {
  const classification = classifyText(text.title, text.description, ...text.feedback);
  const parsed = IntakeDecisionSchema.safeParse(agentOutput);
  if (!parsed.success) {
    return {
      next: "NEEDS_INFO", risk: effectiveRisk(classification.minimumRisk, undefined), decision: null, classification,
      reasons: ["intake output failed schema validation"], questions: ["The automated intake could not interpret this request safely. A person needs to clarify or re-submit it."],
      invalid: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; "),
    };
  }
  const d = parsed.data;
  const risk = effectiveRisk(classification.minimumRisk, d.risk_hint);
  if (d.decision === "reject") return { next: "REJECTED", risk, decision: d, classification, reasons: [d.reject_reason ?? "rejected by intake"], questions: [] };
  if (d.decision === "needs_info" || d.questions.length > 0) {
    return { next: "NEEDS_INFO", risk, decision: d, classification, reasons: ["intake needs more information"], questions: d.questions.length ? d.questions : ["Please clarify the request."] };
  }
  if (d.acceptance_criteria.length === 0) {
    return { next: "NEEDS_INFO", risk, decision: d, classification, reasons: ["no testable acceptance criteria could be derived"], questions: ["What observable behaviour would show this is done?"] };
  }
  return { next: "SPECIFYING", risk, decision: d, classification, reasons: [], questions: [] };
}
