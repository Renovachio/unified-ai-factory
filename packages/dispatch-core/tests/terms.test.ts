import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { termsApproval } from "../src/index";

const dir = mkdtempSync(join(tmpdir(), "terms-")); afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (approvals: unknown[]) => writeFileSync(join(dir, "provider-terms.json"), JSON.stringify({ version: "1.0", approvals }));
const ok = { adapterId: "claude-code", provider: "Anthropic", termsUrl: "https://example.com/terms", termsReviewedOn: "2026-11-19", approvedBy: "operator", scope: "interactive use" };
describe("provider-terms approval is the operator's, and fails closed", () => {
  test("approved only with a complete, unexpired entry for exactly that adapter", () => {
    write([]); expect(termsApproval(dir, "claude-code").approved).toBe(false);
    write([ok]); expect(termsApproval(dir, "claude-code")).toMatchObject({ approved: true, scope: "interactive use" }); expect(termsApproval(dir, "codex").approved).toBe(false);
    write([{ ...ok, expiresOn: "2026-01-01" }]); const e = termsApproval(dir, "claude-code"); expect(e.approved).toBe(false); if (!e.approved) expect(e.reason).toContain("expired");
    write([{ ...ok, expiresOn: "2099-01-01" }]); expect(termsApproval(dir, "claude-code").approved).toBe(true);
    for (const bad of [{ ...ok, approvedBy: "" }, { ...ok, termsUrl: undefined }, { ...ok, scope: undefined }, { ...ok, adapterId: "claude-code-x" }]) { write([bad]); expect(termsApproval(dir, "claude-code").approved).toBe(false); }
  });
  test("missing folder, missing file and corrupt file all mean not approved", () => {
    expect(termsApproval(undefined, "claude-code").approved).toBe(false); expect(termsApproval(join(dir, "nope"), "claude-code").approved).toBe(false);
    writeFileSync(join(dir, "provider-terms.json"), "{not json"); expect(termsApproval(dir, "claude-code").approved).toBe(false);
  });
});
