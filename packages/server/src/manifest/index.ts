/**
 * Public re-export barrel for the M3-03 manifest compiler (DRO-259).
 *
 * Mirrors the existing `store/index.ts` / `plans/index.ts` / `validate/
 * index.ts` / `watch/index.ts` barrel pattern: downstream consumers (the
 * M3-02 watcher's `onChange` wiring, `validate`'s M3-04 full-scan facet, the
 * M4 viewer's build tooling) import from `../manifest/index.js` rather than
 * reaching into `./compiler.js` directly, so this module's internal file
 * layout can change without breaking callers.
 */
export {
  compileManifest,
  type CompileResult,
  type Manifest,
  type ManifestCard,
  type ManifestSkip,
} from "./compiler.js";
