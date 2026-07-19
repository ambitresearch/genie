/**
 * Tests for the M5-07 multi-arch Docker image (DRO-279).
 *
 * Two tiers:
 *   1. Static assertions on `Dockerfile` / `deploy/docker-compose.yml` text —
 *      cheap, always run, encode the ACs a raw-text regression could break
 *      (base image, non-root user, healthcheck, exposed port) — the same
 *      "encode the AC as a test" discipline `litellm-config.test.ts` uses for
 *      a different reference file.
 *   2. A real `docker build` + container boot + `/health` check, gated by the
 *      same `docker info` CLI interface every test below uses — skipped when
 *      the CLI/daemon is unavailable, required to actually run
 *      on CI's `docker-build-smoke` job (ci.yml), which sets
 *      `GENIE_REQUIRE_DOCKER=1` so a daemon-less runner fails loudly instead
 *      of skipping vacuously.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const maxImageSizeBytes = 200_000_000;

type DockerInfoRunner = (command: string, args: string[]) => Promise<unknown>;

async function isDockerCliAvailable(
  run: DockerInfoRunner = async (command, args) => {
    await execFileAsync(command, args);
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.GENIE_SKIP_DOCKER_TESTS === "1") return false;
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const dockerfilePath = resolve(repoRoot, "Dockerfile");
const dockerignorePath = resolve(repoRoot, ".dockerignore");
const envExamplePath = resolve(repoRoot, ".env.example");
const composePath = resolve(repoRoot, "deploy", "docker-compose.yml");
const readmePath = resolve(repoRoot, "README.md");
const ciPath = resolve(repoRoot, ".github", "workflows", "ci.yml");
const releaseWorkflowPath = resolve(repoRoot, ".github", "workflows", "release.yml");
const tsMorphPackScriptPath = resolve(
  repoRoot,
  "packages",
  "server",
  "scripts",
  "pack-ts-morph-runtime.mjs",
);

const dockerfile = readFileSync(dockerfilePath, "utf-8");
const dockerignore = existsSync(dockerignorePath) ? readFileSync(dockerignorePath, "utf-8") : "";
const envExample = readFileSync(envExamplePath, "utf-8");
const compose = readFileSync(composePath, "utf-8");
const readme = readFileSync(readmePath, "utf-8");
const ci = readFileSync(ciPath, "utf-8");
const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf-8");
const tsMorphPackScript = readFileSync(tsMorphPackScriptPath, "utf-8");

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
    expect(dockerfile).toMatch(
      /pnpm --filter @ambitresearch\/genie deploy --prod --legacy --frozen-lockfile --config\.minimumReleaseAge=0 \/out/,
    );
    expect(dockerfile).not.toMatch(/\bnpm (?:ci|install)\b/);
  });

  it("includes genie's MIT license in the distributed runtime image", () => {
    expect(dockerfile).toMatch(/COPY --chown=node:node LICENSE \.\/LICENSE/);
  });

  it("documents the strict decimal-byte budget and the real viewer asset source", () => {
    expect(dockerfile).toContain("AC2's 200,000,000-byte ceiling");
    expect(dockerfile).not.toContain("200 MiB");
    expect(dockerfile).toContain("packages/server/src/store/viewer-assets.ts");
    expect(dockerfile).not.toContain("docs/store/viewer-assets.ts");
  });

  it("stores the bundled ts-morph runtime compressed and loads it lazily", () => {
    expect(dockerfile).toContain("pack-ts-morph-runtime.mjs");
    expect(tsMorphPackScript).toContain("brotliCompressSync");
    expect(tsMorphPackScript).toContain("runtime.mjs.br");
    expect(tsMorphPackScript).toContain("brotliDecompressSync");
    expect(tsMorphPackScript).toContain('new URL("./runtime.mjs.br", import.meta.url)');
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
      ".genie",
      "**/.genie",
      ".remember",
      "**/.remember",
      "*.local",
      "**/*.local",
      "shellprivatevars",
      "**/shellprivatevars",
      ".gstack",
      "**/.gstack",
      ".goals",
      "**/.goals",
      ".hallmark",
      "**/.hallmark",
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
    expect(compose).toMatch(/genie:\s*\n\s*image: ghcr\.io\/ambitresearch\/genie/);
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

  it("documents an executable local OAuth quickstart", () => {
    expect(readme).toMatch(/docker run -d .*--name genie/);
    expect(readme).toContain('-e OAUTH_HS256_KEY="$(openssl rand -hex 32)"');
    expect(readme).toContain("-e GENIE_OAUTH_ISSUER=http://localhost:8080");
  });

  it("requires and forwards a real host LLM key in the Docker quickstart", () => {
    expect(readme).toContain('test "${#GENIE_LLM_API_KEY}" -ge 16');
    expect(readme).toMatch(/-e GENIE_LLM_API_KEY(?:\s|\\)/);
    expect(readme).not.toMatch(/-e GENIE_LLM_API_KEY=(?:\.\.\.|<[^>]+>)/);
  });

  it("waits for Docker health before probing the quickstart endpoint", () => {
    const healthWaitIndex = readme.indexOf(".State.Health.Status");
    const healthProbeIndex = readme.indexOf("curl --fail http://localhost:8080/health");

    expect(readme).toMatch(/seq 1 70/);
    expect(readme).toContain('[ "$health_status" = healthy ] || { docker logs genie; exit 1; }');
    expect(healthWaitIndex).toBeGreaterThanOrEqual(0);
    expect(healthProbeIndex).toBeGreaterThan(healthWaitIndex);
  });

  it("keeps the Compose env template aligned with required OAuth config", () => {
    expect(envExample).toContain("Must be at least 32 characters");
    expect(envExample).toMatch(/^GENIE_OAUTH_ISSUER=http:\/\/localhost:8080$/m);
  });

  it("does not document unsupported CLI git-store selection variables", () => {
    expect(compose).not.toMatch(/GENIE_GIT_BASE_URL/);
    expect(compose).not.toMatch(/GENIE_GIT_TOKEN/);
  });

  it("does not combine incompatible OAuth and static bearer modes", () => {
    expect(compose).not.toMatch(/GENIE_REQUIRE_BEARER_AUTH/);
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
    expect(releaseWorkflow).toContain('version="${SERVER_TAG#server-v}"');
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

  it("pins cosign verification to the release workflow on main", () => {
    expect(readme).toContain(
      "--certificate-identity='https://github.com/ambitresearch/genie/.github/workflows/release.yml@refs/heads/main'",
    );
    expect(readme).not.toContain("--certificate-identity-regexp");
  });

  it("publishes GHCR under Ambit Research and retains the confirmed Docker Hub namespace", () => {
    const ghcrJobStart = releaseWorkflow.indexOf("  docker-publish-ghcr:");
    const dockerHubJobStart = releaseWorkflow.indexOf("  docker-publish-dockerhub:");
    const ghcrJob = releaseWorkflow.slice(ghcrJobStart, dockerHubJobStart);
    const dockerHubJob = releaseWorkflow.slice(dockerHubJobStart);

    expect(ghcrJob).toContain("ghcr.io/ambitresearch/genie");
    expect(ghcrJob).not.toContain("ghcr.io/roshangautam/genie");
    expect(dockerHubJob).toContain("docker.io/roshangautam/genie");
    expect(dockerHubJob).not.toContain("docker.io/ambitresearch/genie");
  });

  it("scopes fallback cleanup to this run and removes anonymous volumes", () => {
    expect(ci).toContain("label=com.genie.docker-image-test.run=${GITHUB_RUN_ID}");
    expect(ci).toMatch(/xargs --no-run-if-empty docker rm -fv/);
    expect(ci).not.toMatch(/docker rm -f genie-docker-image-test/);
  });

  it("builds both release platforms on matching native CI runners before publishing", () => {
    const dockerJob = ci.slice(ci.indexOf("  docker-build-smoke:"));
    expect(dockerJob).toMatch(/- runner: ubuntu-24\.04\s+platform: linux\/amd64\s+arch: amd64/);
    expect(dockerJob).toMatch(/- runner: ubuntu-24\.04-arm\s+platform: linux\/arm64\s+arch: arm64/);
    expect(dockerJob).toContain("runs-on: ${{ matrix.runner }}");
    expect(dockerJob).toMatch(/docker\/setup-buildx-action@[0-9a-f]{40} # v3\.12\.0/);
    expect(dockerJob).not.toContain("docker/setup-qemu-action@");
    expect(dockerJob).toContain("docker buildx build --platform ${{ matrix.platform }} --load");
    expect(ci).toMatch(/test "\$size" -lt 200000000/);
  });

  it("gives each native architecture gate enough time to finish", () => {
    const dockerJob = ci.slice(ci.indexOf("  docker-build-smoke:"));
    expect(dockerJob).toMatch(/timeout-minutes: 30/);
  });
});

describe("Docker CLI availability probe", () => {
  it("probes the exact CLI and daemon interface used by the suite", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const available = await isDockerCliAvailable(async (command, args) => {
      calls.push({ command, args });
    }, {});

    expect(available).toBe(true);
    expect(calls).toEqual([
      { command: "docker", args: ["info", "--format", "{{.ServerVersion}}"] },
    ]);
  });

  it("returns false when the Docker CLI or daemon is unavailable", async () => {
    const available = await isDockerCliAvailable(async () => {
      throw new Error("ENOENT");
    }, {});
    expect(available).toBe(false);
  });

  it("honors the explicit Docker-test opt-out without invoking the CLI", async () => {
    let called = false;
    const available = await isDockerCliAvailable(
      async () => {
        called = true;
      },
      { GENIE_SKIP_DOCKER_TESTS: "1" },
    );
    expect(available).toBe(false);
    expect(called).toBe(false);
  });
});

