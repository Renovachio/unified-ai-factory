import { describe, expect, test } from "bun:test";
import { findForbiddenEnv, isInferenceMode } from "./index";

describe("inference policy", () => {
  test("accepts only subscription_cli and local_model", () => {
    expect(isInferenceMode("subscription_cli")).toBe(true);
    expect(isInferenceMode("local_model")).toBe(true);
    expect(isInferenceMode("api_key")).toBe(false);
    expect(isInferenceMode(undefined)).toBe(false);
  });
  test("detects provider API keys in env", () => {
    expect(findForbiddenEnv({ ANTHROPIC_API_KEY: "x", PATH: "/bin" })).toEqual(["ANTHROPIC_API_KEY"]);
    expect(findForbiddenEnv({ OPENAI_API_KEY: "" })).toEqual([]);
  });
});
