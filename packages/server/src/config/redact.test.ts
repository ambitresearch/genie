import { describe, expect, it } from "vitest";

import { createRedactor, redactSecrets, REDACTED_PLACEHOLDER } from "./redact.js";

describe("redactSecrets / createRedactor", () => {
  it("replaces every occurrence of a known secret value", () => {
    const out = redactSecrets("token=sk-abc123 sent to sk-abc123 again", {
      GENIE_LLM_API_KEY: "sk-abc123",
    });
    expect(out).toBe(`token=${REDACTED_PLACEHOLDER} sent to ${REDACTED_PLACEHOLDER} again`);
    expect(out).not.toContain("sk-abc123");
  });

  it("redacts multiple distinct secrets in the same string", () => {
    const out = redactSecrets("llm=sk-abc123 git=ghp-xyz789", {
      GENIE_LLM_API_KEY: "sk-abc123",
      GENIE_GIT_TOKEN: "ghp-xyz789",
    });
    expect(out).not.toContain("sk-abc123");
    expect(out).not.toContain("ghp-xyz789");
  });

  it("prefers redacting longer values first so no partial value leaks", () => {
    const out = redactSecrets("value: sk-abc123-extended", {
      A: "sk-abc123",
      B: "sk-abc123-extended",
    });
    expect(out).not.toContain("sk-abc123");
  });

  it("is a no-op when the string contains no secret values", () => {
    const out = redactSecrets("nothing sensitive here", { GENIE_LLM_API_KEY: "sk-abc123" });
    expect(out).toBe("nothing sensitive here");
  });

  it("is a no-op (identity) when no secrets were loaded", () => {
    const redactor = createRedactor({});
    expect(redactor("sk-abc123 stays as-is")).toBe("sk-abc123 stays as-is");
  });

  it("createRedactor can be reused across multiple calls", () => {
    const redactor = createRedactor({ GENIE_LLM_API_KEY: "sk-abc123" });
    expect(redactor("first sk-abc123")).not.toContain("sk-abc123");
    expect(redactor("second sk-abc123")).not.toContain("sk-abc123");
  });

  it("ignores empty-string secret values (no accidental full-string wipe)", () => {
    const redactor = createRedactor({ EMPTY: "" });
    expect(redactor("hello world")).toBe("hello world");
  });
});
