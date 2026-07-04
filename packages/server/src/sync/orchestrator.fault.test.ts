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
 */
import { mkdir, mkdtemp, rm as realRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** node:fs/promises fault switches, reset per test (see the mock below). */
let sentinelWriteCount: number;
/** When set, the Nth writeFile whose path ends in `.genie/recompile` throws. */
let failSentinelWriteOnCount: number | null;
/** When true, a rename whose destination is the anchor file throws. */
let failAnchorRename: boolean;

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
    if (failAnchorRename && to.toString().endsWith(".genie/sync.json")) {
      throw Object.assign(new Error(`simulated EIO renaming anchor into ${to.toString()}`), {
        code: "EIO",
      });
    }
    return actual.rename(from, to);
  };

  return { ...actual, writeFile, rename };
});

// Import AFTER vi.mock so the orchestrator + store + anchor all bind the mocked
// node:fs/promises (same ordering as write_files.rollback.test.ts).
const { createPlan } = await import("../plans/index.js");
const { LocalFsKitStore } = await import("../store/local.js");
const { readAnchor } = await import("./anchor.js");
const { runAtomicSync, RECOMPILE_SENTINEL_PATH } = await import("./orchestrator.js");

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
    const { readFile } = await import("node:fs/promises");
    const sentinel = await readFile(join(harness.projectRoot, RECOMPILE_SENTINEL_PATH), "utf-8");
    expect(sentinel).toBe('{"by":"genie"}');
  });
});
