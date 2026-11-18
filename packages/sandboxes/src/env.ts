import { FORBIDDEN_ENV_KEYS } from "@factory/domain";
import { SAFE_GIT_ENV } from "./gitsafety";

export class PolicyViolation extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

const FORBIDDEN_NAME = /(API_?KEY|_TOKEN$|^TOKEN$|SECRET|PASSWORD|CREDENTIAL|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^GH_|^GITHUB_|^ANTHROPIC_|^OPENAI_|^GEMINI_|^MISTRAL_|^COHERE_|SSH_AUTH_SOCK|^DOCKER_|^KUBECONFIG$|^NPM_CONFIG_|_BASE_URL$)/i;

/** Names of variables that must never reach a runtime or a sandbox. */
export function forbiddenEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env).filter(
    (k) => env[k] !== undefined && env[k] !== "" && ((FORBIDDEN_ENV_KEYS as readonly string[]).includes(k) || FORBIDDEN_NAME.test(k)),
  );
}

export function assertEnvAllowed(env: Readonly<Record<string, string | undefined>>): void {
  const bad = forbiddenEnvNames(env);
  if (bad.length) throw new PolicyViolation("forbidden-env", `refusing to run: credential-like environment present (${bad.join(", ")}); model API keys and provider credentials are prohibited`);
}

/** Minimal environment for sandboxed commands. NEVER derived from process.env. */
export function buildSandboxEnv(dirs: { home: string; tmp: string }, extra: Record<string, string> = {}): Record<string, string> {
  assertEnvAllowed(extra);
  return { PATH: "/usr/bin:/bin", HOME: dirs.home, TMPDIR: dirs.tmp, LANG: "C.UTF-8", ...SAFE_GIT_ENV, ...extra };
}
