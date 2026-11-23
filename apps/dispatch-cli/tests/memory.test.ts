import { describe, expect, test } from "bun:test";
import { cmdMemory, MEMORY_HELP } from "../src/commands/memory";

describe("dispatch memory (human side)", () => {
  test("help lists every human action and no way for Claude to approve", () => {
    const out: string[] = [];
    expect(cmdMemory(["help"], "/", (s) => out.push(s))).resolves.toBe(0);
    for (const w of ["list", "note", "approve", "reject", "revise", "erase", "export", "consent"]) expect(MEMORY_HELP).toContain(`dispatch memory ${w}`);
  });
  test("no subcommand is a usage error", async () => {
    const out: string[] = [];
    expect(await cmdMemory([], "/", (s) => out.push(s))).toBe(2);
    expect(out.join("\n")).toContain("Usage");
  });
});
