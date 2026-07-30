/**
 * The published `@ambitresearch/genie` must be able to reach the live preview
 * viewer.
 *
 * `@ambitresearch/genie-viewer` was only ever a `devDependency` of the server
 * package. Inside the monorepo pnpm links it through `workspace:*`, so
 * `preview`'s lazy `import("@ambitresearch/genie-viewer")` resolved and every
 * in-repo test and CI job saw a working booter. The published tarball drops
 * devDependencies, so the same import could never resolve for an npm install —
 * and because the `file://` degradation is intentional and silent, nothing
 * failed loudly. Two green checks, one uncovered axis: `verify-packaged-viewer`
 * proves the grid shell works *without* the viewer, and #308 proves the booter
 * works *inside the workspace*. Neither asks whether a consumer can obtain it.
 *
 * These are the checks that close that axis:
 *   1. the manifest DECLARES the relationship (an optional peer), so "in no
 *      dependency field at all" is a test failure rather than a silent gap;
 *   2. a real consumer `node_modules` layout, built from `npm pack` tarballs,
 *      resolves the specifier when the viewer is installed alongside and
 *      classifies its absence as `not-installed` when it is not.
 *
 * (2) is deliberately hermetic — it packs local tarballs and never contacts a
 * registry — so it can gate every CI run instead of only release.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VIEWER_PACKAGE_NAME, isViewerPackageMissing } from "../src/tools/preview.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serverPackageDir = join(repoRoot, "packages", "server");
const viewerPackageDir = join(repoRoot, "packages", "viewer");
const serverPackage = JSON.parse(
  readFileSync(join(serverPackageDir, "package.json"), "utf8"),
) as PackageJson;
const viewerPackage = JSON.parse(
  readFileSync(join(viewerPackageDir, "package.json"), "utf8"),
) as PackageJson;

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

describe("viewer optional-peer declaration", () => {
  it("🔒 declares the viewer as an OPTIONAL peer, in some dependency field", () => {
    // The original defect verbatim: the viewer appeared in neither
    // `dependencies`, `optionalDependencies`, nor `peerDependencies`, so a
    // consumer had no declared way to learn the relationship existed.
    const declaredIn = (
      ["dependencies", "optionalDependencies", "peerDependencies"] as const
    ).filter((field) => serverPackage[field]?.[VIEWER_PACKAGE_NAME] !== undefined);
    expect(declaredIn, `${VIEWER_PACKAGE_NAME} is in no dependency field`).not.toHaveLength(0);

    expect(serverPackage.peerDependencies?.[VIEWER_PACKAGE_NAME]).toBeTypeOf("string");
    expect(serverPackage.peerDependenciesMeta?.[VIEWER_PACKAGE_NAME]?.optional).toBe(true);
  });

  it("🔒 keeps the viewer out of the fields that would auto-install Vite", () => {
    // npm installs `optionalDependencies` by default — they are production deps
    // that merely tolerate install failure. Either of these would drag Vite into
    // every server install, contradicting the server core's independence from
    // the preview framework (CLAUDE.md) and the `.mcpb` bundle's size budget,
    // which separately asserts the viewer is absent from the bundle.
    expect(serverPackage.dependencies?.[VIEWER_PACKAGE_NAME]).toBeUndefined();
    expect(serverPackage.optionalDependencies?.[VIEWER_PACKAGE_NAME]).toBeUndefined();
    // Still a workspace devDependency, or the monorepo could not build or test
    // the booter's success path at all (#308).
    expect(serverPackage.devDependencies?.[VIEWER_PACKAGE_NAME]).toBe("workspace:*");
  });

  it("🔒 the declared peer range admits the viewer version this repo ships", () => {
    // A `>=x.y.z` floor survives release-please's independent viewer bumps, so
    // this pins the half that can actually rot: the floor must not drift above
    // the version in the workspace.
    const range = serverPackage.peerDependencies?.[VIEWER_PACKAGE_NAME] ?? "";
    const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/u.exec(range);
    expect(floor, `expected a ">=x.y.z" floor, got ${JSON.stringify(range)}`).not.toBeNull();
    const shipped = /^(\d+)\.(\d+)\.(\d+)/u.exec(viewerPackage.version);
    expect(shipped, `unparsable viewer version ${viewerPackage.version}`).not.toBeNull();
    const asNumbers = (m: RegExpExecArray): number[] => [Number(m[1]), Number(m[2]), Number(m[3])];
    const [floorParts, shippedParts] = [asNumbers(floor!), asNumbers(shipped!)];
    const compared = floorParts.findIndex((part, i) => part !== shippedParts[i]);
    expect(
      compared === -1 || floorParts[compared]! < shippedParts[compared]!,
      `peer floor ${range} is above the shipped viewer ${viewerPackage.version}`,
    ).toBe(true);
  });

  it("documents the separate install in the user-facing installation guide", () => {
    // The declaration is machine-readable; this is the half a human reads.
    const installation = readFileSync(join(repoRoot, "docs", "user", "installation.md"), "utf8");
    expect(installation).toContain(VIEWER_PACKAGE_NAME);
    expect(installation).toMatch(new RegExp(`npm i(nstall)? -g[^\\n]*${VIEWER_PACKAGE_NAME}`, "u"));
  });
});

/**
 * Both packages declare `files: ["dist"]`, so `npm pack` on an unbuilt package
 * produces a tarball with no `dist` at all and every assertion below would pass
 * vacuously. The CI `test` leg is a sibling of the `build` leg, not a successor,
 * so it arrives here with no `dist` — this check therefore builds what it needs
 * rather than skipping (a skip would reintroduce exactly the silent-gap failure
 * mode this file exists to close). A local run that already built pays nothing.
 */
