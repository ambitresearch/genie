/**
 * M3-05 (DRO-261) — genie's 5-step atomic write-sequence orchestrator.
 *
 * `runAtomicSync` sequences one sync commit as five ordered, stop-on-first-
 * failure steps (D0 / `docs/plan/00-decisions.md` — "the atomic write sequence
 * is load-bearing and unchanged in shape"):
 *
 *   1. Write the `.genie/recompile` sentinel FIRST, to fence the manifest/copy
 *      machinery — a consumer that sees the sentinel knows a sync is mid-flight
 *      and the tree may be inconsistent until the anchor lands.
 *   2. Apply every content write, chunked into batches of ≤ 256 per
 *      `write_files` call (the M1-08 `MAX_FILES_PER_CALL` ceiling — a 257-file
 *      call would be rejected as `TooManyFilesError`).
 *   3. Apply every delete via one `delete_files` call. A path that is
 *      authorized-but-absent is NOT a failure (M1-09 AC5 returns it in
 *      `notFoundPaths`) — only a real error (out-of-plan path, unlink failure)
 *      trips stop-on-first-failure.
 *   4. RE-ARM the sentinel (write it again), so it still fences the tree after
 *      the writes/deletes landed and right up until the anchor is committed.
 *   5. Write `.genie/sync.json` LAST, via M3-06's {@link writeAnchor}. It is the
 *      completion proof: its presence means every prior step succeeded.
 *
 * ── Why the anchor is last (AC7) ─────────────────────────────────────────────
 * A mid-plan failure (steps 1–4) returns before step 5, so `.genie/sync.json`
 * is never written for an incomplete sync. The NEXT sync sees "sentinel present,
 * anchor absent" ({@link detectResumeStep} → 2) and knows the tree is a
 * half-write to repair from step 2 — rather than trusting a stale anchor that
 * would mask the incomplete state. This is the whole reason the write order is
 * load-bearing.
 *
 * ── Native surface (CLAUDE.md hard rule 1) ───────────────────────────────────
 * `.genie/recompile` and `.genie/sync.json` are genie-NATIVE artifacts. They are
 * written fs-native to `projectRoot` (NOT through the plan-gated `write_files`
 * verb — they would never match a user plan's `writes` globs, and they are
 * genie's own bookkeeping, not user content). They must NOT be renamed to the
 * Anthropic `_ds_recompile` / `_ds_sync.json` interop shapes; an interop bridge
 * that maps them is a separate, opt-in concern.
 *
 * ── Composition (Kiln's plan, DRO-696) ───────────────────────────────────────
 * Steps 2–3 call the in-process `writeFiles` / `deleteFiles` CORE functions
 * directly (not over the MCP transport) — the same way `conjure_screen.ts`
 * composes tool-layer logic — so the orchestrator reuses their full plan-gating,
 * atomicity, and rollback contracts without re-implementing any of it.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { getPlan } from "../plans/index.js";
import type { KitStore } from "../store/interface.js";
import { deleteFiles } from "../tools/delete_files.js";
import { MAX_FILES_PER_CALL, writeFiles } from "../tools/write_files.js";
import { readAnchor, writeAnchor, type PlanResult } from "./anchor.js";

// ─── Native sentinel (AC2) ───────────────────────────────────────────────────

/** Kit-root-relative path of genie's recompile fence sentinel (native surface). */
export const RECOMPILE_SENTINEL_PATH = ".genie/recompile";

/**
 * The exact sentinel body (AC2). genie's native `{"by":"genie"}` marker — NOT
 * the Anthropic `_ds_recompile` interop shape (CLAUDE.md hard rule 1). Kept as
 * a compact single-line literal so a byte-for-byte assertion is trivial and the
 * re-arm in step 4 reproduces it exactly.
 */
export const RECOMPILE_SENTINEL_BODY = '{"by":"genie"}';

// ─── Public shapes (AC1, AC9) ────────────────────────────────────────────────

/** The five ordered steps of one atomic sync. */
export type StepNumber = 1 | 2 | 3 | 4 | 5;

/**
 * One observability event per attempted step (AC9): which `step`, whether it
 * succeeded (`ok`), and how long it took (`ms`, wall-clock via
 * `performance.now()`). Emitted for EVERY attempted step — including the one
 * that failed — and never for a step the sequence stopped short of.
 */
export interface StepEvent {
  step: StepNumber;
  ok: boolean;
  ms: number;
}

/**
 * Result of one `runAtomicSync` call (AC1, AC7).
 *   - Success — every step landed; `.genie/sync.json` was written last.
 *   - Failure — a step BEFORE the anchor failed; `.genie/sync.json` was NOT
 *     written. `failedStep` is the 1-based step that threw, `error` is the
 *     underlying cause, and `events` records every step attempted up to and
 *     including the failure.
 */
export type SyncResult =
  | { ok: true; events: StepEvent[] }
  | { ok: false; failedStep: StepNumber; error: Error; events: StepEvent[] };

