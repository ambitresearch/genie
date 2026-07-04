/**
 * Fault-injection coverage for M3-05's orchestrator steps 4 and 5
 * (`packages/server/src/sync/orchestrator.ts`).
 *
 * Steps 2 and 3 fail through real tool-layer errors (out-of-plan paths), so
 * `orchestrator.test.ts` triggers those with genuine bad input — no mock. But
 * steps 4 (re-arm the `.genie/recompile` sentinel) and 5 (write
 * `.genie/sync.json`) are FS-NATIVE writes with no plan gate to trip, so the
 * only way to force a mid-step failure is to inject a precise filesystem fault.
 * This mirrors `write_files.rollback.test.ts`'s `vi.mock("node:fs/promises")`
 * one-shot fault pattern, kept in its own file so the module-scoped mock
 * doesn't perturb the happy-path suite.
 *
 * The two faults prove AC7's core guarantee at the two steps closest to the
 * finish line:
 *   - A step-4 failure (sentinel re-arm) STOPS before step 5, so
 *     `.genie/sync.json` is never written — the next sync sees the half-write.
 *   - A step-5 failure (anchor rename) leaves NO anchor behind (writeAnchor's
 *     own temp-file + rename atomicity means a failed rename commits nothing),
 *     so the sync correctly reports `ok:false, failedStep:5`.
 *
 * Two further regressions (both Copilot review findings on this PR) round out
 * this file:
 *   - `detectResumeStep` must PROPAGATE a non-"missing" `stat` failure (e.g.
 *     `EACCES` on the sentinel) rather than silently treating it as "sentinel
 *     absent" — a `stat` fault injection on the sentinel path proves this.
 *   - Step 5's anchor hashing must read a `localPath` write's bytes back from
 *     the KIT tree it just committed to (`projectRoot`), never re-read the
 *     plan's `localDir` source a second time — a TOCTOU hazard, since the
 *     caller may keep mutating `localDir` for the sync's lifetime. A `rename`
 *     hook mutates the local source immediately after step 2's commit lands,
 *     proving the anchor still reflects the ORIGINAL committed bytes.
 */
import { mkdir, mkdtemp, readFile, rm as realRm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** node:fs/promises fault switches, reset per test (see the mock below). */
let sentinelWriteCount: number;
/** When set, the Nth writeFile whose path ends in `.genie/recompile` throws. */
let failSentinelWriteOnCount: number | null;
/** When true, a rename whose destination is the anchor file throws. */
let failAnchorRename: boolean;
/** When set, a `stat` whose path ends in `suffix` throws with `code`. */
let failStatSuffix: { suffix: string; code: string } | null;
/**
 * When set, once a `rename` commits a file whose destination ends in
 * `destSuffix`, `sourcePath` is immediately overwritten with `newContent` —
 * simulating a caller mutating the plan's `localDir` while a sync is still
 * mid-flight (TOCTOU regression, see module header).
 */
let mutateSourceAfterCommit: { sourcePath: string; destSuffix: string; newContent: string } | null;

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

  const writeFile: typeof actual.writeFile = async (path, data, options) => {
    const target = path.toString();
    if (target.endsWith(".genie/recompile")) {
      sentinelWriteCount += 1;
      if (failSentinelWriteOnCount !== null && sentinelWriteCount === failSentinelWriteOnCount) {
        throw Object.assign(new Error(`simulated EIO re-arming sentinel at ${target}`), {
          code: "EIO",
        });
      }
    }
    return actual.writeFile(path, data, options);
  };

  const rename: typeof actual.rename = async (from, to) => {
    const target = to.toString();
    if (failAnchorRename && target.endsWith(".genie/sync.json")) {
      throw Object.assign(new Error(`simulated EIO renaming anchor into ${target}`), {
        code: "EIO",
      });
    }
    const result = await actual.rename(from, to);
    // Fires AFTER the real commit lands, so the kit tree already holds the
    // ORIGINAL bytes by the time we mutate the (separate) localDir source.
    if (mutateSourceAfterCommit && target.endsWith(mutateSourceAfterCommit.destSuffix)) {
      await actual.writeFile(
        mutateSourceAfterCommit.sourcePath,
        mutateSourceAfterCommit.newContent,
        "utf-8",
      );
    }
    return result;
  };

  const stat: typeof actual.stat = (async (...args: Parameters<typeof actual.stat>) => {
    const [path] = args;
    if (failStatSuffix && path.toString().endsWith(failStatSuffix.suffix)) {
      throw Object.assign(
        new Error(`simulated ${failStatSuffix.code} statting ${path.toString()}`),
        {
          code: failStatSuffix.code,
        },
      );
    }
    return (
      actual.stat as (...a: Parameters<typeof actual.stat>) => ReturnType<typeof actual.stat>
    )(...args);
  }) as typeof actual.stat;

  return { ...actual, writeFile, rename, stat };
});

