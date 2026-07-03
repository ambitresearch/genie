/**
 * ESM interop regression guard for the `micromatch` import in this module.
 *
 * `micromatch` is CommonJS and assigns `isMatch` dynamically, so
 * cjs-module-lexer cannot surface it as a named ESM export. Under **native
 * Node ESM** (how the built `dist/` runs in production), a namespace import
 * (`import * as micromatch`) lands the real module under `.default`, leaving
 * `micromatch.isMatch` `undefined` — so `pathMatchesGlobs` throws
 * "micromatch.isMatch is not a function" at runtime. The correct form is a
 * default import (`import micromatch from "micromatch"`).
 *
 * Vitest's module interop is lenient and resolves the namespace import anyway,
 * so an in-process vitest test CANNOT catch this regression — it passes with
 * the broken import too (verified). This guard therefore shells out to a real
 * ESM loader (`tsx`, which mirrors native Node's CJS/ESM interop) and asserts
 * `pathMatchesGlobs` actually returns a value. If someone reverts the import to
 * `import * as micromatch`, the subprocess throws and this test goes red —
 * where a normal unit test would stay green and ship a broken build.
 *
 * This exists because `delete_files` (M1-09) is the first *runtime* consumer of
 * `pathMatchesGlobs`; before it, the latent bug never executed outside tests.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const planModule = resolve(packageRoot, "src", "plans", "index.ts");
// pathToFileURL produces a correct, URL-encoded file:// URL across platforms
// (Windows drive letters/backslashes, spaces, `#`, …) — string concatenation
// (`"file://" + planModule`) does not.
const planModuleUrl = pathToFileURL(planModule).href;

describe("plans/index micromatch ESM interop (native-loader guard)", () => {
  it("pathMatchesGlobs works under native Node ESM (not just vitest interop)", () => {
    // Dynamic-import the module under `tsx` and call pathMatchesGlobs. Print a
    // sentinel with the boolean result; a broken import throws before printing.
    const script = `import(${JSON.stringify(planModuleUrl)})
      .then((m) => {
        const hit = m.pathMatchesGlobs("_preview/Button.html", ["_preview/*.html"]);
        const miss = m.pathMatchesGlobs("keep.txt", ["_preview/*.html"]);
        process.stdout.write("GUARD:" + hit + ":" + miss);
      })
      .catch((e) => {
        process.stderr.write("GUARD_ERR:" + (e && e.message ? e.message : String(e)));
        process.exit(7);
      });`;

    const result = spawnSync("npx", ["tsx", "-e", script], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 60_000,
    });

    // A non-zero exit (or the interop throw) fails the guard with the real error.
    expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("GUARD:true:false");
  });
});
