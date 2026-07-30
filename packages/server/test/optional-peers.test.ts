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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { isModuleNotFoundFor } from "../src/tools/preview.js";
// The layout plumbing lives in `scripts/` rather than here on purpose; see the
// header of that module for why.
import { consumerModulePath, installPackedPackage } from "../scripts/consumer-install-layout.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serverDir = join(repoRoot, "packages", "server");
const viewerDir = join(repoRoot, "packages", "viewer");
const serverPackagePath = join(serverDir, "package.json");

interface PackageManifest {
  name: string;
  version: string;
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

/** Resolves each peer the way the server's own lazy `import()` would. */
const requireFromServer = createRequire(join(serverDir, "noop.js"));

/**
 * Minimal `^` / `>=` range check.
 *
 * Deliberately NOT the `semver` package. `semver` appears in no manifest in this
 * repo — it resolves here only as a hoisted transitive of something else — and
 * leaning on a package that merely HAPPENS to be reachable inside this workspace
 * is the exact defect this file exists to catch (#311). A guard built on one
 * would be self-defeating.
 *
 * It therefore understands only the two shapes this manifest uses and throws on
 * anything else, so a future range it cannot reason about fails the suite instead
 * of passing vacuously. `describe("rangeAdmits …")` below tests it directly.
 */
export function rangeAdmits(range: string, version: string): boolean {
  type Triple = [number, number, number];
  const parse = (value: string): Triple => {
    const core = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    if (core === null) throw new Error(`unsupported version "${value}"`);
    return [Number(core[1]), Number(core[2]), Number(core[3])];
  };
  const compare = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  const actual = parse(version);
  if (range.startsWith("^")) {
    const min = parse(range.slice(1));
    if (compare(actual, min) < 0) return false;
    // Caret bumps the LEFTMOST NON-ZERO component: `^0.2.0` stops at `0.3.0`
    // while `^1.58.2` stops at `2.0.0`. That 0.x rule is the whole reason an
    // open `>=0.2.0` was wrong for the viewer.
    const upper: Triple =
      min[0] !== 0 ? [min[0] + 1, 0, 0] : min[1] !== 0 ? [0, min[1] + 1, 0] : [0, 0, min[2] + 1];
    return compare(actual, upper) < 0;
  }
  if (range.startsWith(">=")) return compare(actual, parse(range.slice(2))) >= 0;
  throw new Error(`peer range "${range}" uses a form this guard cannot evaluate; extend it`);
}

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

  it.each(LAZILY_IMPORTED_PACKAGES)(
    "bounds the $name peer range to the version this repo actually exercises",
    ({ name }) => {
      // Drift guard. The ranges were once open-ended (`>=0.2.0`, `>=1.58.2`),
      // which declared every future release compatible: `>=0.2.0` accepts viewer
      // `0.3.0` even though SemVer permits breaking changes between `0.x` minors,
      // and `defaultViewerBooter` does an unchecked `as ViewerModuleLike` cast
      // over `bootViewer`'s CURRENT shape — a signature change would be declared
      // compatible and then fail at the cast, in a consumer's install.
      //
      // Bounding them alone would rot silently: `release-please-config.json`
      // versions server and viewer as independent components and nothing in
      // `release.yml` rewrites peer ranges, so the next viewer minor would leave
      // this range stale with nothing to notice. Hence the assertion is not
      // "the range is a caret" but "the range still admits the version CI runs
      // against" — which fails loudly at the bump instead of at a user's install.
      const range = serverPackage.peerDependencies?.[name] ?? "";
      const manifestPath = requireFromServer.resolve(`${name}/package.json`);
      const { version } = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;

      expect(
        rangeAdmits(range, version),
        `The ${name} peer range "${range}" does not admit ${version}, the version this ` +
          `workspace installs and every in-repo suite exercises. Consumers would be told a ` +
          `version we never test. Verify the new version against the lazy import site, then ` +
          `widen the range deliberately.`,
      ).toBe(true);
    },
  );
});

/**
 * The guard above is only worth having if it can actually fail, and it is
 * hand-rolled (see `rangeAdmits`), so it gets its own table rather than being
 * trusted. The `^0.2.0` / `0.3.0` row is the one that matters: it is the exact
 * case the open `>=0.2.0` range used to wave through.
 */
