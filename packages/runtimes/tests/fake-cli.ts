import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockBehavior } from "../src/mock";

export type CliBehavior = MockBehavior | "envdump" | "argvdump";

/** A fake "official CLI" (POSIX sh) that behaves like a print-mode CLI: prompt on stdin, JSON envelope on stdout. */
export function makeFakeCli(behavior: CliBehavior, name = "fakecli", format: "envelope" | "jsonl" = "envelope"): string {
  const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
  const path = join(dir, name);
  const script = `#!/bin/sh
case "$1" in --version) echo "${name} 1.2.3 (fake)"; exit 0;; esac
input=$(cat)
sha=$(printf '%s' "$input" | sed -n 's/.*candidateSha MUST equal exactly \\([a-f0-9]\\{40\\}\\).*/\\1/p' | head -1)
role=$(printf '%s' "$input" | sed -n 's/^role: \\(.*\\)$/\\1/p' | head -1)
esc() { sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n' ' '; }
${format === "jsonl"
    ? `emit() { printf '{"type":"thread.started"}\\n{"type":"item.completed","text":"%s"}\\n{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7}}\\n' "$(printf '%s' "$1" | esc)"; }`
    : `emit() { printf '{"type":"result","result":"%s","usage":{"input_tokens":11,"output_tokens":7}}\\n' "$(printf '%s' "$1" | esc)"; }`}
review() { printf '{"reviewerRole":"%s","candidateSha":"%s","verdict":"pass","findings":[]}' "\${role#review_}" "$1"; }
case "${behavior}" in
  slow) sleep 30 & wait ;;
  fail) echo "boom" >&2; exit 3 ;;
  rate_limited) echo "Claude usage limit reached. Try again later." >&2; exit 1 ;;
  bad_output) emit "I am sorry, I cannot comply {not json" ;;
  wrong_sha) case "$role" in review_*) emit "$(review ffffffffffffffffffffffffffffffffffffffff)" ;; *) emit '{"artifactUri":"cli://x","summary":"ok"}' ;; esac ;;
  envdump) emit "{\\"artifactUri\\":\\"cli://env\\",\\"summary\\":\\"$(env | tr '\\n' ' ' | sed 's/"//g')\\"}" ;;
  argvdump) emit "{\\"artifactUri\\":\\"cli://argv\\",\\"summary\\":\\"ARGV[$*] STDIN_LEN[\${#input}]\\"}" ;;
  *) case "$role" in review_*) emit "$(review "$sha")" ;; *) emit '{"artifactUri":"cli://out","summary":"ok"}' ;; esac ;;
esac
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}
