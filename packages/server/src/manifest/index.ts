/**
 * Public re-export barrel for the M3-03 manifest compiler (DRO-259).
 *
 * Mirrors the existing `store/index.ts` / `plans/index.ts` / `validate/
 * index.ts` / `watch/index.ts` barrel pattern: downstream consumers (the
 * M3-02 watcher's `onChange` wiring, the future M4-05 `preview` tool) import
 * from `../manifest/index.js` rather than reaching into `./compiler.js`
 * directly, so this module's internal file layout can change without
 * breaking callers.
 */
export { compileManifest, type Manifest, type ManifestCard } from "./compiler.js";
