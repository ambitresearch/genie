/**
 * Regression coverage for a Copilot review finding on PR #106: the rollback
 * path in the write transaction could itself fail partway through (e.g.
 * `rm()`/`rename()` hitting a permission error during undo/restore), and the
 * original code silently swallowed that second failure — aborting the rollback
 * loop early and reporting only the original commit error, as if AC10's "tree
 * ends up exactly as it was before the call" guarantee had been honored when it
 * may not have been.
 *
 * Post-DRO-565 the transaction lives in `LocalFsKitStore` (store/local.ts),
 * which still imports `rm` from `node:fs/promises` — so the same `vi.mock`
 * fault injection reaches it. This needs a SECOND, independently-triggerable
 * filesystem failure during the rollback loop itself (on top of the first
 * failure that triggers the rollback in the first place) — real-fs permission
 * bits alone can't easily target "fail only this specific undo step," so this
 * file uses `vi.mock` to inject a precise, path-targeted failure into
 * `node:fs/promises.rm`. Kept in its own file (rather than write_files.test.ts)
 * because `vi.mock` at module scope would otherwise affect every other test in
 * that file.
 */
import { mkdtemp, rm as realRm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RmFn = typeof import("node:fs/promises").rm;

/** Absolute paths whose *next* rm() call should throw (one-shot per path). */
let failRmOnce: Set<string>;

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const rm: RmFn = async (path, options) => {
    const target = path.toString();
    if (failRmOnce?.has(target)) {
      failRmOnce.delete(target); // one-shot: only this specific call fails
      throw Object.assign(new Error(`simulated EACCES removing ${target}`), { code: "EACCES" });
    }
    return actual.rm(path, options);
  };
  return { ...actual, rm };
});

const { createPlan } = await import("../plans/index.js");
const { writeFiles } = await import("./write_files.js");
const { LocalFsKitStore } = await import("../store/local.js");

const KIT_ID = "k";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("writeFiles — rollback-incomplete path (Copilot review finding)", () => {
  let localDir: string; // localPath source base
  let kitsRoot: string;
  let kitDir: string; // write destination = <kitsRoot>/<KIT_ID>
  let store: InstanceType<typeof LocalFsKitStore>;
  let genieHome: string;

  beforeEach(async () => {
    localDir = await tempDir("genie-wf-rb-local-");
    kitsRoot = await tempDir("genie-wf-rb-kits-");
    kitDir = join(kitsRoot, KIT_ID);
    store = new LocalFsKitStore(kitsRoot);
    genieHome = await tempDir("genie-wf-rb-home-");
    process.env["GENIE_HOME"] = genieHome;
    failRmOnce = new Set();
  });

  afterEach(async () => {
    delete process.env["GENIE_HOME"];
    // Use the real rm directly (not the mocked module) for guaranteed cleanup.
    await realRm(localDir, { recursive: true, force: true });
    await realRm(kitsRoot, { recursive: true, force: true });
    await realRm(genieHome, { recursive: true, force: true });
  });

  it("surfaces RollbackIncompleteError when undoing a committed file fails, instead of reporting a clean rollback", async () => {
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    await mkdir(join(kitDir, "dest"), { recursive: true });

    // Neither destination pre-exists, so the backup phase is a no-op for
    // both — isolating this test to exactly one failure mode: undoing an
    // already-committed file (the `rm(destPath, ...)` call in the rollback
    // loop), independent of the separate backup-restore failure mode.
    const committedPath = join(kitDir, "dest", "a.html"); // commits, then rollback tries to rm() it
    const failingPath = join(kitDir, "dest", "b.html"); // fails to commit, triggering rollback

    // b.html's destination directory doesn't exist as a normal dir write
    // target we can easily break via chmod without also breaking a.html
    // (they'd share the same parent), so inject the commit failure directly
    // rather than via permission bits — this keeps the test's TWO
    // independent failures (commit failure, then rollback failure) each
    // deterministic and clearly attributable.
    const { chmod } = await import("node:fs/promises");
    const lockedDir = join(kitDir, "dest", "locked");
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o555);

    // Once rollback starts, it will try to rm() the already-committed
    // "dest/a.html" to undo it — inject a failure there.
    failRmOnce.add(committedPath);

    try {
      await expect(
        writeFiles(store, {
          planId: plan.planId,
          files: [
            { path: "dest/a.html", data: "new a" }, // commits successfully
            { path: "dest/locked/blocked.html", data: "unreachable" }, // fails: read-only dir
          ],
        }),
      ).rejects.toMatchObject({ code: "RollbackIncompleteError" });
    } finally {
      await chmod(lockedDir, 0o755);
    }

    // The commit-undo rm() failed, so "dest/a.html" is left behind — this is
    // exactly the "tree may not match pre-call state" condition
    // RollbackIncompleteError exists to surface, rather than silently
    // reporting WriteFailedError as if nothing were left over.
    await expect(stat(committedPath)).resolves.toBeTruthy();
    await realRm(failingPath, { force: true }).catch(() => {});
  });

  it("still reports the ordinary WriteFailedError (not RollbackIncompleteError) when rollback fully succeeds", async () => {
    // Regression guard for the happy-rollback path: with NO injected rollback
    // failure, a commit failure must still surface as the ordinary
    // WriteFailedError (already covered via chmod-based fault injection in
    // write_files.test.ts's AC10 tests) — RollbackIncompleteError must not
    // fire when rollback genuinely succeeds in full.
    const plan = await createPlan(KIT_ID, ["dest/**"], [], localDir);
    await mkdir(join(kitDir, "dest"), { recursive: true });
    await writeFile(join(kitDir, "dest", "a.html"), "original a", "utf-8");

    const { chmod } = await import("node:fs/promises");
    const lockedDir = join(kitDir, "dest", "locked");
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o555);

    try {
      await expect(
        writeFiles(store, {
          planId: plan.planId,
          files: [
            { path: "dest/a.html", data: "new a" },
            { path: "dest/locked/blocked.html", data: "unreachable" },
          ],
        }),
      ).rejects.toMatchObject({ code: "WriteFailedError" });
    } finally {
      await chmod(lockedDir, 0o755);
    }

    // Full rollback succeeded: original content restored, no leftover.
    await expect(readFile(join(kitDir, "dest", "a.html"), "utf-8")).resolves.toBe("original a");
  });
});
