/**
 * #311 / DRO-1363 — reachability of the packages the server lazily `import()`s.
 *
 * `preview` and `refine` both load an optional package at runtime through a
 * non-literal specifier, so `tsc` never resolves it and no in-repo test ever
 * notices when it is missing: inside this workspace pnpm links it as a
 * `devDependency` and every import succeeds. Published, devDependencies are
 * never installed for a consumer, so a package declared ONLY there can never
 * resolve from `npm i -g @ambitresearch/genie` — `preview` silently degraded to
 * the `file://` fallback for every npm user until #311.
 *
 * The invariant below is the cheap check that would have caught it: each lazily
 * imported package must sit in a dependency field a consumer actually receives.
 * `peerDependencies` + `peerDependenciesMeta.optional` is the only npm
 * relationship meaning "the server can drive this but will not install it for
 * you" — npm and pnpm both skip optional peers, so the server core stays
 * independent of the preview framework (CLAUDE.md; RFC §4) and the `.mcpb` size
 * budget is untouched (`mcpb-bundle.test.ts` separately asserts the viewer is
 * ABSENT from the bundle). A hard `dependencies`/`optionalDependencies` edge
 * would satisfy "reachable" while breaking both, so it is rejected too.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serverDir = join(repoRoot, "packages", "server");
const serverPackagePath = join(serverDir, "package.json");

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/**
 * The runtime-optional packages, each paired with the source file whose lazy
 * `import()` needs it to resolve. Keep this list in step with those call sites:
 * adding a new lazily-imported package without adding it here is exactly the
 * omission that produced #311.
 */
const LAZILY_IMPORTED_PACKAGES = [
  { name: "@ambitresearch/genie-viewer", importedBy: "src/tools/preview.ts" },
  { name: "playwright", importedBy: "src/tools/refine.ts" },
] as const;

const serverPackage = JSON.parse(readFileSync(serverPackagePath, "utf8")) as PackageManifest;

describe("optional runtime peers are reachable from a consumer install", () => {
  it.each(LAZILY_IMPORTED_PACKAGES)(
    "declares $name as an optional peer (lazily imported by $importedBy)",
    ({ name }) => {
      const range = serverPackage.peerDependencies?.[name];
      expect(
        range,
        `${name} is imported at runtime but is in no consumer-visible dependency field. ` +
          `A devDependency is not published to consumers, so the import can only ever ` +
          `resolve inside this workspace (#311).`,
      ).toBeTypeOf("string");

      expect(
        serverPackage.peerDependenciesMeta?.[name]?.optional,
        `${name} must be marked peerDependenciesMeta.optional so npm/pnpm skip installing ` +
          `it; a required peer would pull the whole preview framework into every install.`,
      ).toBe(true);
    },
  );

  it.each(LAZILY_IMPORTED_PACKAGES)(
    "keeps $name out of dependencies and optionalDependencies",
    ({ name }) => {
      expect(
        serverPackage.dependencies?.[name],
        `${name} must not be a hard dependency — it would ship the preview framework to ` +
          `every server install and blow the .mcpb size budget.`,
      ).toBeUndefined();
      expect(serverPackage.optionalDependencies?.[name]).toBeUndefined();
    },
  );

  it.each(LAZILY_IMPORTED_PACKAGES)(
    "keeps the $name devDependency so the workspace still links it for tests",
    ({ name }) => {
      // The optional peer declares the CONTRACT; the devDependency is what makes
      // the package present in this repo, so in-repo suites and CI exercise the
      // real boot path rather than only the degraded one.
      expect(serverPackage.devDependencies?.[name]).toBeTypeOf("string");
    },
  );

  it.each(LAZILY_IMPORTED_PACKAGES)(
    "pins $name to a plain semver range npm can resolve, not a workspace: specifier",
    ({ name }) => {
      // Release publishes with raw `npm pack` / `npm publish` (release.yml), which
      // — unlike `pnpm publish` — does NOT rewrite pnpm's `workspace:` protocol.
      // A `workspace:*` peer range would therefore ship verbatim and be
      // meaningless to a consumer's package manager.
      const range = serverPackage.peerDependencies?.[name] ?? "";
      expect(range).not.toMatch(/^workspace:/);
      expect(range).toMatch(/\d+\.\d+\.\d+/);
    },
  );
});

/**
 * The source manifest above is not quite what a consumer receives: `npm pack`
 * normalizes on the way out, and the release workflow already treats silent
 * field rewriting as a release-blocking regression (it greps the publish log
 * for "auto-corrected" — a `./`-prefixed `bin` target was dropped that way
 * once). Re-reading the fields off a REAL packed tarball closes that gap
 * without a network install: this is the exact `package.json` that lands in a
 * consumer's `node_modules`.
 */
describe("the packed consumer tarball keeps the optional peers", () => {
  let workDir: string | undefined;

  afterAll(() => {
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  });

  it("declares each optional peer in the manifest npm actually publishes", () => {
    workDir = mkdtempSync(join(tmpdir(), "genie-pack-"));
    // `npm pack` is offline and runs no lifecycle script for this package, so
    // this stays hermetic and sub-second. `dist/` need not be built: only the
    // manifest is under test.
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", workDir], {
      cwd: serverDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const filename = (JSON.parse(packOutput) as { filename: string }[])[0]?.filename;
    expect(filename).toBeTypeOf("string");

    const packedManifest = JSON.parse(
      execFileSync("tar", ["-xzOf", join(workDir, filename as string), "package/package.json"], {
        encoding: "utf8",
      }),
    ) as PackageManifest;

    for (const { name } of LAZILY_IMPORTED_PACKAGES) {
      expect(
        packedManifest.peerDependencies?.[name],
        `${name} survived in the source manifest but not in the packed tarball, so a ` +
          `consumer install still cannot reach it.`,
      ).toBeTypeOf("string");
      expect(packedManifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
      expect(packedManifest.dependencies?.[name]).toBeUndefined();
    }
  });
});
