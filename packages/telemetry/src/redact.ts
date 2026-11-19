const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|credential|cookie|private[-_]?key)/i;
const SECRET_VALUE: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
export const REDACTED = "[REDACTED]";
const MAX_DEPTH = 12;
const MAX_STRING = 64_000;

export function redactString(s: string): string {
  let out = s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "…[truncated]" : s;
  for (const re of SECRET_VALUE) out = out.replace(re, REDACTED);
  return out;
}

/** Deep, pure redaction of secret-looking keys and values. Never mutates input. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return REDACTED as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && typeof v !== "boolean" ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
