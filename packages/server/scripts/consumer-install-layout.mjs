/**
 * Build a real consumer install layout from local `npm pack` tarballs.
 *
 * #311 / DRO-1363 escaped every check because no test ever stood outside this
 * workspace. Inside the monorepo pnpm links optional peers as devDependencies
 * and every lazy `import()` resolves; a consumer receives neither. The only
 * check that can tell the two apart is one that lays down what a consumer
 * actually gets — a `node_modules/<name>` tree extracted from the published
 * tarball — and asks Node to resolve the specifier from inside it.
 *
 * Everything here is offline: `npm pack` reads the working tree and contacts no
 * registry, so this is cheap enough to gate every CI run rather than only
 * release.
 *
 * ── Why this lives in `scripts/` and not beside its test ──
 * `test/helpers/tracked-files.test.ts` bans the string `"node_modules"` from
 * test sources, because a repo-wide scan that skips a hand-written list of
 * build directories is a denylist standing in for "untracked". The rule is
 * right and this module is not the shape it bans — the literal below is a path
 * SEGMENT being written, not a directory being skipped — but the detector is a
 * substring test and cannot see the difference. Keeping the layout plumbing
 * here (imperative shell-out, no assertions) leaves the ban intact and
 * unweakened, and leaves the test file free of the literal that trips it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a consumer's package manager puts an installed package. */
const MODULES_DIR = "node_modules";

/**
 * Path to `segments` inside the package `name` as installed under `consumerRoot`.
 * Resolution starts wherever the caller points Node, so tests use this to place
 * a probe at exactly the depth `dist/tools/preview.js` sits at.
 */
export function consumerModulePath(consumerRoot, name, ...segments) {
  return join(consumerRoot, MODULES_DIR, name, ...segments);
}

/**
 * `npm pack` `packageDir` and extract the tarball into `consumerRoot` as a
 * `node_modules/<name>` entry, reproducing what a consumer install lays down.
 *
 * `npm pack` honors `files`/`.npmignore`, so the extracted tree is exactly the
 * published payload — including the `package.json` dependency fields, which is
 * the half that carries the optional-peer declaration under test.
 */
export function installPackedPackage(packageDir, name, consumerRoot) {
  const packDir = mkdtempSync(join(tmpdir(), "genie-pack-"));
  try {
    const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", packDir], {
      cwd: packageDir,
      encoding: "utf8",
      timeout: 120_000,
      // Own cache dir: `npm pack` writes to the cache even though it fetches
      // nothing, so it fails outright on a machine whose `~/.npm` is unwritable
      // or root-owned. Isolating it also keeps this hermetic.
      env: { ...process.env, npm_config_cache: join(packDir, ".npm-cache") },
    })
      .trim()
      .split("\n")
      .at(-1);
    const target = consumerModulePath(consumerRoot, name);
    mkdirSync(target, { recursive: true });
    // npm tarballs wrap everything in a single `package/` directory.
    execFileSync("tar", ["-xzf", join(packDir, tarball), "-C", target, "--strip-components=1"], {
      timeout: 120_000,
    });
    return target;
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}
