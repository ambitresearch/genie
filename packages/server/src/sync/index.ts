/**
 * Public re-export barrel for genie's sync layer:
 *   - M3-06 (`anchor.ts`) — the `.genie/sync.json` verification anchor.
 *   - M3-05 (`orchestrator.ts`) — the 5-step atomic write-sequence orchestrator
 *     that writes that anchor last.
 *
 * Mirrors the existing `store/index.ts` / `validate/index.ts` barrel pattern:
 * downstream consumers (the sync-flow caller wiring generation → commit, and any
 * future consumer outside this directory) import from `../sync/index.js` rather
 * than reaching into `./anchor.js` / `./orchestrator.js` directly, so the
 * module's internal file layout can change without breaking callers.
 */
export {
  ANCHOR_PATH,
  GENIE_BY_ENV,
  DEFAULT_BY,
  writeAnchor,
  readAnchor,
  AnchorParseError,
  type Anchor,
  type PlanResult,
} from "./anchor.js";

export {
  RECOMPILE_SENTINEL_PATH,
  RECOMPILE_SENTINEL_BODY,
  runAtomicSync,
  detectResumeStep,
  type StepNumber,
  type StepEvent,
  type SyncResult,
  type WriteInput,
  type SyncArgs,
  type SyncDeps,
} from "./orchestrator.js";