/**
 * One content write for the sync. Structurally the same as `write_files`'
 * per-file input, so the batch passes straight through to the plan-gated
 * `writeFiles` core fn: exactly one of `data` (inline bytes — the common
 * case for genie-generated component source/render) or `localPath` (a source
 * path resolved against the plan's `localDir`) must be set.
 */
export interface WriteInput {
  path: string;
  data?: string;
  encoding?: "utf-8" | "base64";
  localPath?: string;
  mimeType?: string;
}

/**
 * Arguments to {@link runAtomicSync} (AC1). The issue's literal signature is
 * `{ planId, writes, deletes }`; `verified` is threaded through additively so
 * step 5's anchor can carry the `<group>/<Name>` ids that passed the M3-04
 * validator within THIS sync (M3-06's `PlanResult.verified`). It is optional and
 * defaults to `[]`, so the literal AC1 shape still type-checks and runs — the
 * two issues were told to converge on each other's shape (see `anchor.ts`'s
 * module-doc coordination note), and this is that convergence.
 */
export interface SyncArgs {
  planId: string;
  writes: WriteInput[];
  deletes: string[];
  /** `<group>/<Name>` ids that passed validation this sync (M3-06 anchor). */
  verified?: string[];
}

/**
 * Injected collaborators (mirrors `conjure_screen.ts`'s `ConjureScreenDeps`).
 *
 * - `store` — the kit backend steps 2–3 write/delete through (LocalFs or
 *   GitHost), behind the same `KitStore` seam every M1 verb uses.
 * - `projectRoot` — the on-disk kit root the native sentinel + anchor are
 *   written to. CONTRACT: this MUST be the same directory the injected `store`
 *   resolves the plan's `kitId` to (for `LocalFsKitStore`,
 *   `<baseDir>/<kitId>`), so the fs-native sentinel/anchor and the
 *   store-written content land in ONE tree. The sync-flow caller computes it;
 *   the orchestrator takes it explicitly, matching `writeAnchor`'s own
 *   `projectRoot`-first signature (M3-06).
 */
export interface SyncDeps {
  store: KitStore;
  projectRoot: string;
}

// ─── runAtomicSync (AC1–AC7, AC9) ────────────────────────────────────────────

/**
 * Run the 5-step atomic sync sequence. Stops on the first failing step (AC7),
 * leaving `.genie/sync.json` unwritten so the next sync's diff repairs the
 * half-write; a not-found delete inside step 3 is NOT a failure (AC4). Every
 * attempted step emits a {@link StepEvent} (AC9).
 */
export async function runAtomicSync(deps: SyncDeps, args: SyncArgs): Promise<SyncResult> {
  const { store, projectRoot } = deps;
  const events: StepEvent[] = [];

  try {
    // Step 1 — fence the tree with the recompile sentinel FIRST (AC2).
    await runStep(1, events, () => writeSentinel(projectRoot));
    // Step 2 — content writes, chunked ≤ 256/call (AC3).
    await runStep(2, events, () => runWrites(store, args.planId, args.writes));
    // Step 3 — deletes (AC4); a not-found delete does not throw (M1-09 AC5).
    await runStep(3, events, () => runDeletes(store, args.planId, args.deletes));
    // Step 4 — re-arm the sentinel so it fences right up to the anchor (AC5).
    await runStep(4, events, () => writeSentinel(projectRoot));
    // Step 5 — write `.genie/sync.json` LAST as the completion proof (AC6).
    await runStep(5, events, () => writeFinalAnchor(projectRoot, args));

    return { ok: true, events };
  } catch (error) {
    // The failing step pushed its own `ok: false` event before rethrowing, so
    // the last event's step IS the failed step (AC7). `?? 1` is unreachable
    // (a throw always follows at least one pushed event) but keeps the type
    // total without a non-null assertion.
    const failedStep = events[events.length - 1]?.step ?? 1;
    return {
      ok: false,
      failedStep,
      error: error instanceof Error ? error : new Error(String(error)),
      events,
    };
  }
}

// ─── detectResumeStep (AC8) ──────────────────────────────────────────────────

/**
 * Inspect a kit root and report where the NEXT sync should resume from (AC8):
 *
 *   - `2`    — sentinel present, anchor ABSENT: a prior sync fenced the tree
 *              (step 1) then crashed before the anchor landed (steps 2–4). The
 *              tree is a half-write; resume from step 2 to re-apply
 *              writes/deletes and re-arm before writing the anchor.
 *   - `1`    — sentinel AND anchor both absent: a fresh, never-synced kit.
 *              Start a normal sync from step 1.
 *   - `null` — the anchor is present (a prior sync completed cleanly): there is
 *              no partial-write to resume; the next sync is a NEW plan from step
 *              1 with fresh inputs, not a resume.
 *
 * Never mutates the tree. Propagates {@link readAnchor}'s `AnchorParseError`
 * for a corrupt-but-present anchor — a corrupt anchor is a real operability
 * problem, not a "nothing to resume" signal (same reasoning `readAnchor` itself
 * applies).
 */