function ensureBuilt(): void {
  for (const [dir, entry, filter] of [
    [serverPackageDir, join("dist", "tools", "preview.js"), serverPackage.name],
    [viewerPackageDir, join("dist", "index.js"), viewerPackage.name],
  ] as const) {
    if (existsSync(join(dir, entry))) continue;
    execFileSync("pnpm", ["--filter", filter, "build"], {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 10 * 60_000,
    });
    if (!existsSync(join(dir, entry))) {
      throw new Error(`\`pnpm --filter ${filter} build\` did not produce ${entry}`);
    }
  }
}

/**
 * Pack `packageDir` with `npm pack` and extract it into `destination` as a
 * `node_modules/<name>` entry, reproducing what a consumer install lays down.
 * `npm pack` honors `files`/`.npmignore`, so the extracted tree is exactly the
 * published payload — including its `package.json` dependency fields.
 */
function installPackedPackage(packageDir: string, name: string, destination: string): void {
  const packDir = mkdtempSync(join(tmpdir(), "genie-pack-"));
  try {
    const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", packDir], {
      cwd: packageDir,
      encoding: "utf8",
      timeout: 120_000,
      // Own cache dir: `npm pack` writes to the cache even though it fetches
      // nothing, so it fails outright on a machine whose `~/.npm` is
      // unwritable or root-owned. Isolating it also keeps this check hermetic.
      env: { ...process.env, npm_config_cache: join(packDir, ".npm-cache") },
    })
      .trim()
      .split("\n")
      .at(-1)!;
    const target = join(destination, "node_modules", name);
    mkdirSync(target, { recursive: true });
    // npm tarballs wrap everything in a single `package/` directory.
    execFileSync("tar", ["-xzf", join(packDir, packed), "-C", target, "--strip-components=1"], {
      timeout: 120_000,
    });
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

/** What a real `import("@ambitresearch/genie-viewer")` did, run as a consumer would. */
interface ProbeResult {
  resolved: boolean;
  code?: string;
  message?: string;
}

describe("consumer install shape (hermetic — no registry)", () => {
  it(
    "🔒 reaches the viewer only when it is installed alongside the server",
    () => {
      ensureBuilt();

      const consumer = mkdtempSync(join(tmpdir(), "genie-consumer-"));
      try {
        installPackedPackage(serverPackageDir, serverPackage.name, consumer);

        const installedManifest = JSON.parse(
          readFileSync(join(consumer, "node_modules", serverPackage.name, "package.json"), "utf8"),
        ) as PackageJson;
        // Survives packing: `npm pack` could not have stripped the declaration.
        expect(installedManifest.peerDependenciesMeta?.[VIEWER_PACKAGE_NAME]?.optional).toBe(true);

        // The probe sits inside the installed server package, so resolution
        // starts exactly where `dist/tools/preview.js` starts. It imports the
        // bare specifier directly rather than going through `preview.js` —
        // that module pulls in the server's own runtime dependencies, which a
        // registry-free layout does not have, and resolution is the only axis
        // under test here.
        const probePath = join(
          consumer,
          "node_modules",
          serverPackage.name,
          "dist",
          "tools",
          "peer-probe.mjs",
        );
        writeFileSync(
          probePath,
          [
            `const specifier = ${JSON.stringify(VIEWER_PACKAGE_NAME)};`,
            `try {`,
            `  await import(specifier);`,
            `  console.log(JSON.stringify({ resolved: true }));`,
            `} catch (error) {`,
            `  console.log(JSON.stringify({`,
            `    resolved: false, code: error?.code, message: String(error?.message),`,
            `  }));`,
            `}`,
          ].join("\n"),
          "utf8",
        );
        const probe = (): ProbeResult =>
          JSON.parse(
            execFileSync("node", [probePath], { encoding: "utf8", timeout: 120_000, stdio: "pipe" })
              .trim()
              .split("\n")
              .at(-1)!,
          ) as ProbeResult;

        // Server alone — the reported bug, reproduced against a real packed
        // install. `isViewerPackageMissing` must recognize Node's actual error,
        // because that classification is what earns the user the install hint.
        const serverOnly = probe();
        expect(serverOnly.resolved).toBe(false);
        expect(
          isViewerPackageMissing(serverOnly),
          `unclassified: ${serverOnly.code} ${serverOnly.message}`,
        ).toBe(true);

        // Viewer installed alongside, exactly as `npm i -g <server> <viewer>`
        // lays it out: both under one `node_modules/@ambitresearch/`, which the
        // bare specifier resolves. This is what makes the documented remedy
        // real rather than aspirational.
        installPackedPackage(viewerPackageDir, viewerPackage.name, consumer);
        const withViewer = probe();
        // The viewer's own runtime deps (vite, ws, …) are absent from this
        // registry-free layout, so the import may still fail — but never again
        // for the reason that the viewer package itself cannot be found.
        expect(
          isViewerPackageMissing(withViewer),
          `still reported missing: ${withViewer.code} ${withViewer.message}`,
        ).toBe(false);
      } finally {
        rmSync(consumer, { recursive: true, force: true });
      }
    },
    15 * 60_000,
  );
});
