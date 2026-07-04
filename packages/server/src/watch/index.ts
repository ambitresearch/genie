/**
 * Public re-export barrel for the M3-02 chokidar watcher (DRO-258 / AC-parity
 * with M3-01's own barrel convention).
 *
 * Mirrors the existing `store/index.ts` / `plans/index.ts` / `validate/
 * index.ts` barrel pattern: downstream consumers (the M3-03 manifest
 * compiler, the future M4-04 HMR bridge) import from `../watch/index.js`
 * rather than reaching into `./watcher.js` directly, so this module's
 * internal file layout can change without breaking callers.
 */
export {
  startWatcher,
  type StartWatcherOptions,
  type WatcherChange,
  type WatcherChangeType,
  type WatcherHandle,
} from "./watcher.js";
