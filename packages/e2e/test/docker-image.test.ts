/**
 * Tests for the M5-07 multi-arch Docker image (DRO-279).
 *
 * Two tiers:
 *   1. Static assertions on `Dockerfile` / `deploy/docker-compose.yml` text —
 *      cheap, always run, encode the ACs a raw-text regression could break
 *      (base image, non-root user, healthcheck, exposed port) — the same
 *      "encode the AC as a test" discipline `litellm-config.test.ts` uses for
 *      a different reference file.
 *   2. A real `docker build` + container boot + `/health` check, gated behind
 *      {@link isDockerAvailable} exactly like `gitea-conformance.test.ts` —
 *      skipped locally/in this sandbox (no daemon), required to actually run
 *      on CI's `docker-build-smoke` job (ci.yml), which sets
 *      `GENIE_REQUIRE_DOCKER=1` so a daemon-less runner fails loudly instead
 *      of skipping vacuously.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isDockerAvailable } from "./support/gitea-fixture.js";

const execFileAsync = promisify(execFile);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const dockerfilePath = resolve(repoRoot, "Dockerfile");
const composePath = resolve(repoRoot, "deploy", "docker-compose.yml");

const dockerfile = readFileSync(dockerfilePath, "utf-8");
const compose = readFileSync(composePath, "utf-8");

describe("Dockerfile (M5-07 static ACs)", () => {
  it("uses a node:22-alpine base for both build and runtime stages (AC1)", () => {
    const fromLines = dockerfile
      .split("\n")
      .filter((line) => line.trim().toUpperCase().startsWith("FROM"));
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    for (const line of fromLines) {
      expect(line).toMatch(/node:22-alpine/);
    }
  });

  it("is multi-stage — a build stage and a runtime stage (AC1)", () => {
    expect(dockerfile).toMatch(/FROM node:22-alpine AS build/);
    expect(dockerfile).toMatch(/FROM node:22-alpine AS runtime/);
  });

  it("runs as non-root UID 1000 (AC3)", () => {
    expect(dockerfile).toMatch(/USER node/);
    // node:22-alpine's built-in `node` user is uid/gid 1000; the Dockerfile
    // asserts this at build time rather than hardcoding a numeric UID.
    expect(dockerfile).toMatch(/id -u node.*1000|1000.*id -u node/);
  });

  it("declares the AC4 curl-based healthcheck against :8080/health", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/curl -f http:\/\/localhost:8080\/health \|\| exit 1/);
  });

  it("exposes port 8080", () => {
    expect(dockerfile).toMatch(/EXPOSE 8080/);
  });

  it("never hardcodes a secret-shaped literal", () => {
    expect(dockerfile).not.toMatch(/sk-(ant|proj|litellm)-[A-Za-z0-9]/);
    expect(dockerfile).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });
});

describe("deploy/docker-compose.yml (AC6)", () => {
  it("includes the genie MCP server service", () => {
    expect(compose).toMatch(/genie:\s*\n\s*image: ghcr\.io\/roshangautam\/genie/);
  });

  it("does not ship a git host sidecar by default", () => {
    expect(compose).not.toMatch(/gitea\/gitea/);
  });

  it("comments out the kit-root volume example rather than mounting it live", () => {
    expect(compose).toMatch(/#\s*- \.\/my-ui-kit:\/data\/kits\/my-ui-kit/);
  });

  it("never hardcodes a secret — every credential is an interpolated env var", () => {
    expect(compose).not.toMatch(/sk-(ant|proj|litellm)-[A-Za-z0-9]/);
    expect(compose).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });
});

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  console.warn(
    "docker-image.test.ts: no container runtime reachable — skipping the real " +
      "build+boot suite. CI's docker-build-smoke job (ci.yml) exercises this for real.",
  );
}
if (!dockerAvailable && process.env.GENIE_REQUIRE_DOCKER === "1") {
  throw new Error(
    "GENIE_REQUIRE_DOCKER=1 but no container runtime is reachable — the CI Docker " +
      "leg must not silently skip this suite.",
  );
}

describe.skipIf(!dockerAvailable)("AC2/AC3/AC4 — real image build + boot", () => {
  const imageTag = "genie:docker-image-test";
  const containerName = "genie-docker-image-test";

  beforeAll(async () => {
    await execFileAsync("docker", ["build", "-t", imageTag, repoRoot], {
      maxBuffer: 1024 * 1024 * 64,
    });
  }, 300_000);

  afterAll(async () => {
    await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});
  });

  it("produces a runtime image under 200 MB (AC2)", async () => {
    const { stdout } = await execFileAsync("docker", [
      "image",
      "inspect",
      imageTag,
      "--format",
      "{{.Size}}",
    ]);
    const sizeMb = Number(stdout.trim()) / 1024 / 1024;
    expect(sizeMb).toBeLessThan(200);
  });

  it("runs as UID 1000, not root (AC3)", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      imageTag,
      "node",
      "-e",
      "process.stdout.write(String(process.getuid()))",
    ]);
    expect(stdout.trim()).toBe("1000");
  });

  it("boots and reports healthy on /health (AC4)", async () => {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      "18081:8080",
      "-e",
      "GENIE_LLM_BASE_URL=http://localhost:9/v1",
      "-e",
      "GENIE_LLM_API_KEY=docker-image-test-key-0123456789",
      "-e",
      "OAUTH_HS256_KEY=docker-image-test-hs256-key-0123456789",
      imageTag,
    ]);

    let healthy = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch("http://127.0.0.1:18081/health");
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(healthy).toBe(true);
  }, 60_000);
});
