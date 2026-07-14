/**
 * Tests for M5-03 (DRO-275) — env-var secret handling, no plaintext at rest.
 */
import { describe, expect, it, vi } from "vitest";

import {
  loadSecrets,
  parseSecretsFile,
  auditLoadedSecrets,
  SecretValidationError,
  MIN_SECRET_LENGTH,
  SECRET_DEFINITIONS,
} from "./secrets.js";

const VALID_LLM_KEY = "sk-abcdefghijklmnopqrstuvwxyz"; // 27 chars, ≥16
const VALID_HS256_KEY = "hs256-abcdefghijklmnopqrstuvwxyz"; // ≥16

describe("loadSecrets — happy path", () => {
  it("loads all required secrets present and long enough (AC1/AC2)", () => {
    const env = {
      GENIE_LLM_API_KEY: VALID_LLM_KEY,
      OAUTH_HS256_KEY: VALID_HS256_KEY,
    };
    const loaded = loadSecrets({ env, argv: ["node", "cli.js"] });
    expect(loaded.map((s) => s.key).sort()).toEqual(["GENIE_LLM_API_KEY", "OAUTH_HS256_KEY"]);
    expect(loaded.find((s) => s.key === "GENIE_LLM_API_KEY")?.value).toBe(VALID_LLM_KEY);
  });

  it("omits optional secrets that are unset", () => {
    const env = {
      GENIE_LLM_API_KEY: VALID_LLM_KEY,
      OAUTH_HS256_KEY: VALID_HS256_KEY,
    };
    const loaded = loadSecrets({ env, argv: [] });
    expect(loaded.some((s) => s.key === "GENIE_GIT_TOKEN")).toBe(false);
    expect(loaded.some((s) => s.key === "OAUTH_CLIENT_SECRET")).toBe(false);
  });

  it("includes optional secrets when present and reads only from env (AC1)", () => {
    const env = {
      GENIE_LLM_API_KEY: VALID_LLM_KEY,
      OAUTH_HS256_KEY: VALID_HS256_KEY,
      GENIE_GIT_TOKEN: "ghp_abcdefghijklmnop",
    };
    const loaded = loadSecrets({ env, argv: [] });
    expect(loaded.find((s) => s.key === "GENIE_GIT_TOKEN")?.value).toBe(env.GENIE_GIT_TOKEN);
  });
});

describe("loadSecrets — AC2: missing required secret", () => {
  it("throws SecretValidationError when a required secret is unset", () => {
    const env = { OAUTH_HS256_KEY: VALID_HS256_KEY };
    expect(() => loadSecrets({ env, argv: [] })).toThrow(SecretValidationError);
    try {
      loadSecrets({ env, argv: [] });
    } catch (err) {
      expect(err).toBeInstanceOf(SecretValidationError);
      expect((err as SecretValidationError).problems.join(" ")).toMatch(/GENIE_LLM_API_KEY/);
    }
  });

  it("throws when a required secret is the empty string", () => {
    const env = { GENIE_LLM_API_KEY: "", OAUTH_HS256_KEY: VALID_HS256_KEY };
    expect(() => loadSecrets({ env, argv: [] })).toThrow(SecretValidationError);
  });

  it("aggregates all problems, not just the first", () => {
    try {
      loadSecrets({ env: {}, argv: [] });
      expect.fail("expected throw");
    } catch (err) {
      const problems = (err as SecretValidationError).problems;
      expect(problems.some((p) => p.includes("GENIE_LLM_API_KEY"))).toBe(true);
      expect(problems.some((p) => p.includes("OAUTH_HS256_KEY"))).toBe(true);
    }
  });
});

describe("loadSecrets — AC2: too-short required secret", () => {
  it("rejects a required secret shorter than MIN_SECRET_LENGTH", () => {
    const env = { GENIE_LLM_API_KEY: "short", OAUTH_HS256_KEY: VALID_HS256_KEY };
    try {
      loadSecrets({ env, argv: [] });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretValidationError);
      expect((err as SecretValidationError).problems.join(" ")).toMatch(/at least 16/);
    }
  });

  it("accepts a required secret exactly MIN_SECRET_LENGTH long", () => {
    const exact = "a".repeat(MIN_SECRET_LENGTH);
    const env = { GENIE_LLM_API_KEY: exact, OAUTH_HS256_KEY: VALID_HS256_KEY };
    expect(() => loadSecrets({ env, argv: [] })).not.toThrow();
  });
});

