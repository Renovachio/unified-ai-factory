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
/** Context-bearing patterns: keep the surrounding label, drop only the secret ($1 is preserved). */
const SECRET_CONTEXT: Array<[RegExp, string]> = [
  [/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, REDACTED],
  [/\b((?:set-)?cookie)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`],
  [/\b(?:__Host-)?factory_(?:session|login)=[A-Za-z0-9_-]{16,200}/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]{1,100}:[^\s/@]{1,200}@/gi, `$1${REDACTED}@`],
  [/\b((?:access|refresh|id)_token|client_secret|code_verifier|api[_-]?key|token|password|secret)=[^&\s;"')]{6,}/gi, `$1=${REDACTED}`],
  [/\b([A-Z][A-Z0-9_]{0,60}(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]{0,40})=[^\s;"']{6,}/g, `$1=${REDACTED}`],
  [/\bcode=[^&\s]{12,}(?=&state=)/g, `code=${REDACTED}`],
];
const MAX_DEPTH = 12;
const MAX_STRING = 64_000;

export function redactString(s: string): string {
  let out = s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "…[truncated]" : s;
  for (const re of SECRET_VALUE) out = out.replace(re, REDACTED);
  for (const [re, to] of SECRET_CONTEXT) out = out.replace(re, to);
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
