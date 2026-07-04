/**
 * Public re-export barrel for genie's `@genie` marker validator (M3-01 / AC6).
 *
 * Mirrors the existing `store/index.ts` / `plans/index.ts` barrel pattern:
 * downstream consumers (the M3-02 watcher, the M3-03 manifest compiler, the
 * M3-04 `validate` full-scan facet, and any future consumer outside this
 * directory) import from `../validate/index.js` rather than reaching into
 * `./marker.js` directly, so the module's internal file layout can change
 * without breaking callers.
 */
export {
  MARKER_REGEX,
  validateMarker,
  extractViewport,
  type MarkerValidationResult,
  type MarkerViewport,
} from "./marker.js";
