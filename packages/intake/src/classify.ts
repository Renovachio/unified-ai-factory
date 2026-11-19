import { maxRisk, type RiskLevel } from "@factory/domain";
import { redactString } from "@factory/telemetry";

export interface TextClassification {
  minimumRisk: RiskLevel;
  reasons: string[];
  injectionSuspected: boolean;
  injectionSignals: string[];
  secretsRedacted: boolean;
  /** Redacted, length-capped text that is safe to place in a model context as DATA. */
  sanitized: string;
}

const MAX_TEXT = 20_000;

const RISK_RULES: Array<{ re: RegExp; level: RiskLevel; reason: string }> = [
  { re: /\b(auth(entication|orization)?|login|password|oauth|oidc|session|token|permission|rbac|credential|encrypt|crypto|privacy|gdpr|pii)\b/i, level: "HIGH", reason: "security/privacy-sensitive wording" },
  { re: /\b(payment|billing|invoice|checkout|stripe|refund)\b/i, level: "HIGH", reason: "payments" },
  { re: /\b(migration|schema change|drop (table|column)|database|postgres|sql)\b/i, level: "HIGH", reason: "data storage / migration" },
  { re: /\b(dependency upgrade|upgrade dependenc|bump .* version|package\.json|lockfile)\b/i, level: "HIGH", reason: "dependency changes" },
  { re: /\b(concurren|race condition|lock|deadlock|transaction)\b/i, level: "HIGH", reason: "concurrency" },
  { re: /\b(webhook|third[- ]party|integration|external api)\b/i, level: "HIGH", reason: "external integrations" },
  { re: /\b(deploy(ment)?|production|prod\b|kubernetes|terraform|infrastructure|ci\/cd|github actions|\.github\/workflows|branch protection|secret(s)?|api key|ssh key)\b/i, level: "CRITICAL", reason: "production/infra/secrets/branch protection" },
  { re: /\b(regulated|compliance|audit log|rng|payout|game math)\b/i, level: "CRITICAL", reason: "regulated or money-adjacent logic" },
  { re: /\b(ui|screen|page|button|component|css|style|layout)\b/i, level: "MEDIUM", reason: "user-facing behaviour" },
  { re: /\b(feature|endpoint|api|handler|service|refactor|bug|fix)\b/i, level: "MEDIUM", reason: "application behaviour" },
];

const INJECTION_SIGNALS: Array<{ re: RegExp; name: string }> = [
  { re: /ignore (all )?(the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i, name: "ignore-previous" },
  { re: /disregard (all )?(the )?(previous|prior|above|system)/i, name: "disregard" },
  { re: /you are now|act as (an? )?(admin|root|system|developer)|new instructions:/i, name: "role-override" },
  { re: /\b(reveal|print|show|send|exfiltrate|leak|cat|echo|dump)\b.{0,60}(api[ _-]?key|secret|token|credential|password|\.env\b|ssh)/i, name: "secret-exfiltration" },
  { re: /(skip|disable|bypass|turn off|remove)\b.{0,30}\b(tests?|review(s|ers?)?|gates?|checks?|security|branch protection|approval)/i, name: "disable-controls" },
  { re: /(set|mark|treat)\b.{0,30}\b(risk|severity)\b.{0,20}\b(low|none|trivial)/i, name: "risk-downgrade" },
  { re: /(auto[- ]?)?(merge|approve)\b.{0,30}\b(this|the) (pr|pull request|change|job)\b|approve (everything|all)/i, name: "self-approval" },
  { re: /<\/?\s*(system|assistant|untrusted_context|instructions?)\s*>|\[\/?INST\]|<\|im_(start|end)\|>/i, name: "delimiter-spoofing" },
  { re: /(curl|wget)\s+https?:\/\/\S+.*\|\s*(ba)?sh/i, name: "pipe-to-shell" },
];

/** Deterministic classification of UNTRUSTED request text. It can only raise the risk floor, never lower it. */
export function classifyText(...parts: string[]): TextClassification {
  const raw = parts.join("\n\n").slice(0, MAX_TEXT * 2);
  const sanitizedFull = redactString(raw);
  const secretsRedacted = sanitizedFull !== raw;
  let minimumRisk: RiskLevel = "LOW";
  const reasons: string[] = [];
  for (const r of RISK_RULES) if (r.re.test(raw)) { minimumRisk = maxRisk(minimumRisk, r.level); reasons.push(`${r.level}: ${r.reason}`); }
  const signals = INJECTION_SIGNALS.filter((s) => s.re.test(raw)).map((s) => s.name);
  const injectionSuspected = signals.length > 0;
  if (injectionSuspected) { minimumRisk = maxRisk(minimumRisk, "HIGH"); reasons.push(`HIGH: prompt-injection signals (${signals.join(", ")})`); }
  if (secretsRedacted) { minimumRisk = maxRisk(minimumRisk, "HIGH"); reasons.push("HIGH: secret-like strings present in request"); }
  return { minimumRisk, reasons, injectionSuspected, injectionSignals: signals, secretsRedacted, sanitized: sanitizedFull.slice(0, MAX_TEXT) };
}

export interface Precheck { ok: boolean; reasons: string[]; questions: string[] }

const PLACEHOLDER = /\b(tbd|todo|\?\?\?|to be decided|fill (this )?in|lorem ipsum|see (the )?attached|as discussed)\b/i;

/** Cheap deterministic ambiguity screen run before spending any model time. */
export function precheck(title: string, description: string): Precheck {
  const reasons: string[] = [];
  const questions: string[] = [];
  const d = description.trim();
  if (d.length < 30) { reasons.push("description-too-short"); questions.push("Please describe the expected behaviour in more detail (what should change, and how will we know it works?)."); }
  if (d.toLowerCase() === title.trim().toLowerCase()) { reasons.push("description-repeats-title"); questions.push("The description only repeats the title; what is the observable outcome?"); }
  if (PLACEHOLDER.test(`${title} ${d}`)) { reasons.push("placeholder-text"); questions.push("The request contains placeholder text (TBD/???). Which details are still undecided?"); }
  return { ok: reasons.length === 0, reasons, questions };
}
