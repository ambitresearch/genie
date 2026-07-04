/**
 * Public re-export barrel for genie's `.genie/sync.json` verification anchor
 * (M3-06 / AC1).
 *
 * Mirrors the existing `store/index.ts` / `validate/index.ts` barrel pattern:
 * downstream consumers (the M3-05 atomic sync orchestrator, and any future
 * consumer outside this directory) import from `../sync/index.js` rather
 * than reaching into `./anchor.js` directly, so the module's internal file
 * layout can change without breaking callers.
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
