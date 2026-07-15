/**
 * M5-05 / DRO-277 — `.mcpb` bundle packaging integrity checks.
 *
 * Two things are asserted here:
 *   1. `mcpb/manifest.json` is present and has the shape Claude Desktop's
 *      installer requires (AC1) — a static check, always runs.
 *   2. Running `pnpm bundle:mcpb` actually produces `dist/genie.mcpb` under
 *      the 30 MB AC4 budget (AC2/AC3/AC4) — this invokes the real
 *      `@anthropic-ai/mcpb` CLI via `npx`, so it is skipped when that isn't
 *      reachable (no network / no registry access), rather than failing a
 *      build for an environment reason. When it does run, it is the
 *      strongest signal we have that the packaging pipeline works — it is
 *      NOT a substitute for AC5 (macOS double-click install into Claude
 *      Desktop), which cannot be exercised from a headless Linux sandbox and
 *      needs a manual verification pass on real hardware.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifestPath = join(repoRoot, "mcpb", "manifest.json");
const bundleScript = join(repoRoot, "scripts", "bundle-mcpb.mjs");
const outFile = join(repoRoot, "dist", "genie.mcpb");
const MAX_BYTES = 30 * 1024 * 1024;

function hasNetworkRegistry(): boolean {
  try {
    execFileSync("npx", ["--yes", "@anthropic-ai/mcpb", "--version"], {
      stdio: "pipe",
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

describe("mcpb bundle manifest (AC1)", () => {
  it("mcpb/manifest.json exists and declares the required fields", () => {
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.manifest_version).toBeTruthy();
    expect(manifest.name).toBe("genie");
    expect(manifest.version).toBeTruthy();
    expect(manifest.server?.type).toBe("node");
    expect(manifest.server?.entry_point).toBeTruthy();
    expect(manifest.server?.mcp_config?.command).toBeTruthy();
    expect(Array.isArray(manifest.server?.mcp_config?.args)).toBe(true);
    // stdio is implied by genie's own default transport when piped, and the
    // manifest must invoke the server with an explicit `--transport stdio`
    // flag so Claude Desktop's own process pipe negotiates correctly.
    expect(manifest.server.mcp_config.args.join(" ")).toContain("stdio");

    // Env-var requirements (implementation notes: GENIE_LLM_API_KEY etc.)
    // must be surfaced as `user_config` so Claude Desktop prompts for them —
    // never hardcoded into the manifest.
    expect(manifest.user_config).toBeTruthy();
    const userConfigValues = JSON.stringify(manifest.user_config);
    expect(userConfigValues).not.toMatch(/sk-|Bearer |secret_/i);
  });
});

describe("mcpb bundle output (AC2/AC3/AC4)", () => {
  const canReachRegistry = hasNetworkRegistry();

  it.skipIf(!canReachRegistry)(
    "pnpm bundle:mcpb produces dist/genie.mcpb under the 30 MB AC4 budget",
    () => {
      rmSync(outFile, { force: true });
      execFileSync("node", [bundleScript], {
        cwd: repoRoot,
        stdio: "pipe",
        timeout: 10 * 60_000,
      });

      expect(existsSync(outFile)).toBe(true);
      const { size } = statSync(outFile);
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(MAX_BYTES);
    },
    10 * 60_000,
  );

  if (!canReachRegistry) {
    it("skipped: no network access to the @anthropic-ai/mcpb registry package in this environment", () => {
      expect(canReachRegistry).toBe(false);
    });
  }
});
