/** Only these inference modes exist (SECURITY.md: no metered model inference). */
export const ALLOWED_INFERENCE_MODES = ["subscription_cli", "local_model"] as const;
export type InferenceMode = (typeof ALLOWED_INFERENCE_MODES)[number];

/** Environment variables that must never reach a runtime (paid provider credentials). */
export const FORBIDDEN_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
] as const;

export function isInferenceMode(value: unknown): value is InferenceMode {
  return typeof value === "string" && (ALLOWED_INFERENCE_MODES as readonly string[]).includes(value);
}

/** Returns the forbidden credential names present in `env` (empty array means clean). */
export function findForbiddenEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return FORBIDDEN_ENV_KEYS.filter((k) => env[k] !== undefined && env[k] !== "");
}

export * from "./states";
export * from "./risk";
export * from "./binding";
export * from "./guards";
