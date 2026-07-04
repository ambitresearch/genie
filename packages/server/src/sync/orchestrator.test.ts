/**
 * Tests for M3-05 (DRO-261) — the 5-step atomic write orchestrator
 * (`packages/server/src/sync/orchestrator.ts`).
 *
 * Covers every AC on DRO-261:
 *   - AC1 — module exports `runAtomicSync({ planId, writes, deletes })`
 *           returning `SyncResult`.
 *   - AC2 — Step 1 writes `.genie/recompile` with body `{"by":"genie"}`
 *           (genie's native sentinel format; NOT the Anthropic `_ds_*` shape).
 *   - AC3 — Step 2 chunks `writes` into batches of ≤ 256 per `write_files`
 *           call (exercised with a >256-item batch that must land as two
 *           calls — one 256, one remainder).
 *   - AC4 — Step 3 dispatches all `deletes` via `delete_files`. A path
 *           authorized-but-absent is NOT a failure (delete_files' AC5).
 *   - AC5 — Step 4 re-arms `.genie/recompile` (writes it again after the
 *           writes+deletes land).
 *   - AC6 — Step 5 writes `.genie/sync.json` last, via M3-06's `writeAnchor`.
 *   - AC7 — Any failure BEFORE step 5 leaves `.genie/sync.json` unwritten
 *           and returns `{ ok:false, failedStep, error, events }`. A
 *           not-found delete inside step 3 does NOT trip this rule.
 *   - AC8 — Idempotent re-run: a partially-completed prior run
 *           (sentinel present, anchor absent) is detectable so the next
 *           run resumes from step 2 and produces a valid anchor.
 *   - AC9 — Every step emits a `{ step, ok, ms }` StepEvent, in order.
 *
 * Uses the real `LocalFsKitStore` on a temp kit dir (mirrors
 * `write_files.rollback.test.ts` / `delete_files.test.ts`) so tests exercise
 * the same atomic rename transaction production takes.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPlan } from "../plans/index.js";
import { LocalFsKitStore } from "../store/local.js";
import { readAnchor } from "./anchor.js";
import {
  RECOMPILE_SENTINEL_BODY,
  RECOMPILE_SENTINEL_PATH,
  detectResumeStep,
  runAtomicSync,
  type SyncDeps,
  type SyncResult,
  type WriteInput,
} from "./orchestrator.js";

const KIT_ID = "kit-orchestrator";

interface Harness {
  home: string;
  kitsRoot: string;
  /** `<kitsRoot>/<KIT_ID>` — the physical destination the sentinel + anchor land on. */
  projectRoot: string;
  store: LocalFsKitStore;
  deps: SyncDeps;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function setup(): Promise<Harness> {
  const home = await tempDir("genie-orch-home-");
  process.env.GENIE_HOME = home;
  const kitsRoot = join(home, "kits");
  const projectRoot = join(kitsRoot, KIT_ID);
  await mkdir(projectRoot, { recursive: true });
  const store = new LocalFsKitStore(kitsRoot);
  return { home, kitsRoot, projectRoot, store, deps: { store, projectRoot } };
}

/** Create a plan whose writes/deletes globs cover the test's paths. */
async function seedPlan(writes: string[], deletes: string[] = []): Promise<string> {
  const localDir = process.cwd();
  const state = await createPlan(KIT_ID, writes, deletes, localDir);
  return state.planId;
}

/** Convenience: assert every event has `{ step, ok, ms }` shape (AC9). */
function assertEventShape(events: SyncResult["events"]): void {
  for (const event of events) {
    expect(typeof event.step).toBe("number");
    expect([1, 2, 3, 4, 5]).toContain(event.step);
    expect(typeof event.ok).toBe("boolean");
    expect(typeof event.ms).toBe("number");
    expect(event.ms).toBeGreaterThanOrEqual(0);
  }
}

let harness: Harness;

beforeEach(async () => {
  harness = await setup();
});

