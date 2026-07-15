#!/usr/bin/env node
/**
 * Build dist/genie.mcpb — the Claude Desktop double-click installer bundle
 * (M5-05, DRO-277). Uses the `modelcontextprotocol/mcpb` toolchain, published
 * to npm under its still-current package name `@anthropic-ai/mcpb` (the
 * `anthropics/dxt` -> `mcpb` rename landed in the GitHub org/repo before the
 * npm package name caught up — `@modelcontextprotocol/mcpb` 404s on the
 * registry as of this writing; re-check before GA per BRD R-14 and repoint
 * the `npx` call below if the scoped name ships).
 *
 * Steps:
 *   1. `pnpm --filter @genie/server build` (idempotent if already built).
 *   2. Copy `packages/server/dist` + a devDependency-stripped `package.json`
 *      into `mcpb/.stage/server/`, then `npm install --omit=dev` there.
 *      This (not `pnpm deploy`) is deliberate: pnpm's content-addressable
 *      store keeps every dependency as a real file under
 *      `node_modules/.pnpm/<pkg>/node_modules/<pkg>` *and* a symlink at
 *      `node_modules/<pkg>`. mcpb's packer dereferences symlinks and archives
 *      the file bytes at both locations, roughly doubling-to-5x'ing unpacked
 *      size depending on linker mode:
 *        - `pnpm deploy --prod --legacy`             -> 262 MB unpacked / 82 MB packed
 *        - `pnpm deploy --prod --legacy --node-linker=hoisted` -> 75 MB unpacked / 25 MB packed (still cutting the 30 MB AC4 budget close)
 *        - plain `npm install --omit=dev` (this script) -> 53 MB unpacked / 16 MB packed
 *      A flat npm-installed tree has no such duplication and gives real
 *      headroom under AC4.
 *   3. Stage the root `mcpb/manifest.json` alongside it.
 *   4. `npx @anthropic-ai/mcpb pack mcpb/.stage dist/genie.mcpb`.
 *   5. Verify the artefact exists and is under the 30 MB AC4 budget.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  statSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "packages", "server");
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
mkdirSync(deployDir, { recursive: true });

cpSync(join(serverDir, "dist"), join(deployDir, "dist"), { recursive: true });

const pkg = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"));
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(deployDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

// `--ignore-scripts` — the bundle only needs prebuilt dist output; installer
// scripts from third-party deps have no business running unreviewed during
// packaging.
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], {
  cwd: deployDir,
});

// 3. Copy the manifest in alongside the deployed server tree.
cpSync(join(repoRoot, "mcpb", "manifest.json"), join(stageDir, "manifest.json"));

// 4. Pack. `dist/` must exist before mcpb writes into it.
mkdirSync(distDir, { recursive: true });
rmSync(outFile, { force: true });
run("npx", ["--yes", "@anthropic-ai/mcpb", "pack", stageDir, outFile]);

// 5. Integrity + size check (AC4, and the "Tests added" DoD item).
if (!existsSync(outFile)) {
  throw new Error(`bundle-mcpb: expected ${outFile} to exist after pack`);
}
const { size } = statSync(outFile);
const sizeMb = (size / (1024 * 1024)).toFixed(2);
process.stdout.write(`bundle-mcpb: wrote ${outFile} (${sizeMb} MB)\n`);
if (size > MAX_BYTES) {
  throw new Error(
    `bundle-mcpb: genie.mcpb is ${sizeMb} MB, over the ${MAX_BYTES / (1024 * 1024)} MB AC4 budget`,
  );
}

// Clean up the staging tree — only dist/genie.mcpb is the shipped artefact.
rmSync(stageDir, { recursive: true, force: true });