// Import AFTER vi.mock so the orchestrator + store + anchor all bind the mocked
// node:fs/promises (same ordering as write_files.rollback.test.ts).
const { createPlan } = await import("../plans/index.js");
const { LocalFsKitStore } = await import("../store/local.js");
const { readAnchor } = await import("./anchor.js");
const { sriSha256 } = await import("../store/kit-files.js");
const { runAtomicSync, detectResumeStep, RECOMPILE_SENTINEL_BODY, RECOMPILE_SENTINEL_PATH } =
  await import("./orchestrator.js");

const KIT_ID = "kit-orch-fault";

interface Harness {
  home: string;
  projectRoot: string;
  deps: { store: InstanceType<typeof LocalFsKitStore>; projectRoot: string };
}

async function setup(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "genie-orch-fault-home-"));
  process.env.GENIE_HOME = home;
  const kitsRoot = join(home, "kits");
  const projectRoot = join(kitsRoot, KIT_ID);
  await mkdir(projectRoot, { recursive: true });
  const store = new LocalFsKitStore(kitsRoot);
  return { home, projectRoot, deps: { store, projectRoot } };
}

let harness: Harness;

beforeEach(async () => {
  sentinelWriteCount = 0;
  failSentinelWriteOnCount = null;
  failAnchorRename = false;
  failStatSuffix = null;
  mutateSourceAfterCommit = null;
  harness = await setup();
});

afterEach(async () => {
  // Use the real (un-mocked) rm for guaranteed cleanup.
  await realRm(harness.home, { recursive: true, force: true });
  delete process.env.GENIE_HOME;
});

describe("runAtomicSync — step 4 fault (sentinel re-arm) [AC7]", () => {
  it("fails with failedStep:4 and never writes the anchor", async () => {
    // Fail the SECOND sentinel write (step 1 = 1st, step 4 = 2nd). Step 2's
    // write lands, step 3 is a no-op, then step 4's re-arm throws.
    failSentinelWriteOnCount = 2;
    const state = await createPlan(KIT_ID, ["c/**"], [], process.cwd());

    const result = await runAtomicSync(harness.deps, {
      planId: state.planId,
      writes: [{ path: "c/Button.tsx", data: "export const Button = 1;\n" }],
      deletes: [],
      verified: ["c/Button"],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failedStep).toBe(4);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.events.map((event) => event.step)).toEqual([1, 2, 3, 4]);
      expect(result.events[3]?.ok).toBe(false);
    }
    // AC7 — anchor MUST NOT exist when a pre-step-5 step failed.
    expect(await readAnchor(harness.projectRoot)).toBeNull();
  });
});

describe("runAtomicSync — step 5 fault (anchor rename) [AC7]", () => {
  it("fails with failedStep:5 and leaves no anchor behind (writeAnchor atomicity)", async () => {
    // Steps 1–4 all succeed; the anchor's temp-file→rename commit fails on the
    // rename into `.genie/sync.json`. Because writeAnchor stages then renames,
    // a failed rename commits nothing — no half-written anchor.
    failAnchorRename = true;
    const state = await createPlan(KIT_ID, ["c/**"], [], process.cwd());

    const result = await runAtomicSync(harness.deps, {
      planId: state.planId,
      writes: [{ path: "c/Card.tsx", data: "export const Card = 1;\n" }],
      deletes: [],
      verified: ["c/Card"],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failedStep).toBe(5);
      expect(result.events.map((event) => event.step)).toEqual([1, 2, 3, 4, 5]);
      expect(result.events[4]?.ok).toBe(false);
      // Steps 1–4 all recorded success before step 5 blew up.
      for (const event of result.events.slice(0, 4)) expect(event.ok).toBe(true);
    }
    // No anchor file exists (the rename that would have created it failed).
    expect(await readAnchor(harness.projectRoot)).toBeNull();

    // The sentinel IS present (steps 1 and 4 both wrote it) — so the next
    // sync's detectResumeStep would see "sentinel present, anchor absent" and
    // correctly resume from step 2. Proven here by direct read.
    const sentinel = await readFile(join(harness.projectRoot, RECOMPILE_SENTINEL_PATH), "utf-8");
    expect(sentinel).toBe(RECOMPILE_SENTINEL_BODY);
  });
});