afterEach(async () => {
  await rm(harness.home, { recursive: true, force: true });
  delete process.env.GENIE_HOME;
});

// ────────────────────────────────────────────────────────────
// AC1 — happy path: all 5 steps land, ok:true, anchor written last
// ────────────────────────────────────────────────────────────

describe("runAtomicSync — happy path (AC1, AC2, AC5, AC6, AC9)", () => {
  it("runs all 5 steps in order, writes sentinel + files + anchor, ok:true", async () => {
    const planId = await seedPlan(["components/**"], ["obsolete/**"]);
    const writes: WriteInput[] = [
      { path: "components/actions/Button/Button.tsx", data: "export const Button = () => null;\n" },
      { path: "components/actions/Button/Button.html", data: '<!-- @genie group="actions" -->\n' },
    ];

    const result = await runAtomicSync(harness.deps, {
      planId,
      writes,
      deletes: [],
      verified: ["actions/Button"],
    });

    expect(result.ok).toBe(true);
    expect(result.events.map((event) => event.step)).toEqual([1, 2, 3, 4, 5]);
    for (const event of result.events) expect(event.ok).toBe(true);
    assertEventShape(result.events);

    // AC2 + AC5 — sentinel is present at the end (re-armed by step 4).
    const sentinel = await readFile(join(harness.projectRoot, RECOMPILE_SENTINEL_PATH), "utf-8");
    expect(sentinel).toBe(RECOMPILE_SENTINEL_BODY);
    expect(sentinel).toBe('{"by":"genie"}');

    // AC6 — anchor was written LAST via writeAnchor; contents match M3-06 shape.
    const anchor = await readAnchor(harness.projectRoot);
    expect(anchor).not.toBeNull();
    expect(anchor?.version).toBe(1);
    expect(anchor?.verified).toEqual(["actions/Button"]);
    expect(Object.keys(anchor!.sourceHashes)).toEqual(["components/actions/Button/Button.tsx"]);
    expect(Object.keys(anchor!.renderHashes)).toEqual(["components/actions/Button/Button.html"]);

    // Files actually landed via write_files' atomic commit.
    expect(existsSync(join(harness.projectRoot, "components/actions/Button/Button.tsx"))).toBe(
      true,
    );
    expect(existsSync(join(harness.projectRoot, "components/actions/Button/Button.html"))).toBe(
      true,
    );
  });

  it('AC2: sentinel body is exactly the literal `{"by":"genie"}` (native, NOT `_ds_*`)', async () => {
    // The issue is literal about this. Interop hard rule (CLAUDE.md #1) says
    // the native surface is `.genie/`; a rename to `_ds_recompile` would be
    // an interop violation. This test guards both the body AND the path.
    const planId = await seedPlan([]);
    await runAtomicSync(harness.deps, {
      planId,
      writes: [],
      deletes: [],
      verified: [],
    });
    expect(RECOMPILE_SENTINEL_PATH).toBe(".genie/recompile");
    expect(RECOMPILE_SENTINEL_BODY).toBe('{"by":"genie"}');
    const sentinel = await readFile(join(harness.projectRoot, ".genie/recompile"), "utf-8");
    expect(sentinel).toBe('{"by":"genie"}');
  });
});

// ────────────────────────────────────────────────────────────
// AC3 — Step 2 chunks writes into batches of ≤256 per call
// ────────────────────────────────────────────────────────────

