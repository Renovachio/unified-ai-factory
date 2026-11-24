/** Model-provider credentials/endpoints must never reach any managed child (SECURITY.md: no metered inference, no key injection). */
const FORBIDDEN = /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GOOGLE_API|GEMINI|MISTRAL|COHERE|GROQ|TOGETHER|OPENROUTER|DEEPSEEK|XAI|PERPLEXITY|REPLICATE|HUGGINGFACE_API|HF)_[A-Z0-9_]*$/i;
const FORBIDDEN_EXACT = new Set(["OPENAI_API_BASE", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);

export const forbiddenEnvNames = (env: Record<string, string | undefined>): string[] => Object.keys(env).filter((k) => env[k] !== undefined && (FORBIDDEN.test(k) || FORBIDDEN_EXACT.has(k)));

/** Minimal environment for managed children: an explicit allowlist, never the caller's whole environment. */
export function childEnv(base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TZ"]) { const v = base[k]; if (v !== undefined) out[k] = v; }
  return { ...out, ...extra };
}
