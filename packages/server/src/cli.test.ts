import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "src", "cli.ts");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
  version: string;
};

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolveExited) => child.once("exit", () => resolveExited()));
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(killTimer);
}

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

  it("applies --secrets-from values to the HTTP OAuth runtime", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "genie-cli-secrets-"));
    const secretsPath = join(tempDir, "secrets.env");
    writeFileSync(
      secretsPath,
      [
        "GENIE_LLM_API_KEY=cli-test-llm-key-from-secret-file",
        "OAUTH_HS256_KEY=cli-test-oauth-key-from-secret-file",
      ].join("\n"),
    );
    chmodSync(secretsPath, 0o600);

    const env = { ...process.env };
    delete env.GENIE_LLM_API_KEY;
    delete env.OAUTH_HS256_KEY;
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        cliPath,
        "--transport",
        "http",
        "--port",
        String(port),
        "--secrets-from",
        secretsPath,
      ],
      { cwd: packageRoot, env, stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    try {
      await new Promise<void>((resolveStarted, reject) => {
        const timer = setTimeout(() => reject(new Error(`CLI did not start:\n${stderr}`)), 30_000);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          if (stderr.includes("OAuth 2.0 + DCR enabled")) {
            clearTimeout(timer);
            resolveStarted();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          if (!stderr.includes("OAuth 2.0 + DCR enabled")) {
            clearTimeout(timer);
            reject(new Error(`CLI exited with ${code}:\n${stderr}`));
          }
        });
      });

      const metadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toMatchObject({
        issuer: baseUrl,
        registration_endpoint: `${baseUrl}/register`,
      });

      const unauthenticatedMcp = await fetch(`${baseUrl}/mcp`, {
        headers: { accept: "application/json, text/event-stream" },
      });
      expect(unauthenticatedMcp.status).toBe(401);
    } finally {
      await stopChild(child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