// ────────────────────────────────────────────────────────────
// Copilot review finding #1: detectResumeStep must PROPAGATE a non-"missing"
// stat failure on the sentinel, not silently read it as "sentinel absent".
// ────────────────────────────────────────────────────────────

describe("detectResumeStep — non-ENOENT stat failure propagates (Copilot review)", () => {
  it("rethrows an EACCES statting the sentinel rather than reporting resume-from-1", async () => {
    // A fresh kit has no anchor and no sentinel yet — absent either fault
    // injection, detectResumeStep would report `1` (fresh sync). Injecting an
    // EACCES on the sentinel path must surface as a thrown error instead of
    // being silently folded into "absent", which would misreport a real
    // permissions/operability problem as a normal fresh-kit state.
    failStatSuffix = { suffix: RECOMPILE_SENTINEL_PATH, code: "EACCES" };

    await expect(detectResumeStep(harness.projectRoot)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("still propagates EACCES even when a completed anchor already exists", async () => {
    // Belt-and-suspenders: the fault must surface regardless of the anchor's
    // state, since `pathExists` runs independently of `readAnchor`.
    const { writeAnchor } = await import("./anchor.js");
    await writeAnchor(harness.projectRoot, { writes: [], verified: [] });
    failStatSuffix = { suffix: RECOMPILE_SENTINEL_PATH, code: "EACCES" };

    await expect(detectResumeStep(harness.projectRoot)).rejects.toMatchObject({ code: "EACCES" });
  });
});

// ────────────────────────────────────────────────────────────
// Copilot review finding #2: step 5 must hash a localPath write's COMMITTED
// kit-tree bytes, never re-read the plan's (mutable) localDir source.
// ────────────────────────────────────────────────────────────

describe("runAtomicSync — anchor hashes committed bytes, not a re-read localPath source (Copilot review)", () => {
  it("anchor's sourceHashes reflect the ORIGINAL bytes even if localDir changes after step 2 commits", async () => {
    const localDir = await mkdtemp(join(tmpdir(), "genie-orch-fault-local-"));
    const originalContent = "export const Original = 1;\n";
    const mutatedContent = "export const Mutated = 999;\n";
    await writeFile(join(localDir, "Button.tsx"), originalContent, "utf-8");

    // The moment step 2's write_files commit renames the staged file into the
    // kit tree (destination ends in "c/Button.tsx"), overwrite the SOURCE file
    // in localDir — simulating a caller that keeps mutating its local upload
    // dir while the sync is still mid-flight (e.g. a subsequent, unrelated
    // conjure round touching the same scratch dir).
    mutateSourceAfterCommit = {
      sourcePath: join(localDir, "Button.tsx"),
      destSuffix: "c/Button.tsx",
      newContent: mutatedContent,
    };

    const state = await createPlan(KIT_ID, ["c/**"], [], localDir);
    const result = await runAtomicSync(harness.deps, {
      planId: state.planId,
      writes: [{ path: "c/Button.tsx", localPath: "Button.tsx" }],
      deletes: [],
      verified: ["c/Button"],
    });

    expect(result.ok).toBe(true);

    // The kit tree holds the ORIGINAL committed bytes (mutation only touched
    // the separate localDir source, never the kit destination).
    const committed = await readFile(join(harness.projectRoot, "c/Button.tsx"), "utf-8");
    expect(committed).toBe(originalContent);

    // The localDir source WAS mutated (proving the fault actually fired).
    const sourceNow = await readFile(join(localDir, "Button.tsx"), "utf-8");
    expect(sourceNow).toBe(mutatedContent);

    // The anchor's hash MUST match the ORIGINAL committed bytes — not the
    // mutated source, and not a fresh read of the (now-mutated) localDir file.
    const anchor = await readAnchor(harness.projectRoot);
    expect(anchor?.sourceHashes["c/Button.tsx"]).toBe(sriSha256(originalContent));
    expect(anchor?.sourceHashes["c/Button.tsx"]).not.toBe(sriSha256(mutatedContent));

    await realRm(localDir, { recursive: true, force: true });
  });
});
