#!/usr/bin/env node
/**
 * Build dist/genie.mcpb — the Claude Desktop double-click installer bundle
 * (M5-05, DRO-277). Uses the `modelcontextprotocol/mcpb` toolchain, published
 * to npm under its still-current package name `@anthropic-ai/mcpb` (the
 * `anthropics/dxt` -> `mcpb` rename landed in the GitHub org/repo before the
 * npm package name caught up — `@modelcontextprotocol/mcpb` 404s on the
 * registry as of this writing; re-check before GA per BRD R-14 and repoint
 * the pinned project dependency if the scoped name ships).
 *
 * Steps:
 *   1. `pnpm --filter @genie/server build` (idempotent if already built).
 *   2. Use `pnpm deploy --prod` to stage the server and its production-only
 *      runtime dependencies from the committed workspace lockfile, including
 *      esbuild binaries for both supported Darwin architectures. A hoisted
 *      linker keeps the self-contained archive below the 30 MB budget.
 *   3. Stage the root `mcpb/manifest.json` alongside it.
 *   4. Run the lockfile-pinned MCPB CLI with `pnpm exec`.
 *   5. Verify the artefact exists and is under the 30 MB AC4 budget.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(repoRoot, "mcpb", ".stage");
const deployDir = join(stageDir, "server");
const distDir = join(repoRoot, "dist");
const outFile = join(distDir, "genie.mcpb");

const MAX_BYTES = 30 * 1024 * 1024; // AC4 — < 30 MB compressed

function run(cmd, args, opts = {}) {
  process.stdout.write(`+ ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
}

// 1. Build the server (safe to re-run; each build step is itself idempotent).
run("pnpm", ["--filter", "@genie/server", "build"]);

// 2. Fresh stage dir every run so stale files never leak into the bundle.
rmSync(stageDir, { recursive: true, force: true });
run("pnpm", [
  "--filter",
  "@genie/server",
  "deploy",
  deployDir,
  "--prod",
  "--frozen-lockfile",
  "--config.inject-workspace-packages=true",
  "--config.node-linker=hoisted",
  "--config.package-import-method=copy",
  "--os",
  "darwin",
  "--cpu",
  "arm64",
  "--cpu",
  "x64",
]);

// pnpm copies the host esbuild binary into esbuild/bin as well as installing
// both requested @esbuild packages. The module resolves @esbuild/<platform>
// directly at runtime, so remove the redundant binary and its now-broken CLI
// shim to retain one binary per Darwin architecture within the size budget.
rmSync(join(deployDir, "node_modules", "esbuild", "bin", "esbuild"), { force: true });
rmSync(join(deployDir, "node_modules", ".bin", "esbuild"), { force: true });
rmSync(join(deployDir, "node_modules", "esbuild", "node_modules", ".bin", "esbuild"), {
  force: true,
});

// 3. Copy the manifest in alongside the deployed server tree.
cpSync(join(repoRoot, "mcpb", "manifest.json"), join(stageDir, "manifest.json"));

// 4. Pack. `dist/` must exist before mcpb writes into it.
mkdirSync(distDir, { recursive: true });
rmSync(outFile, { force: true });
run("pnpm", ["exec", "mcpb", "pack", stageDir, outFile]);

// 5. Integrity + size check (AC4, and the "Tests added" DoD item).
if (!existsSync(outFile)) {
  throw new Error(`bundle-mcpb: expected ${outFile} to exist after pack`);
}
const { size } = statSync(outFile);
const sizeMb = (size / (1024 * 1024)).toFixed(2);
process.stdout.write(`bundle-mcpb: wrote ${outFile} (${sizeMb} MB)\n`);
if (size >= MAX_BYTES) {
  throw new Error(
    `bundle-mcpb: genie.mcpb is ${sizeMb} MB, over the ${MAX_BYTES / (1024 * 1024)} MB AC4 budget`,
  );
}

// Clean up the staging tree — only dist/genie.mcpb is the shipped artefact.
rmSync(stageDir, { recursive: true, force: true });
