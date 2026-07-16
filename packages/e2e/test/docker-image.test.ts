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
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isDockerAvailable } from "./support/gitea-fixture.js";

const execFileAsync = promisify(execFile);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const dockerfilePath = resolve(repoRoot, "Dockerfile");
const dockerignorePath = resolve(repoRoot, ".dockerignore");
const composePath = resolve(repoRoot, "deploy", "docker-compose.yml");
const ciPath = resolve(repoRoot, ".github", "workflows", "ci.yml");
const releaseWorkflowPath = resolve(repoRoot, ".github", "workflows", "release-please.yml");

const dockerfile = readFileSync(dockerfilePath, "utf-8");
const dockerignore = existsSync(dockerignorePath) ? readFileSync(dockerignorePath, "utf-8") : "";
const compose = readFileSync(composePath, "utf-8");
const ci = readFileSync(ciPath, "utf-8");
const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf-8");

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

  it("stages production dependencies from the frozen pnpm lockfile", () => {
    expect(dockerfile).toMatch(/pnpm --filter @genie\/server deploy --prod --legacy \/out/);
    expect(dockerfile).not.toMatch(/\bnpm (?:ci|install)\b/);
  });

  it("points persistent storage at the writable data volume", () => {
    expect(dockerfile).toMatch(/GENIE_HOME=\/data/);
    expect(dockerfile).toMatch(/GENIE_KITS_ROOT=\/data\/kits/);
    expect(dockerfile).toMatch(/GENIE_PROJECTS_ROOT=\/data\/projects/);
    expect(dockerfile).toMatch(/GENIE_REPORTS_DIR=\/data\/reports/);
  });

  it("never hardcodes a secret-shaped literal", () => {
    expect(dockerfile).not.toMatch(/sk-(ant|proj|litellm)-[A-Za-z0-9]/);
    expect(dockerfile).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });
});

