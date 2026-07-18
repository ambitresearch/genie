/**
 * M5-05 / DRO-277 — `.mcpb` bundle packaging integrity checks.
 *
 * Running `pnpm bundle:mcpb` invokes the real, lockfile-pinned MCPB toolchain,
 * then this suite unpacks the artifact and verifies its production payload.
 * This is not a substitute for AC5 (macOS double-click install into Claude
 * Desktop), which still needs a manual verification pass on real hardware.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifestPath = join(repoRoot, "mcpb", "manifest.json");
const bundleScript = join(repoRoot, "scripts", "bundle-mcpb.mjs");
const outFile = join(repoRoot, "dist", "genie.mcpb");
const rootPackagePath = join(repoRoot, "package.json");
const serverPackagePath = join(repoRoot, "packages", "server", "package.json");
const lockfilePath = join(repoRoot, "pnpm-lock.yaml");
const releaseConfigPath = join(repoRoot, "release-please-config.json");
const releaseWorkflowPath = join(repoRoot, ".github", "workflows", "release.yml");
const readmePath = join(repoRoot, "README.md");
const MAX_BYTES = 30 * 1024 * 1024;

describe("mcpb bundle manifest (AC1)", () => {
  it("mcpb/manifest.json exists and declares the required fields", () => {
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const serverPackage = JSON.parse(readFileSync(serverPackagePath, "utf8"));
    const releaseConfig = JSON.parse(readFileSync(releaseConfigPath, "utf8"));

    expect(manifest.manifest_version).toBeTruthy();
    expect(manifest.name).toBe("genie");
    expect(manifest.version).toBe(serverPackage.version);
    expect(manifest.server?.type).toBe("node");
    expect(manifest.server?.entry_point).toBe("server/dist/cli.js");
    expect(manifest.server?.mcp_config?.command).toBe("node");
    expect(manifest.server?.mcp_config?.args).toEqual([
      "${__dirname}/server/dist/cli.js",
      "--transport",
      "stdio",
    ]);

    // Env-var requirements (implementation notes: GENIE_LLM_API_KEY etc.)
    // must be surfaced as `user_config` so Claude Desktop prompts for them —
    // never hardcoded into the manifest.
    expect(manifest.user_config).toBeTruthy();
    const userConfigValues = JSON.stringify(manifest.user_config);
    expect(userConfigValues).not.toMatch(/sk-|Bearer |secret_/i);

    expect(manifest.server.mcp_config.env).toMatchObject({
      GENIE_HOME: "${HOME}/.genie",
      GENIE_KITS_ROOT: "${HOME}/.genie/kits",
      GENIE_PROJECTS_ROOT: "${HOME}/.genie/projects",
      GENIE_REPORTS_DIR: "${HOME}/.genie/reports",
      GENIE_LLM_BASE_URL: "${user_config.llm_base_url}",
      GENIE_LLM_API_KEY: "${user_config.llm_api_key}",
      OAUTH_HS256_KEY: "${user_config.oauth_hs256_key}",
    });
    expect(manifest.user_config.llm_base_url).toMatchObject({
      required: true,
    });
    expect(manifest.user_config.llm_base_url.sensitive).not.toBe(true);
    expect(manifest.user_config.llm_api_key).toMatchObject({
      required: true,
      sensitive: true,
    });
    expect(manifest.user_config.oauth_hs256_key).toMatchObject({
      required: true,
      sensitive: true,
    });
    expect(manifest.user_config.llm_api_key.title).toMatch(/16\+ characters/i);
    expect(manifest.user_config.llm_api_key.description).toMatch(/at least 16 characters/i);
    expect(manifest.user_config.oauth_hs256_key.title).toMatch(/32\+ characters/i);
    expect(manifest.user_config.oauth_hs256_key.description).toMatch(/at least 32 characters/i);
    // This package-scoped release config needs a leading slash: release-please
    // otherwise resolves the path under packages/server instead of repo root.
    expect(releaseConfig.packages["packages/server"]["extra-files"]).toContainEqual({
      type: "json",
      path: "/mcpb/manifest.json",
      jsonpath: "$.version",
    });
  });

  it("uses only project-pinned packaging and deployment commands", () => {
    const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
    const lockfile = readFileSync(lockfilePath, "utf8");
    const script = readFileSync(bundleScript, "utf8");

    const mcpbVersion = rootPackage.devDependencies["@anthropic-ai/mcpb"];
    expect(mcpbVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockfile).toContain(`specifier: ${mcpbVersion}`);
    expect(lockfile).toContain(`'@anthropic-ai/mcpb@${mcpbVersion}':`);
    expect(script).toContain('"@genie/server",\n  "deploy",');
    expect(script).toContain('"--prod"');
    expect(script).toContain('"--frozen-lockfile"');
    expect(script).toContain('"--config.inject-workspace-packages=true"');
    expect(script).toContain('"--config.node-linker=hoisted"');
    expect(script).toContain('"--config.package-import-method=copy"');
    expect(script).toContain('"--os",\n  "darwin"');
    expect(script).toContain('"--cpu",\n  "arm64"');
    expect(script).toContain('"--cpu",\n  "x64"');
    expect(script).toContain('run("pnpm", ["exec", "mcpb", "pack"');
    expect(script).not.toContain('run("npm", ["install"');
    expect(script).not.toContain('run("npx"');
    expect(script).toContain("size >= MAX_BYTES");

    const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf8");
    expect(releaseWorkflow).toMatch(/publish-mcpb:[\s\S]*?runs-on: macos-latest/);
    expect(releaseWorkflow).toMatch(
      /publish-mcpb:[\s\S]*?ref: \$\{\{ needs\.release-please\.outputs\.server_tag \}\}/,
    );
  });

  it("links the completed M5-10 Claude Desktop guide", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("Claude Desktop users on macOS can install genie");
    expect(readme).toContain("[Claude Desktop guide](./docs/harness/claude-desktop.md)");
    expect(readme).not.toContain("debugging guide will land separately in M5-10");
  });
});

describe("mcpb bundle output (AC2/AC3/AC4)", () => {
  it(
    "packs the complete production server under the 30 MB AC4 budget",
    () => {
      const unpackDir = mkdtempSync(join(tmpdir(), "genie-mcpb-"));
      rmSync(outFile, { force: true });
      try {
        execFileSync("node", [bundleScript], {
          cwd: repoRoot,
          stdio: "pipe",
          timeout: 10 * 60_000,
        });

        expect(existsSync(outFile)).toBe(true);
        const { size } = statSync(outFile);
        expect(size).toBeGreaterThan(0);
        expect(size).toBeLessThan(MAX_BYTES);

        execFileSync("pnpm", ["exec", "mcpb", "unpack", outFile, unpackDir], {
          cwd: repoRoot,
          stdio: "pipe",
          timeout: 60_000,
        });

        const requiredFiles = [
          "manifest.json",
          "server/package.json",
          "server/pnpm-lock.yaml",
          "server/dist/cli.js",
          "server/dist/ui/viewer-static/index.html",
          "server/dist/ui/viewer-static/viewer.css",
          "server/dist/ui/viewer-static/viewer.js",
          "server/node_modules/@modelcontextprotocol/sdk/package.json",
          "server/node_modules/@esbuild/darwin-arm64/bin/esbuild",
          "server/node_modules/@esbuild/darwin-x64/bin/esbuild",
        ];
        for (const path of requiredFiles) {
          expect(existsSync(join(unpackDir, path)), `missing ${path}`).toBe(true);
        }

        const excludedDevDependencies = [
          "server/node_modules/@genie/viewer/package.json",
          "server/node_modules/jsdom/package.json",
          "server/node_modules/playwright/package.json",
          "server/node_modules/esbuild/bin/esbuild",
          "server/node_modules/.bin/esbuild",
          "server/node_modules/esbuild/node_modules/.bin/esbuild",
        ];
        for (const path of excludedDevDependencies) {
          expect(existsSync(join(unpackDir, path)), `unexpected ${path}`).toBe(false);
        }

        const packedManifest = JSON.parse(readFileSync(join(unpackDir, "manifest.json"), "utf8"));
        const packedServerPackage = JSON.parse(
          readFileSync(join(unpackDir, "server", "package.json"), "utf8"),
        );
        expect(packedManifest.version).toBe(packedServerPackage.version);

        for (const [path, cpuType] of [
          ["server/node_modules/@esbuild/darwin-arm64/bin/esbuild", 0x0100000c],
          ["server/node_modules/@esbuild/darwin-x64/bin/esbuild", 0x01000007],
        ] as const) {
          const binaryPath = join(unpackDir, path);
          const binary = readFileSync(binaryPath);
          expect(binary.readUInt32LE(0), `${path} must be a 64-bit Mach-O`).toBe(0xfeedfacf);
          expect(binary.readUInt32LE(4), `${path} has the wrong CPU type`).toBe(cpuType);
          expect(statSync(binaryPath).mode & 0o111, `${path} must be executable`).toBeGreaterThan(
            0,
          );
        }

        if (process.platform === "darwin") {
          const esbuild = spawnSync(
            "node",
            [
              "--input-type=module",
              "--eval",
              'import esbuild from "./node_modules/esbuild/lib/main.js"; ' +
                'await esbuild.build({ stdin: { contents: "export default 1" }, write: false });',
            ],
            { cwd: join(unpackDir, "server"), encoding: "utf8", timeout: 30_000 },
          );
          expect(esbuild.error).toBeUndefined();
          expect(esbuild.status, esbuild.stderr).toBe(0);
        }

        const manifestArgs = packedManifest.server.mcp_config.args.map((arg: string) =>
          arg.replaceAll("${__dirname}", unpackDir),
        );

        const cli = spawnSync(packedManifest.server.mcp_config.command, manifestArgs, {
          cwd: unpackDir,
          input: "",
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            GENIE_HOME: join(unpackDir, ".genie"),
            GENIE_KITS_ROOT: join(unpackDir, ".genie", "kits"),
            GENIE_PROJECTS_ROOT: join(unpackDir, ".genie", "projects"),
            GENIE_LLM_BASE_URL: "https://example.invalid/v1",
            GENIE_LLM_API_KEY: "mcpb-smoke-not-a-real-key",
            OAUTH_HS256_KEY: "mcpb-smoke-not-a-real-signing-key",
          },
        });
        expect(cli.error).toBeUndefined();
        expect(cli.status, cli.stderr).toBe(0);
        expect(cli.stderr).not.toContain("Secret validation failed");
      } finally {
        rmSync(unpackDir, { recursive: true, force: true });
      }
    },
    10 * 60_000,
  );
});
