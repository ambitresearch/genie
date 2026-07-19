import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "src", "cli.ts");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
  version: string;
};

describe("server CLI", () => {
  it("prints the package version", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", cliPath, "--version"], {
      cwd: packageRoot,
      encoding: "utf8",
      input: "",
      timeout: 60_000,
    });

    expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
    expect(result.stdout).toBe(`genie ${packageJson.version}\n`);
  }, 60_000);

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
  }, 60_000);
});
