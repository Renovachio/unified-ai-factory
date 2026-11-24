import { describe, expect, test } from "bun:test";
import { canonicalJson, digestOf, redact } from "./index";

describe("redact", () => {
  test("secret-looking values and keys", () => {
    const out = redact({
      a: "token ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP",
      b: "Authorization: Bearer abcdefgh12345678",
      nested: { password: "hunter2", fine: "hello", list: ["sk-abcdefghijklmnop12345", 3] },
      pem: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    });
    const s = JSON.stringify(out);
    for (const secret of ["ghp_abc", "AKIAABC", "abcdefgh12345678", "hunter2", "sk-abcdefghijklmnop12345", "MIIB"]) expect(s).not.toContain(secret);
    expect(out.nested.fine).toBe("hello");
  });
  test("does not mutate input and bounds depth", () => {
    const input = { password: "x" };
    redact(input);
    expect(input.password).toBe("x");
    let deep: Record<string, unknown> = { v: "ok" };
    for (let i = 0; i < 30; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[REDACTED]");
  });
});
describe("digest", () => {
  test("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(digestOf({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
