/**
 * AC6 regression: a failure between the manifest compiler's tmp-file write
 * and its final `rename()` must leave the PRIOR `.genie/manifest.json`
 * untouched — never a half-written file.
 *
 * Kept in its own file, mirroring `tools/write_files.rollback.test.ts`'s
 * established pattern for the same underlying constraint: `vi.spyOn` cannot
 * redefine a named ESM export (`node:fs/promises.rename` in this case —
 * confirmed by `TypeError: Cannot redefine property: rename` when tried
 * inline in `compiler.test.ts`), and `vi.mock` is hoisted to module scope, so
 * it would otherwise fault-inject `rename` for every other test in a shared
 * file. A dedicated file scopes the mock to exactly this one concern.
 */
import { mkdir, mkdtemp, readFile, rm as realRm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RenameFn = typeof import("node:fs/promises").rename;

/** When true, the *next* rename() call throws (one-shot). */
let failRenameOnce = false;

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const rename: RenameFn = async (oldPath, newPath) => {
    if (failRenameOnce) {
      failRenameOnce = false; // one-shot: only this specific call fails
      throw new Error("simulated crash between tmp write and rename");
    }
    return actual.rename(oldPath, newPath);
  };
  return { ...actual, rename };
});

const { compileManifest } = await import("./compiler.js");

async function tempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-manifest-compiler-atomic-"));
}

async function scaffoldComponent(projectRoot: string, group: string, name: string): Promise<void> {
  const dir = join(projectRoot, "components", group, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.html`),
    `<!-- @genie group="${group}" viewport="400x200" -->\n<div>${name}</div>\n`,
    "utf-8",
  );
}

describe("manifest/compiler — AC6 atomic-write crash safety", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await tempProjectRoot();
    failRenameOnce = false;
  });

  afterEach(async () => {
    failRenameOnce = false;
    await realRm(projectRoot, { recursive: true, force: true });
  });

  it("a failure between the tmp write and the rename leaves the PRIOR manifest untouched (never a half-written file)", async () => {
    await scaffoldComponent(projectRoot, "actions", "Button");
    await compileManifest(projectRoot); // establish a prior, good manifest
    const priorRaw = await readFile(join(projectRoot, ".genie", "manifest.json"), "utf-8");

    await scaffoldComponent(projectRoot, "actions", "Second");

    failRenameOnce = true;
    await expect(compileManifest(projectRoot)).rejects.toThrow(
      "simulated crash between tmp write and rename",
    );

    const afterRaw = await readFile(join(projectRoot, ".genie", "manifest.json"), "utf-8");
    expect(afterRaw).toBe(priorRaw); // untouched — still only "Button", not "Second"

    // The failed attempt's staging directory is cleaned up (the compiler's
    // `finally` block removes it even when rename() itself throws) — no
    // orphaned .genie-tmp/manifest-* directory left behind.
    const { readdir } = await import("node:fs/promises");
    const tmpEntries = await readdir(join(projectRoot, ".genie-tmp")).catch(() => []);
    expect(tmpEntries).toEqual([]);
  });

  it("a subsequent successful compile recovers cleanly after a crashed attempt", async () => {
    await scaffoldComponent(projectRoot, "actions", "Button");
    await compileManifest(projectRoot);

    await scaffoldComponent(projectRoot, "actions", "Second");
    failRenameOnce = true;
    await expect(compileManifest(projectRoot)).rejects.toThrow();

    // No lingering lock/tmp state blocks the next attempt.
    const manifest = await compileManifest(projectRoot);
    expect(manifest.components.map((c) => c.name).sort()).toEqual(["Button", "Second"]);
  });
});