describe("runAtomicSync — chunking (AC3)", () => {
  it("splits >256 writes into two write_files calls (256 + remainder), all land", async () => {
    // 300 writes → two batches: 256 then 44. Exercises the chunk boundary
    // exactly (256 is MAX_FILES_PER_CALL; a call of 257 would fail as
    // TooManyFilesError in write_files, so this test also proves the
    // orchestrator's chunker respects that limit).
    const paths = Array.from({ length: 300 }, (_, i) => `bulk/file-${i}.txt`);
    const planId = await seedPlan(["bulk/**"]);
    const writes: WriteInput[] = paths.map((path, i) => ({ path, data: `contents-${i}\n` }));

    const result = await runAtomicSync(harness.deps, {
      planId,
      writes,
      deletes: [],
      verified: [],
    });

    expect(result.ok).toBe(true);
    for (const path of paths) {
      expect(existsSync(join(harness.projectRoot, path))).toBe(true);
    }
    // Anchor hashes cover only extension-matching writes; these `.txt` writes
    // are neither source nor render files, so hash maps are empty — the point
    // here is chunk correctness, not extension filtering.
    const anchor = await readAnchor(harness.projectRoot);
    expect(anchor?.sourceHashes).toEqual({});
    expect(anchor?.renderHashes).toEqual({});
  });

  it("handles exactly 256 writes in a single batch (chunk-boundary lower edge)", async () => {
    const paths = Array.from({ length: 256 }, (_, i) => `bulk/edge-${i}.txt`);
    const planId = await seedPlan(["bulk/**"]);
    const writes: WriteInput[] = paths.map((path, i) => ({ path, data: `edge-${i}\n` }));

    const result = await runAtomicSync(harness.deps, {
      planId,
      writes,
      deletes: [],
      verified: [],
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(harness.projectRoot, "bulk/edge-0.txt"))).toBe(true);
    expect(existsSync(join(harness.projectRoot, "bulk/edge-255.txt"))).toBe(true);
  });

  it("handles empty writes (step 2 is a no-op but still emits a StepEvent)", async () => {
    const planId = await seedPlan([]);
    const result = await runAtomicSync(harness.deps, {
      planId,
      writes: [],
      deletes: [],
      verified: [],
    });
    expect(result.ok).toBe(true);
    // AC9 — every step MUST emit exactly one event even when its work is trivial.
    expect(result.events.filter((event) => event.step === 2)).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────
// AC4 — Step 3 dispatches deletes; not-found delete is NOT a failure
// ────────────────────────────────────────────────────────────

describe("runAtomicSync — deletes (AC4, AC7 not-found exception)", () => {
  it("AC4: deletes every authorized path in one delete_files call", async () => {
    // Seed two files, then plan a delete round that removes them.
    const planId = await seedPlan([], ["obsolete/**"]);
    // Manual seed (bypasses plan gating — the store's `writeFile` isn't
    // exposed, so use fs directly to place files inside the kit dir).
    await mkdir(join(harness.projectRoot, "obsolete"), { recursive: true });
    await writeFile(join(harness.projectRoot, "obsolete/a.txt"), "a");
    await writeFile(join(harness.projectRoot, "obsolete/b.txt"), "b");

    const result = await runAtomicSync(harness.deps, {
      planId,
      writes: [],
      deletes: ["obsolete/a.txt", "obsolete/b.txt"],
      verified: [],
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(harness.projectRoot, "obsolete/a.txt"))).toBe(false);
    expect(existsSync(join(harness.projectRoot, "obsolete/b.txt"))).toBe(false);
    // Anchor still landed (step 5) because step 3 succeeded.
    expect(await readAnchor(harness.projectRoot)).not.toBeNull();
  });

  it("AC7 not-found exception: a delete for a never-existed path does NOT fail the sync", async () => {
    // delete_files' AC5 explicitly returns not-found paths in notFoundPaths
    // rather than throwing; the orchestrator inherits that. This is the
    // "known-good failure to silently retry past" from the research report:
    // deleting a preview HTML that was never generated remotely.
    const planId = await seedPlan([], ["never-existed/**"]);
    const result = await runAtomicSync(harness.deps, {
      planId,
      writes: [],
      deletes: ["never-existed/vanished.html"],
      verified: [],
    });

    expect(result.ok).toBe(true);
    expect(result.events.find((event) => event.step === 3)?.ok).toBe(true);
    // Anchor MUST be present — the not-found delete cannot block step 5.
    expect(await readAnchor(harness.projectRoot)).not.toBeNull();
  });

  it("empty deletes is a no-op that still emits step 3's StepEvent (AC9)", async () => {
    const planId = await seedPlan([]);
    const result = await runAtomicSync(harness.deps, {
      planId,
      writes: [],
      deletes: [],
      verified: [],
    });
    expect(result.ok).toBe(true);
    expect(result.events.filter((event) => event.step === 3)).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────
// AC7 — Stop on first failure BEFORE step 5; anchor stays unwritten
// ────────────────────────────────────────────────────────────

describe("runAtomicSync — stop-on-first-failure (AC7)", () => {
  it("step 2 failure (invalid write path — outside plan): fails with failedStep:2, no anchor", async () => {
    // Plan authorizes ONLY `allowed/**`; the write targets `not-allowed/...`
    // which write_files rejects with PathOutsidePlanError — a real failure
    // sourced from the tool layer, not a mock.
    const planId = await seedPlan(["allowed/**"]);
    const result = await runAtomicSync(harness.deps, {
      planId,
      writes: [{ path: "not-allowed/x.tsx", data: "nope" }],
      deletes: [],
      verified: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failedStep).toBe(2);
      expect(result.error).toBeInstanceOf(Error);
      // Events: step 1 ok, step 2 not-ok, no further steps.
      expect(result.events.map((event) => event.step)).toEqual([1, 2]);
      expect(result.events[0]?.ok).toBe(true);
      expect(result.events[1]?.ok).toBe(false);
    }
    // Sentinel IS present (step 1 succeeded) but anchor MUST NOT be.
    expect(existsSync(join(harness.projectRoot, ".genie/recompile"))).toBe(true);
    expect(await readAnchor(harness.projectRoot)).toBeNull();
  });

  it("step 3 failure (delete outside plan): fails with failedStep:3, no anchor", async () => {
    // Plan authorizes deletes only for `allowed/**`; deleting outside triggers
    // PathOutsidePlanError from delete_files. Sentinel is present, anchor absent.
    const planId = await seedPlan([], ["allowed/**"]);
    const result = await runAtomicSync(harness.deps, {
      planId,
      writes: [],
      deletes: ["not-allowed/foo.txt"],
      verified: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failedStep).toBe(3);
    }
    expect(await readAnchor(harness.projectRoot)).toBeNull();
  });

  it("step 1 failure (unwritable projectRoot): fails with failedStep:1, no anchor, no step 2", async () => {
    // Point the projectRoot at a path we cannot create — a file where a
    // directory should be. mkdir(recursive: true) throws ENOTDIR then.
    const wallPath = join(harness.home, "wall");
    await writeFile(wallPath, "not a directory");
    const trappedDeps: SyncDeps = {
      store: harness.store,
      projectRoot: join(wallPath, "trap"),
    };
    const planId = await seedPlan([]);

    const result = await runAtomicSync(trappedDeps, {
      planId,
      writes: [],
      deletes: [],
      verified: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failedStep).toBe(1);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.ok).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────
// AC8 — Idempotent re-run: sentinel present + anchor absent = mid-plan crash
// ────────────────────────────────────────────────────────────

describe("runAtomicSync — resume detection (AC8)", () => {
  it("detectResumeStep returns 2 when sentinel exists but anchor is missing (mid-plan crash)", async () => {
    // Simulate: prior run wrote the sentinel (step 1 succeeded), then crashed
    // before the anchor landed. The next run's diff must know to resume from
    // step 2 (rewrite what step 2/3 needed to do), not skip past to step 5.
    await mkdir(join(harness.projectRoot, ".genie"), { recursive: true });
    await writeFile(
      join(harness.projectRoot, RECOMPILE_SENTINEL_PATH),
      RECOMPILE_SENTINEL_BODY,
      "utf-8",
    );

    const resume = await detectResumeStep(harness.projectRoot);
    expect(resume).toBe(2);
  });

  it("detectResumeStep returns 1 when both sentinel and anchor are absent (fresh sync)", async () => {
    // Fresh kit — never synced. Resume from the beginning (step 1).
    const resume = await detectResumeStep(harness.projectRoot);
    expect(resume).toBe(1);
  });

  it("detectResumeStep returns null when both sentinel and anchor exist (last run was clean)", async () => {
    // Clean state — nothing to resume; the next run starts a NEW plan from
    // step 1 with fresh writes. `null` signals "no partial-write resume state".
    await mkdir(join(harness.projectRoot, ".genie"), { recursive: true });
    await writeFile(
      join(harness.projectRoot, RECOMPILE_SENTINEL_PATH),
      RECOMPILE_SENTINEL_BODY,
      "utf-8",
    );
    // Write an anchor via the real writeAnchor so it's schema-valid.
    const { writeAnchor } = await import("./anchor.js");
    await writeAnchor(harness.projectRoot, { writes: [], verified: [] });

    const resume = await detectResumeStep(harness.projectRoot);
    expect(resume).toBeNull();
  });

  it("AC8: re-running runAtomicSync after a step-3-shaped crash produces a valid anchor", async () => {
    // First run: step 3 fails (delete outside plan) → anchor absent, sentinel
    // present. Second run with a CORRECT plan lands a valid anchor. This is
    // the whole-loop version of the resume assertion.
    //
    // The plan authorizes deletes ONLY under `allowed/**`, so a delete of
    // `not-allowed/x.txt` is out-of-plan → delete_files throws
    // PathOutsidePlanError → step 3 fails (NOT the not-found path, which would
    // succeed). Step 2's write of `c/keep.tsx` has already committed by then,
    // so the tree is genuinely half-written — exactly the state AC8 repairs.
    const planA = await seedPlan(["c/**"], ["allowed/**"]);
    const firstRun = await runAtomicSync(harness.deps, {
      planId: planA,
      writes: [{ path: "c/keep.tsx", data: "keep\n" }],
      deletes: ["not-allowed/x.txt"], // outside the plan's deletes → fails step 3.
      verified: [],
    });
    expect(firstRun.ok).toBe(false);
    expect(await readAnchor(harness.projectRoot)).toBeNull();
    // Mid-plan crash detected.
    expect(await detectResumeStep(harness.projectRoot)).toBe(2);

    // Second run: authorize the same writes with a fresh plan; no bad deletes.
    // The orchestrator lands a valid anchor without further intervention.
    const planB = await seedPlan(["c/**"]);
    const secondRun = await runAtomicSync(harness.deps, {
      planId: planB,
      writes: [{ path: "c/keep.tsx", data: "keep\n" }],
      deletes: [],
      verified: ["c/Keep"],
    });
    expect(secondRun.ok).toBe(true);
    const anchor = await readAnchor(harness.projectRoot);
    expect(anchor).not.toBeNull();
    expect(anchor?.verified).toEqual(["c/Keep"]);
    // Clean state after resume — no partial-write signal left.
    expect(await detectResumeStep(harness.projectRoot)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// AC9 — StepEvent shape + timing invariants
// ────────────────────────────────────────────────────────────

describe("runAtomicSync — StepEvent shape (AC9)", () => {
  it("emits exactly 5 events for a happy path (one per step), in step order", async () => {
    const planId = await seedPlan(["x/**"]);
    const result = await runAtomicSync(harness.deps, {
      planId,
      writes: [{ path: "x/y.tsx", data: "x\n" }],
      deletes: [],
      verified: [],
    });
    expect(result.events.map((event) => event.step)).toEqual([1, 2, 3, 4, 5]);
    assertEventShape(result.events);
  });

  it("truncates events at the failing step (no events emitted for steps not attempted)", async () => {
    // Fail at step 2 (write outside plan). No step 3/4/5 events should exist.
    const planId = await seedPlan(["allowed/**"]);
    const result = await runAtomicSync(harness.deps, {
      planId,
      writes: [{ path: "outside/x.txt", data: "x" }],
      deletes: [],
      verified: [],
    });
    expect(result.events.map((event) => event.step)).toEqual([1, 2]);
    assertEventShape(result.events);
  });
});
