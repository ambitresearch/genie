import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  auditSecretNames,
  loadSecrets,
  MIN_SECRET_LENGTH,
  SecretValidationError,
} from "./secrets.js";

const REQUIRED = [{ name: "GENIE_LLM_API_KEY", required: true }] as const;
const REQUIRED_AND_OPTIONAL = [
  { name: "GENIE_LLM_API_KEY", required: true },
  { name: "GENIE_GIT_TOKEN", required: false },
] as const;

const VALID_KEY = "sk-0123456789abcdef"; // 19 chars, > MIN_SECRET_LENGTH

describe("loadSecrets", () => {
  it("loads a valid required secret from env", async () => {
    const values = await loadSecrets({
      env: { GENIE_LLM_API_KEY: VALID_KEY },
      argv: ["node", "cli.js"],
      specs: REQUIRED,
    });
    expect(values).toEqual({ GENIE_LLM_API_KEY: VALID_KEY });
  });

  it("throws when a required secret is missing", async () => {
    await expect(
      loadSecrets({ env: {}, argv: [], specs: REQUIRED }),
    ).rejects.toThrow(SecretValidationError);
  });

  it("throws when a required secret is blank/whitespace-only", async () => {
    await expect(
      loadSecrets({ env: { GENIE_LLM_API_KEY: "   " }, argv: [], specs: REQUIRED }),
    ).rejects.toThrow(SecretValidationError);
  });

  it(`throws when a secret is shorter than ${MIN_SECRET_LENGTH} chars`, async () => {
    await expect(
      loadSecrets({ env: { GENIE_LLM_API_KEY: "short" }, argv: [], specs: REQUIRED }),
    ).rejects.toThrow(SecretValidationError);
  });

  it("throws when a secret value leaks into argv", async () => {
    await expect(
      loadSecrets({
        env: { GENIE_LLM_API_KEY: VALID_KEY },
        argv: ["node", "cli.js", `--api-key=${VALID_KEY}`],
        specs: REQUIRED,
      }),
    ).rejects.toThrow(SecretValidationError);
  });

  it("does not require an optional secret that is absent", async () => {
    const values = await loadSecrets({
      env: { GENIE_LLM_API_KEY: VALID_KEY },
      argv: [],
      specs: REQUIRED_AND_OPTIONAL,
    });
    expect(values).toEqual({ GENIE_LLM_API_KEY: VALID_KEY });
  });

  it("still validates shape of an optional secret when present", async () => {
    await expect(
      loadSecrets({
        env: { GENIE_LLM_API_KEY: VALID_KEY, GENIE_GIT_TOKEN: "short" },
        argv: [],
        specs: REQUIRED_AND_OPTIONAL,
      }),
    ).rejects.toThrow(SecretValidationError);
  });

  it("reports every problem found, not just the first", async () => {
    try {
      await loadSecrets({
        env: { GENIE_GIT_TOKEN: "short" },
        argv: [],
        specs: REQUIRED_AND_OPTIONAL,
      });
      throw new Error("expected loadSecrets to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretValidationError);
      const problems = (err as SecretValidationError).problems;
      expect(problems).toHaveLength(2);
      expect(problems.some((p) => p.includes("GENIE_LLM_API_KEY"))).toBe(true);
      expect(problems.some((p) => p.includes("GENIE_GIT_TOKEN"))).toBe(true);
    }
  });

  it("never includes the rejected value itself in the error message", async () => {
    try {
      await loadSecrets({
        env: { GENIE_LLM_API_KEY: "tooshort" },
        argv: [],
        specs: REQUIRED,
      });
      throw new Error("expected loadSecrets to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretValidationError);
      expect((err as Error).message).not.toContain("tooshort");
    }
  });

  describe("--secrets-from file merge", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "genie-secrets-test-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("merges KEY=value lines from the file for unset env vars", async () => {
      const path = join(dir, "secrets.env");
      await writeFile(path, `GENIE_LLM_API_KEY=${VALID_KEY}\n# a comment\n\nGENIE_GIT_TOKEN=another-long-token-value\n`);

      const env: NodeJS.ProcessEnv = {};
      const values = await loadSecrets({
        env,
        argv: [],
        secretsFromPath: path,
        specs: REQUIRED_AND_OPTIONAL,
      });

      expect(values.GENIE_LLM_API_KEY).toBe(VALID_KEY);
      expect(values.GENIE_GIT_TOKEN).toBe("another-long-token-value");
    });

    it("real env vars take precedence over the secrets file", async () => {
      const path = join(dir, "secrets.env");
      await writeFile(path, `GENIE_LLM_API_KEY=file-provided-value-long-enough\n`);

      const env: NodeJS.ProcessEnv = { GENIE_LLM_API_KEY: VALID_KEY };
      const values = await loadSecrets({
        env,
        argv: [],
        secretsFromPath: path,
        specs: REQUIRED,
      });

      expect(values.GENIE_LLM_API_KEY).toBe(VALID_KEY);
    });
  });
});

describe("auditSecretNames", () => {
  it("returns only key names, sorted, never values", () => {
    const names = auditSecretNames({
      GENIE_GIT_TOKEN: "some-secret-value",
      GENIE_LLM_API_KEY: VALID_KEY,
    });
    expect(names).toEqual(["GENIE_GIT_TOKEN", "GENIE_LLM_API_KEY"]);
  });

  it("returns an empty array when nothing was loaded", () => {
    expect(auditSecretNames({})).toEqual([]);
  });
});