export async function detectResumeStep(projectRoot: string): Promise<StepNumber | null> {
  const sentinelPresent = await pathExists(join(projectRoot, RECOMPILE_SENTINEL_PATH));
  const anchor = await readAnchor(projectRoot); // null when absent (AC8 of M3-06)

  if (anchor !== null) return null; // clean — last sync completed
  return sentinelPresent ? 2 : 1; // half-write → step 2; fresh → step 1
}

// ─── Step bodies ─────────────────────────────────────────────────────────────

/**
 * Write (or re-arm) the native recompile sentinel fs-directly under
 * `projectRoot`. Idempotent — steps 1 and 4 both call it and the second write
 * simply reproduces the same bytes. Not plan-gated: `.genie/recompile` is
 * genie's own bookkeeping, never user content.
 */
async function writeSentinel(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, ".genie"), { recursive: true });
  await writeFile(join(projectRoot, RECOMPILE_SENTINEL_PATH), RECOMPILE_SENTINEL_BODY, "utf-8");
}

/**
 * Step 2 — apply all content writes, chunked into ≤ `MAX_FILES_PER_CALL`
 * batches, one plan-gated `writeFiles` call each (AC3). An empty `writes` array
 * yields zero batches → zero calls → a clean no-op (the step still emits its
 * event). A `WriteFailedError` / `PathOutsidePlanError` from any batch
 * propagates and fails the step.
 */
async function runWrites(store: KitStore, planId: string, writes: WriteInput[]): Promise<void> {
  for (const batch of chunk(writes, MAX_FILES_PER_CALL)) {
    await writeFiles(store, { planId, files: batch });
  }
}

/**
 * Step 3 — apply all deletes in one plan-gated `delete_files` call (AC4).
 *
 * Skipped entirely when there is nothing to delete: `delete_files`' args schema
 * requires `paths` to be non-empty (`.min(1)`), so calling it with `[]` would
 * be an `InvalidArguments` error rather than a no-op. A not-found path is
 * handled INSIDE `deleteFiles` (returned in `notFoundPaths`, never thrown), so
 * it does not fail this step (AC7's not-found exception). Only a real error
 * (out-of-plan path, unlink failure) propagates.
 */
async function runDeletes(store: KitStore, planId: string, deletes: string[]): Promise<void> {
  if (deletes.length === 0) return;
  await deleteFiles(store, { planId, paths: deletes });
}

/**
 * Step 5 — assemble M3-06's `PlanResult` from the sync inputs and write
 * `.genie/sync.json` LAST via {@link writeAnchor} (AC6). `writeAnchor` hashes
 * only source/render-extension paths and does its own temp-file + rename commit,
 * so this step is the atomic completion proof.
 */
async function writeFinalAnchor(projectRoot: string, args: SyncArgs): Promise<void> {
  const planResult: PlanResult = {
    writes: await resolveAnchorWrites(args.planId, args.writes),
    verified: args.verified ?? [],
  };
  await writeAnchor(projectRoot, planResult);
}

/**
 * Resolve each {@link WriteInput} to the `{ path, content }` shape
 * `writeAnchor` hashes. Inline `data` resolves for free (utf-8 → the string;
 * base64 → the decoded `Buffer`); a `localPath` is read from disk, resolved
 * against the plan's `localDir` exactly as `write_files` resolves it — so the
 * anchor hashes the same bytes that landed. `getPlan` is consulted only when at
 * least one `localPath` write exists, so the common all-inline sync pays no
 * extra plan read.
 *
 * A write with neither `data` nor `localPath` is unreachable here (step 2's
 * `write_files` would have rejected it, and step 5 only runs once step 2
 * passed); it is defensively hashed as empty rather than throwing.
 */
async function resolveAnchorWrites(
  planId: string,
  writes: WriteInput[],
): Promise<PlanResult["writes"]> {
  let localDir: string | null = null;
  const resolved: PlanResult["writes"] = [];

  for (const write of writes) {
    let content: string | Buffer;
    if (write.data !== undefined) {
      content = write.encoding === "base64" ? Buffer.from(write.data, "base64") : write.data;
    } else if (write.localPath !== undefined) {
      localDir ??= (await getPlan(planId)).localDir;
      content = await readFile(resolve(localDir, write.localPath));
    } else {
      content = "";
    }
    resolved.push({ path: write.path, content });
  }

  return resolved;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Time one step, push its {@link StepEvent}, and either return the step's value
 * or re-throw after recording the failure (AC9). The re-throw is what
 * `runAtomicSync`'s outer catch turns into the stop-on-first-failure result — so
 * the failing step's event is always recorded before the sequence unwinds.
 */
async function runStep<T>(step: StepNumber, events: StepEvent[], fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const value = await fn();
    events.push({ step, ok: true, ms: performance.now() - start });
    return value;
  } catch (error) {
    events.push({ step, ok: false, ms: performance.now() - start });
    throw error;
  }
}

/** Split `items` into consecutive slices of at most `size` (AC3 chunking). */
function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** True if `path` exists (any node type). Used only for the sentinel probe. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
