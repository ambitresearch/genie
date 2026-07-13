import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "src", "cli.ts");

describe("server CLI", () => {
  it("rejects --preview-locality without a value instead of using defaults", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", cliPath, "--preview-locality"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, GENIE_PREVIEW_LOCALITY: "remote" },
      input: "",
      timeout: 60_000,
    });

    expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(1);
    expect(result.stderr).toContain("--preview-locality requires a value");
  });

  it("rejects --secrets-from without a value", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", cliPath, "--secrets-from"], {
      cwd: packageRoot,
      encoding: "utf8",
      input: "",
      timeout: 60_000,
    });

    expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(1);
    expect(result.stderr).toContain("--secrets-from requires a file path");
  });

  describe("secret validation at boot (M5-03 / DRO-275)", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "genie-cli-secrets-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("--help short-circuits before the secrets check runs (control)", () => {
      const result = spawnSync("pnpm", ["exec", "tsx", cliPath, "--help"], {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, GENIE_LLM_API_KEY: "short" },
        input: "",
        timeout: 60_000,
      });

      expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
    });

    it("rejects a secret value leaked via argv even for an otherwise-valid boot", () => {
      const result = spawnSync(
        "pnpm",
        [
          "exec",
          "tsx",
          cliPath,
          "--transport",
          "stdio",
          "--fake-flag=this-value-is-long-enough-1234",
        ],
        {
          cwd: packageRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            GENIE_LLM_API_KEY: "this-value-is-long-enough-1234",
          },
          input: "",
          timeout: 60_000,
        },
      );

      expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(1);
      expect(result.stderr).toContain("was found in process.argv");
    });

    it("merges secrets from a --secrets-from file and logs only the names", async () => {
      const secretsPath = join(dir, "secrets.env");
      await writeFile(secretsPath, "GENIE_LLM_API_KEY=file-provided-value-long-enough\n");

      const result = spawnSync(
        "pnpm",
        ["exec", "tsx", cliPath, "--secrets-from", secretsPath, "--transport", "stdio"],
        {
          cwd: packageRoot,
          encoding: "utf8",
          env: { ...process.env, GENIE_LLM_API_KEY: undefined },
          input: "",
          timeout: 10_000,
        },
      );

      expect(result.stderr).toContain("loaded secrets: GENIE_LLM_API_KEY");
      expect(result.stderr).not.toContain("file-provided-value-long-enough");
    });
  });
});