describe("Docker build context", () => {
  it("excludes secrets, dependency trees, build outputs, and repository metadata", () => {
    for (const pattern of [
      ".git",
      ".env*",
      "**/.env*",
      "node_modules",
      "**/node_modules",
      "**/dist",
      "reports",
      "**/reports",
      "coverage",
      "**/coverage",
    ]) {
      expect(dockerignore.split("\n")).toContain(pattern);
    }
    expect(dockerignore.split("\n")).toContain("!.env.example");
    expect(dockerignore.split("\n")).toContain("!**/.env.example");
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

  it("documents /data/kits as the image's default kit root", () => {
    expect(compose).toMatch(/default `\/data\/kits`/);
    expect(compose).not.toMatch(/default `\.genie\/kits`/);
  });

  it("keeps the kit-root env example in the service environment mapping", () => {
    const environmentIndex = compose.indexOf("    environment:");
    const kitsRootIndex = compose.indexOf("# GENIE_KITS_ROOT: /data/kits");
    const volumesIndex = compose.indexOf("    volumes:");

    expect(environmentIndex).toBeGreaterThanOrEqual(0);
    expect(kitsRootIndex).toBeGreaterThan(environmentIndex);
    expect(kitsRootIndex).toBeLessThan(volumesIndex);
    expect(compose).not.toMatch(/#\s*environment:/);
  });

  it("documents the OAuth signing key's real minimum length", () => {
    expect(compose).toMatch(/HS256 signing key.*>=32 chars/);
    expect(compose).not.toMatch(/HS256 signing key.*>=16 chars/);
  });

  it("requires an externally reachable OAuth issuer", () => {
    expect(compose).toMatch(
      /GENIE_OAUTH_ISSUER: \$\{GENIE_OAUTH_ISSUER:\?set GENIE_OAUTH_ISSUER\}/,
    );
  });

  it("does not document unsupported CLI git-store selection variables", () => {
    expect(compose).not.toMatch(/GENIE_GIT_BASE_URL/);
    expect(compose).not.toMatch(/GENIE_GIT_TOKEN/);
  });

  it("never hardcodes a secret — every credential is an interpolated env var", () => {
    expect(compose).not.toMatch(/sk-(ant|proj|litellm)-[A-Za-z0-9]/);
    expect(compose).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });
});

describe("Docker release and CI workflows", () => {
  it("reads release-please outputs for the packages/server component", () => {
    expect(releaseWorkflow).toContain(
      "${{ steps.release.outputs['packages/server--release_created'] }}",
    );
    expect(releaseWorkflow).toContain("${{ steps.release.outputs['packages/server--tag_name'] }}");
    expect(releaseWorkflow).toContain('version="${tag#server-v}"');
  });

  it("publishes GHCR independently from Docker Hub credentials", () => {
    const ghcrJobStart = releaseWorkflow.indexOf("  docker-publish-ghcr:");
    const dockerHubJobStart = releaseWorkflow.indexOf("  docker-publish-dockerhub:");

    expect(ghcrJobStart).toBeGreaterThanOrEqual(0);
    expect(dockerHubJobStart).toBeGreaterThan(ghcrJobStart);
    expect(releaseWorkflow.slice(ghcrJobStart, dockerHubJobStart)).not.toContain("DOCKERHUB_");
    expect(releaseWorkflow.slice(dockerHubJobStart)).toContain("DOCKERHUB_USERNAME");
    expect(releaseWorkflow.slice(dockerHubJobStart)).toContain("DOCKERHUB_TOKEN");
  });

  it("cleans up the container created by this suite", () => {
    expect(ci).toMatch(/docker rm -f genie-docker-image-test/);
    expect(ci).not.toMatch(/docker rm -f genie-smoke/);
  });

  it("builds both release platforms in PR CI before publishing", () => {
    expect(ci).toMatch(/docker\/setup-qemu-action@v3/);
    expect(ci).toMatch(/docker\/setup-buildx-action@v3/);
    expect(ci).toMatch(/docker buildx build --platform linux\/amd64,linux\/arm64/);
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
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      "process.stdout.write(String(process.getuid()))",
    ]);
    expect(stdout.trim()).toBe("1000");
  });

  it("provides writable persisted kit, project, and report roots", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      [
        'const fs = require("node:fs")',
        "const roots = [process.env.GENIE_KITS_ROOT, process.env.GENIE_PROJECTS_ROOT, process.env.GENIE_REPORTS_DIR]",
        'if (roots.some((root) => !root)) throw new Error("missing persisted root")',
        "for (const root of roots) {",
        "  fs.mkdirSync(root, { recursive: true })",
        '  fs.writeFileSync(`${root}/.write-test`, "ok")',
        "}",
        'process.stdout.write(roots.join(","))',
      ].join(";"),
    ]);
    expect(stdout.trim()).toBe("/data/kits,/data/projects,/data/reports");
  });

  it("keeps esbuild's native runtime binary functional", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      [
        'import("esbuild").then(async ({ transform }) => {',
        '  const result = await transform("const answer: number = 42", { loader: "ts" })',
        "  process.stdout.write(result.code)",
        "})",
      ].join(";"),
    ]);
    expect(stdout).toContain("const answer = 42;");
  });

  it("keeps production dependencies importable after image pruning", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      [
        'Promise.all([import("pino"), import("openai"), import("zod")])',
        '  .then(() => process.stdout.write("dependencies-ok"))',
      ].join("\n"),
    ]);
    expect(stdout.trim()).toBe("dependencies-ok");
  });

  it("preserves dependency license files while pruning package docs", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      [
        'const fs = require("node:fs")',
        'const files = fs.readdirSync("node_modules/.pnpm", { recursive: true })',
        'if (!fs.existsSync("node_modules/esbuild/LICENSE.md")) throw new Error("missing esbuild license")',
        'if (!files.some((file) => String(file).includes("node_modules/jose/LICENSE.md"))) throw new Error("missing jose license")',
        'process.stdout.write("licenses-ok")',
      ].join(";"),
    ]);
    expect(stdout.trim()).toBe("licenses-ok");
  });

  it("bundles a React preview through the runtime adapter", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      [
        'import("./dist/framework/react.js").then(async ({ ReactAdapter }) => {',
        "  const output = await new ReactAdapter().renderPreview({",
        '    componentName: "Button",',
        '    group: "inputs",',
        '    source: "export default function Button() { return <button>OK</button> }",',
        "  })",
        '  if (!output.content.includes("GenieComponent")) throw new Error("missing preview global")',
        "  process.stdout.write(output.path)",
        "})",
      ].join("\n"),
    ]);
    expect(stdout.trim()).toBe("components/inputs/Button/Button.preview.js");
  });

  it("boots with a green Docker healthcheck and responds on /health (AC4)", async () => {
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

    let healthStatus = "";
    for (let i = 0; i < 70; i++) {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{end}}",
        containerName,
      ]);
      healthStatus = stdout.trim();
      if (healthStatus === "healthy") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(healthStatus).toBe("healthy");

    const res = await fetch("http://127.0.0.1:18081/health");
    expect(res.ok).toBe(true);
  }, 75_000);
});