describe("loadSecrets — AC2: secret leaked into argv", () => {
  it("rejects when a required secret's value appears verbatim in argv", () => {
    const env = { GENIE_LLM_API_KEY: VALID_LLM_KEY, OAUTH_HS256_KEY: VALID_HS256_KEY };
    const argv = ["node", "cli.js", `--api-key=${VALID_LLM_KEY}`];
    try {
      loadSecrets({ env, argv });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretValidationError);
      expect((err as SecretValidationError).problems.join(" ")).toMatch(/argv/);
    }
  });

  it("does not throw when argv contains unrelated flags", () => {
    const env = { GENIE_LLM_API_KEY: VALID_LLM_KEY, OAUTH_HS256_KEY: VALID_HS256_KEY };
    const argv = ["node", "cli.js", "--transport", "http", "--port", "3000"];
    expect(() => loadSecrets({ env, argv })).not.toThrow();
  });
});

describe("loadSecrets — AC6: --secrets-from file", () => {
  it("reads secret values from a mounted secrets file", () => {
    const fileContents = [
      `GENIE_LLM_API_KEY=${VALID_LLM_KEY}`,
      `OAUTH_HS256_KEY=${VALID_HS256_KEY}`,
      "# a comment",
      "",
    ].join("\n");
    const readFile = vi.fn(() => fileContents);
    const loaded = loadSecrets({
      env: {},
      argv: [],
      secretsFromPath: "/run/secrets/genie",
      readFile,
      statFile: () => ({ mode: 0o100600 }),
    });
    expect(readFile).toHaveBeenCalledWith("/run/secrets/genie");
    expect(loaded.find((s) => s.key === "GENIE_LLM_API_KEY")?.value).toBe(VALID_LLM_KEY);
  });

  it("prefers the secrets file value over env for the same key", () => {
    const fileContents = `GENIE_LLM_API_KEY=${VALID_LLM_KEY}\nOAUTH_HS256_KEY=${VALID_HS256_KEY}`;
    const loaded = loadSecrets({
      env: { GENIE_LLM_API_KEY: "env-value-should-be-overridden-xyz" },
      argv: [],
      secretsFromPath: "/run/secrets/genie",
      readFile: () => fileContents,
      statFile: () => ({ mode: 0o100600 }),
    });
    expect(loaded.find((s) => s.key === "GENIE_LLM_API_KEY")?.value).toBe(VALID_LLM_KEY);
  });

  it.each([0o100604, 0o100640, 0o100644])(
    "rejects a mounted secrets file readable by other local users (mode %o)",
    (mode) => {
      expect(() =>
        loadSecrets({
          env: {},
          argv: [],
          secretsFromPath: "/run/secrets/genie",
          readFile: () => `GENIE_LLM_API_KEY=${VALID_LLM_KEY}\nOAUTH_HS256_KEY=${VALID_HS256_KEY}`,
          statFile: () => ({ mode }),
        }),
      ).toThrow(/must not be readable or writable by group or other users/);
    },
  );

  it("accepts an owner-only mounted secrets file", () => {
    expect(() =>
      loadSecrets({
        env: {},
        argv: [],
        secretsFromPath: "/run/secrets/genie",
        readFile: () => `GENIE_LLM_API_KEY=${VALID_LLM_KEY}\nOAUTH_HS256_KEY=${VALID_HS256_KEY}`,
        statFile: () => ({ mode: 0o100600 }),
      }),
    ).not.toThrow();
  });
});

describe("parseSecretsFile", () => {
  it("parses KEY=VALUE lines, skipping blanks and comments", () => {
    const parsed = parseSecretsFile(["FOO=bar", "", "# comment", "BAZ=qux=extra"].join("\n"));
    expect(parsed).toEqual({ FOO: "bar", BAZ: "qux=extra" });
  });

  it("ignores malformed lines with no '='", () => {
    const parsed = parseSecretsFile("not-a-kv-line\nFOO=bar");
    expect(parsed).toEqual({ FOO: "bar" });
  });
});

describe("auditLoadedSecrets — AC3", () => {
  it("logs only key names, never values", () => {
    const lines: string[] = [];
    auditLoadedSecrets(
      [
        { key: "GENIE_LLM_API_KEY", value: VALID_LLM_KEY },
        { key: "OAUTH_HS256_KEY", value: VALID_HS256_KEY },
      ],
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GENIE_LLM_API_KEY");
    expect(lines[0]).toContain("OAUTH_HS256_KEY");
    expect(lines[0]).not.toContain(VALID_LLM_KEY);
    expect(lines[0]).not.toContain(VALID_HS256_KEY);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe("secrets.loaded");
    expect(parsed.keys.sort()).toEqual(["GENIE_LLM_API_KEY", "OAUTH_HS256_KEY"]);
  });
});

describe("SECRET_DEFINITIONS", () => {
  it("covers every secret named in DRO-275's acceptance criteria", () => {
    const keys = SECRET_DEFINITIONS.map((d) => d.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "GENIE_LLM_API_KEY",
        "OAUTH_HS256_KEY",
        "GENIE_GIT_TOKEN",
        "OAUTH_CLIENT_SECRET",
      ]),
    );
  });
});
