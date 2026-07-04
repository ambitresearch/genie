/**
 * AC6 fault-injection coverage for M3-03's manifest compiler (DRO-259):
 * "atomic write: write to `.genie/manifest.json.tmp`, fsync, rename" must mean
 * a rename failure never leaves a partially-written (or wrongly-truncated)
 * file at the destination path — the prior manifest (or none) must survive
 * untouched.
 *
 * Kept in its own file — `vi.mock` at module scope would otherwise affect
 * every other test in `compiler.test.ts` — mirroring
 * `tools/write_files.rollback.test.ts`'s own documented reasoning for
 * isolating its fault-injected `rm()` mock the same way.
 */
import { mkdir, mkdtemp, readFile, rm as realRm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RenameFn = typeof import("node:fs/promises").rename;

/** Absolute destination paths whose *next* rename() call should throw (one-shot). */
let failRenameOnce: Set<string>;

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const rename: RenameFn = async (oldPath, newPath) => {
    const target = newPath.toString();
    if (failRenameOnce?.has(target)) {
      failRenameOnce.delete(target); // one-shot: only this specific call fails
      throw Object.assign(new Error("simulated EIO renaming " + target), { code: "EIO" });
    }
    return actual.rename(oldPath, newPath);
  };
  return { ...actual, rename };
});

const { compileManifest } = await import("./compiler.js");
const { MANIFEST_PATH } = await import("../store/manifest.js");

async function writeComponent(root: string, group: string, name: string): Promise<void> {
  const dir = join(root, "components", group, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.html`), `<!-- @genie group="${group}" -->\n<div/>`);
}

describe("compileManifest — AC6 atomic-write fault injection", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "genie-manifest-atomic-"));
    failRenameOnce = new Set();
  });

  afterEach(async () => {
    await realRm(root, { recursive: true, force: true });
  });

  it("propagates a rename failure and leaves the PRIOR manifest untouched (never a half-write)", async () => {
    await writeComponent(root, "actions", "Button");
    await compileManifest(root); // prime a valid manifest
    const destPath = join(root, MANIFEST_PATH);
    const priorRaw = await readFile(destPath, "utf-8");

    await writeComponent(root, "actions", "Second");
    failRenameOnce.add(destPath);

    await expect(compileManifest(root)).rejects.toThrow("simulated EIO");

    const afterRaw = await readFile(destPath, "utf-8");
    expect(afterRaw).toBe(priorRaw); // untouched — the prior valid manifest survives
  });

  it("propagates a rename failure and leaves NO manifest when there was none before (never a half-write)", async () => {
    await writeComponent(root, "actions", "Button");
    const destPath = join(root, MANIFEST_PATH);
    failRenameOnce.add(destPath);

    await expect(compileManifest(root)).rejects.toThrow("simulated EIO");

    await expect(readFile(destPath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up its staging directory even when the rename fails", async () => {
    await writeComponent(root, "actions", "Button");
    const destPath = join(root, MANIFEST_PATH);
    failRenameOnce.add(destPath);

    await expect(compileManifest(root)).rejects.toThrow("simulated EIO");

    // The compiler's own `finally` block removes its mkdtemp-created staging
    // subdirectory even on a thrown rename — so `.genie-tmp` itself may still
    // exist (mkdir'd up front) but must be empty, never left holding an
    // orphaned staged manifest.json.
    const { readdir } = await import("node:fs/promises");
    const staged = await readdir(join(root, ".genie-tmp")).catch(() => []);
    expect(staged).toEqual([]);
  });
});
