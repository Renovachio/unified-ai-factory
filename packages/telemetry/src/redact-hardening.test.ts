import { describe, expect, test } from "bun:test";
import { redact, redactString } from "./redact";

const LEAKS: Record<string, [string, string]> = {
  "GitHub tokens": ["ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"],
  "fine-grained PAT": ["github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz_0123456789abcdefghijklmnopqrstuvwxyz", "11ABCDEFG0abcdefghij"],
  "Bearer header": ["Authorization: Bearer abc.def.ghi-JKL_mno1234567890", "abc.def.ghi"],
  "Basic header": ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
  "JWT": ["eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz", "eyJhbGci"],
  "PEM block": ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA"],
  "URL credentials": ["git clone https://user:hunter2pass@github.com/o/r.git", "hunter2pass"],
  "Cookie header": ["Cookie: factory_session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG; other=1", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"],
  "Set-Cookie header": ["set-cookie: __Host-factory_session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG; HttpOnly", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"],
  "bare session cookie": ["factory_session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"],
  "query-string token in a stack trace": ["Error: failed\n    at fetch (https://x.test/cb?access_token=abcdef0123456789abcdef0123456789)", "abcdef0123456789abcdef0123456789"],
  "env assignment": ["GITHUB_APP_PRIVATE_KEY=MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"],
  "OIDC callback code": ["GET /cb?code=4/0AbCdEfGhIjKlMnOpQrStUvWxYz0123&state=xyz", "4/0AbCdEfGhIjKlMnOpQrStUvWxYz0123"],
  "client secret / verifier": ["client_secret=s3cr3t-value-123&code_verifier=verifierverifierverifier123", "verifierverifierverifier123"],
  "provider API keys": ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123456789"],
  "AWS key id": ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
};

describe("redaction covers real credential shapes (SEC-07)", () => {
  for (const [name, [input, secret]] of Object.entries(LEAKS)) {
    test(name, () => {
      const out = redactString(input);
      expect(out, name).not.toContain(secret);
      expect(out).toContain("[REDACTED]");
    });
  }
  test("stack traces and error causes are redacted when objects are logged", () => {
    const e = new Error("fetch https://user:pw12345678@h.test failed with Bearer abcdefgh12345678");
    const out = JSON.stringify(redact({ stack: e.stack, message: e.message, nested: { cause: { authorization: "Bearer zzzzzzzzzz", note: "ok" } } }));
    expect(out).not.toContain("pw12345678"); expect(out).not.toContain("abcdefgh12345678"); expect(out).not.toContain("zzzzzzzzzz");
    expect(out).toContain('"note":"ok"');
  });
  test("ordinary text is untouched (no over-redaction of normal logs and code)", () => {
    for (const s of ["job 123 moved to REVIEW", "tests: 12 pass, 0 fail", "const token = nextToken();", "see https://github.com/o/r/pull/1", "code review requested for abc123", "password policy documented in SECURITY.md"]) expect(redactString(s)).toBe(s);
  });
});

describe("redaction cost is linear on hostile input (no catastrophic backtracking)", () => {
  test("64 kB adversarial strings redact in well under a second", () => {
    for (const s of ["A".repeat(64_000), "A_".repeat(32_000), "KEY".repeat(21_000), "http://".repeat(9_000), "a:".repeat(32_000), "token=".repeat(10_000), "x://a:".repeat(10_000), "Cookie:".repeat(9_000), ("A".repeat(50) + "=").repeat(1200)]) {
      const t = performance.now(); redactString(s);
      expect(performance.now() - t).toBeLessThan(500);
    }
  });
});