describe("rangeAdmits — the drift guard's own semantics", () => {
  it.each([
    // Caret on 0.x bumps the MINOR, so a 0.x minor is breaking and excluded.
    { range: "^0.2.0", version: "0.2.0", admits: true },
    { range: "^0.2.0", version: "0.2.9", admits: true },
    { range: "^0.2.0", version: "0.3.0", admits: false },
    { range: "^0.2.0", version: "0.1.9", admits: false },
    // Caret on 1.x bumps the MAJOR.
    { range: "^1.58.2", version: "1.58.2", admits: true },
    { range: "^1.58.2", version: "1.61.1", admits: true },
    { range: "^1.58.2", version: "2.0.0", admits: false },
    { range: "^1.58.2", version: "1.58.1", admits: false },
    // The open form the peers used to carry — accepts everything upward, which
    // is precisely why it was replaced.
    { range: ">=0.2.0", version: "0.3.0", admits: true },
  ])("$range admits $version → $admits", ({ range, version, admits }) => {
    expect(rangeAdmits(range, version)).toBe(admits);
  });

  it("throws on a range shape it cannot evaluate rather than passing it", () => {
    // Fail closed: a future range written as `0.2.x` or `>=0.2.0 <0.4.0` must
    // break this suite, not be silently treated as satisfied.
    expect(() => rangeAdmits("0.2.x", "0.2.0")).toThrow(/cannot evaluate/);
    expect(() => rangeAdmits("*", "0.2.0")).toThrow(/cannot evaluate/);
  });
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

/**
 * The manifest checks above assert what the package DECLARES. This one asserts
 * what Node actually DOES, from inside a real consumer layout — the only place
 * standing outside this workspace, which is exactly the vantage point #311 had
 * no check from.
 *
 * Deliberately hermetic: it packs local tarballs and never contacts a registry,
 * so it can gate every CI run rather than only release. It also needs no build
 * — the axis under test is whether the PACKAGE is found, which Node answers
 * from `package.json` alone, and both directions are asserted on the specific
 * error rather than on "it threw." (An earlier draft ran `pnpm build` inside
 * the test to avoid a feared vacuous pass; that wrote `dist/` into the working
 * tree and silently un-skipped `describe.skipIf(hasBuiltServer)` suites
 * elsewhere, making the run order-dependent. The assertions below hold built or
 * unbuilt, so the side effect bought nothing.)
 *
 * Scoped to the viewer because it is the peer this repo can pack. `playwright`
 * has the identical defect and the identical fix, but it is a third-party
 * package with no workspace tarball to lay down; the declaration invariants
 * above are what cover it.
 */
describe("a real consumer install can reach the viewer (hermetic — no registry)", () => {
  const viewerPackage = JSON.parse(
    readFileSync(join(viewerDir, "package.json"), "utf8"),
  ) as PackageManifest;
  const viewerName = "@ambitresearch/genie-viewer";

  let consumer: string | undefined;

  afterAll(() => {
    if (consumer !== undefined) rmSync(consumer, { recursive: true, force: true });
  });

  it(
    "resolves the viewer specifier only once the viewer is installed alongside",
    () => {
      consumer = mkdtempSync(join(tmpdir(), "genie-consumer-"));
      installPackedPackage(serverDir, serverPackage.name, consumer);

      // Survives packing: `npm pack` could not have stripped the declaration on
      // the way out. (`npm` does rewrite manifests silently — release.yml greps
      // the publish log for "auto-corrected" for exactly that reason.)
      const installed = JSON.parse(
        readFileSync(consumerModulePath(consumer, serverPackage.name, "package.json"), "utf8"),
      ) as PackageManifest;
      expect(installed.peerDependenciesMeta?.[viewerName]?.optional).toBe(true);

      // The probe sits at the depth `dist/tools/preview.js` sits at, so Node's
      // upward `node_modules` walk starts exactly where the real lazy import's
      // does. It imports the bare specifier directly rather than loading
      // `preview.js`, which would drag in the server's own runtime deps that a
      // registry-free layout does not have — resolution is the only axis here.
      const probePath = consumerModulePath(
        consumer,
        serverPackage.name,
        "dist",
        "tools",
        "peer-probe.mjs",
      );
      mkdirSync(dirname(probePath), { recursive: true });
      writeFileSync(
        probePath,
        [
          `const specifier = ${JSON.stringify(viewerName)};`,
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
      const probe = (): { resolved: boolean; code?: string; message?: string } =>
        JSON.parse(
          execFileSync("node", [probePath], { encoding: "utf8", timeout: 120_000, stdio: "pipe" })
            .trim()
            .split("\n")
            .at(-1) as string,
        ) as { resolved: boolean; code?: string; message?: string };

      // Server alone — #311 reproduced against a real packed install, not
      // simulated. `isModuleNotFoundFor` must recognise Node's actual error,
      // because that classification is what earns the user the install hint
      // instead of the dead-end "installed but could not start" message.
      const serverOnly = probe();
      expect(serverOnly.resolved).toBe(false);
      expect(
        isModuleNotFoundFor({ code: serverOnly.code, message: serverOnly.message }, viewerName),
        `unclassified: ${serverOnly.code} ${serverOnly.message}`,
      ).toBe(true);

      // Viewer installed alongside, exactly as `npm i -g <server> <viewer>`
      // lays it out: both under one `node_modules/@ambitresearch/`, which the
      // bare specifier resolves. This is what makes the documented remedy real
      // rather than aspirational.
      installPackedPackage(viewerDir, viewerPackage.name, consumer);
      const withViewer = probe();
      // The viewer's own runtime deps (vite, ws, …) are absent from this
      // registry-free layout, so the import may still fail — but never again
      // for the reason that the viewer package itself cannot be found.
      expect(
        isModuleNotFoundFor({ code: withViewer.code, message: withViewer.message }, viewerName),
        `still reported missing: ${withViewer.code} ${withViewer.message}`,
      ).toBe(false);
    },
    5 * 60_000,
  );
});
