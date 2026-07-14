/**
 * Tests for M5-03 (DRO-275) log redaction — AC4.
 */
import { describe, expect, it } from "vitest";

import { createRedactingLogger, redactOptions, redactSecretValues, REDACTED } from "./redact.js";
import type { LoadedSecret } from "./secrets.js";

const secrets: LoadedSecret[] = [
  { key: "GENIE_LLM_API_KEY", value: "sk-super-secret-value-123" },
  { key: "OAUTH_HS256_KEY", value: "hs256-super-secret-value-456" },
];

describe("redactSecretValues", () => {
  it("replaces every occurrence of a known secret value with ****", () => {
    const text = `connecting with key sk-super-secret-value-123 to endpoint`;
    expect(redactSecretValues(text, secrets)).toBe(`connecting with key ${REDACTED} to endpoint`);
  });

  it("redacts multiple distinct secret values in the same string", () => {
    const text = "a=sk-super-secret-value-123 b=hs256-super-secret-value-456";
    const out = redactSecretValues(text, secrets);
    expect(out).toBe(`a=${REDACTED} b=${REDACTED}`);
  });

  it("leaves text with no secret values untouched", () => {
    const text = "nothing sensitive here";
    expect(redactSecretValues(text, secrets)).toBe(text);
  });

  it("redacts short optional secret values too", () => {
    const shortSecrets: LoadedSecret[] = [{ key: "GENIE_GIT_TOKEN", value: "abc" }];
    expect(redactSecretValues("token=abc", shortSecrets)).toBe(`token=${REDACTED}`);
  });
});

describe("redactOptions", () => {
  it("includes every known secret key as a redact path", () => {
    expect(redactOptions.paths).toEqual(
      expect.arrayContaining([
        "GENIE_LLM_API_KEY",
        "OAUTH_HS256_KEY",
        "GENIE_GIT_TOKEN",
        "OAUTH_CLIENT_SECRET",
      ]),
    );
  });

  it("censors with ****", () => {
    expect(redactOptions.censor).toBe("****");
  });
});

describe("createRedactingLogger", () => {
  it("uses pino redact paths for known secret keys", () => {
    const lines: string[] = [];
    const logger = createRedactingLogger(secrets, { write: (line) => lines.push(line) });

    logger.info({ GENIE_LLM_API_KEY: "unexpected-value" }, "configured");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"GENIE_LLM_API_KEY":"${REDACTED}"`);
    expect(lines[0]).not.toContain("unexpected-value");
  });

  it("redacts configured secret values from arbitrary fields and messages", () => {
    const lines: string[] = [];
    const logger = createRedactingLogger(secrets, { write: (line) => lines.push(line) });

    logger.info(
      { endpoint: `token=${secrets[0].value}`, nested: { credential: secrets[1].value } },
      `connected with ${secrets[0].value}`,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(secrets[0].value);
    expect(lines[0]).not.toContain(secrets[1].value);
    expect(lines[0].match(/\*\*\*\*/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