const dockerAvailable = await isDockerCliAvailable();
if (!dockerAvailable) {
  console.warn(
    "docker-image.test.ts: Docker CLI or daemon unavailable — skipping the real " +
      "build+boot suite. CI's docker-build-smoke job (ci.yml) exercises this for real.",
  );
}
if (!dockerAvailable && process.env.GENIE_REQUIRE_DOCKER === "1") {
  throw new Error(
    "GENIE_REQUIRE_DOCKER=1 but the Docker CLI or daemon is unavailable — the CI Docker " +
      "leg must not silently skip this suite.",
  );
}

describe.skipIf(!dockerAvailable)("AC2/AC3/AC4 — real image build + boot", () => {
  const imageTag = "genie:docker-image-test";
  const cleanupScope = process.env.GITHUB_RUN_ID ?? randomUUID();
  const containerName = `genie-docker-image-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const containerLabel = `com.genie.docker-image-test.run=${cleanupScope}`;

  beforeAll(async () => {
    await execFileAsync("docker", ["build", "-t", imageTag, repoRoot], {
      maxBuffer: 1024 * 1024 * 64,
    });
  }, 300_000);

  afterAll(async () => {
    await execFileAsync("docker", ["rm", "-fv", containerName]).catch(() => {});
  });

  it("produces a runtime image under 200 MB (AC2)", async () => {
    const { stdout } = await execFileAsync("docker", [
      "image",
      "inspect",
      imageTag,
      "--format",
      "{{.Size}}",
    ]);
    expect(Number(stdout.trim())).toBeLessThan(maxImageSizeBytes);
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

  it("scaffolds viewer assets when create_kit runs without @ambitresearch/genie-viewer", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "--input-type=module",
      "-e",
      [
        'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
        'import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";',
        'import { existsSync, readdirSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { createServer } from "./dist/server.js";',
        'const root = "/data/kits";',
        'const server = createServer({ kitsRoot: root, transportKind: "stdio" });',
        'const client = new Client({ name: "docker-create-kit", version: "0" });',
        "const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();",
        "await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);",
        'const result = await client.callTool({ name: "mcp__genie__create_kit", arguments: { name: "Docker Viewer Kit" } });',
        'if (result.isError) throw new Error("create_kit failed");',
        'const kitId = readdirSync(root).find((name) => !name.startsWith("."));',
        'if (!kitId) throw new Error("create_kit wrote no kit");',
        'const assets = ["index.html", "viewer.js", "viewer.css"];',
        'if (assets.some((name) => !existsSync(join(root, kitId, name)))) throw new Error("viewer scaffold missing");',
        'process.stdout.write("viewer-scaffold-ok");',
        "await client.close();",
      ].join("\n"),
    ]);
    expect(stdout.trim()).toBe("viewer-scaffold-ok");
  });

  it("diagnoses a missing packaged viewer shell before degrading", async () => {
    const { stderr, stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      imageTag,
      "-c",
      [
        "mv /app/dist/ui/viewer-static /tmp/viewer-static",
        `node --input-type=module -e 'import("./dist/store/viewer-assets.js").then(async ({ loadViewerAssets }) => process.stdout.write(String((await loadViewerAssets()).length)))'`,
      ].join(" && "),
    ]);

    const events = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(stdout.trim()).toBe("0");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "create_kit.viewer_assets.read_failed",
        source: "bundled-server",
        staticDir: "/app/dist/ui/viewer-static",
      }),
    );
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
        "  .then(([_, { default: OpenAI }]) => {",
        '    new OpenAI({ apiKey: "not-a-real-key", baseURL: "http://127.0.0.1:9/v1" })',
        '    process.stdout.write("dependencies-ok")',
        "  })",
      ].join("\n"),
    ]);
    expect(stdout.trim()).toBe("dependencies-ok");
  });

  it("omits OpenAI's unused optional AWS signing stack", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      [
        'const fs = require("node:fs")',
        'const names = fs.readdirSync("node_modules/.pnpm")',
        'if (names.some((name) => name.startsWith("@aws-sdk+") || name.startsWith("@smithy+") || name.startsWith("@aws+lambda-invoke-store@"))) throw new Error("unused AWS signing stack present")',
        'process.stdout.write("aws-signing-stack-pruned")',
      ].join(";"),
    ]);
    expect(stdout.trim()).toBe("aws-signing-stack-pruned");
  });

  it("ships only the compressed ts-morph payload", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      [
        'const fs = require("node:fs")',
        'const root = "node_modules/ts-morph/dist"',
        "const loaderBytes = fs.statSync(`${root}/runtime.mjs`).size",
        "const compressedBytes = fs.statSync(`${root}/runtime.mjs.br`).size",
        'if (loaderBytes >= 4096) throw new Error("ts-morph loader is unexpectedly large")',
        'if (compressedBytes >= 2000000) throw new Error("ts-morph payload is not compact")',
        "process.stdout.write(`${loaderBytes},${compressedBytes}`)",
      ].join(";"),
    ]);
    const [loaderBytes, compressedBytes] = stdout.trim().split(",").map(Number);
    expect(loaderBytes).toBeLessThan(4096);
    expect(compressedBytes).toBeLessThan(2_000_000);
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
        'if (!fs.readFileSync("LICENSE", "utf8").includes("MIT License")) throw new Error("missing genie license")',
        'if (!fs.existsSync("node_modules/esbuild/LICENSE.md")) throw new Error("missing esbuild license")',
        'if (!fs.existsSync("node_modules/ts-morph/LICENSE.@ts-morph-common")) throw new Error("missing bundled ts-morph license")',
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

  it("keeps Vue, declaration extraction, and PNG runtime paths functional", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageTag,
      "-e",
      [
        "Promise.all([",
        '  import("./dist/framework/react.js"),',
        '  import("./dist/framework/vue.js"),',
        '  import("pngjs"),',
        "]).then(async ([{ ReactAdapter }, { VueAdapter }, { PNG }]) => {",
        "  const react = new ReactAdapter()",
        "  const vue = new VueAdapter()",
        "  const reactDts = await react.extractDts({",
        '    componentName: "Button", group: "inputs",',
        '    source: "export interface ButtonProps { label: string }; export default function Button(_: ButtonProps) { return null }",',
        "  })",
        "  const vuePreview = await vue.renderPreview({",
        '    componentName: "Card", group: "layout",',
        '    source: "<template><article>OK</article></template>",',
        "  })",
        "  const vueDts = await vue.extractDts({",
        '    componentName: "Badge", group: "data",',
        '    source: `<script setup lang="ts">export interface BadgeProps { label: string }; defineProps<BadgeProps>()</script><template><span>{{ label }}</span></template>`,',
        "  })",
        "  const png = PNG.sync.read(PNG.sync.write(new PNG({ width: 1, height: 1 })))",
        '  if (!reactDts.content.includes("ButtonProps")) throw new Error("React d.ts failed")',
        '  if (!vuePreview.content.includes("GenieComponent")) throw new Error("Vue preview failed")',
        '  if (!vueDts.content.includes("BadgeProps")) throw new Error("Vue d.ts failed")',
        '  if (png.width !== 1 || png.height !== 1) throw new Error("PNG round-trip failed")',
        '  process.stdout.write("framework-runtimes-ok")',
        "})",
      ].join("\n"),
    ]);
    expect(stdout.trim()).toBe("framework-runtimes-ok");
  });

  it("boots with a green Docker healthcheck and responds on /health (AC4)", async () => {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "--label",
      containerLabel,
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
