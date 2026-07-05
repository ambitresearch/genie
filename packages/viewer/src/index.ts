/**
 * Public barrel for `@genie/viewer` (M4-01 scaffold). Mirrors the
 * `@genie/server` `index.ts` convention: downstream code (future M4
 * work, tests, or a consumer that wants to drive the CLI programmatically)
 * imports from here rather than reaching into `./cli.js` directly.
 *
 * The CLI surface (M4-01) and the Vite multi-page config (M4-02) exist at this
 * milestone; the grid renderer (M4-03) and HMR bridge (M4-04) each add their
 * own exports here as they land.
 */
export {
  buildProgram,
  runCli,
  parsePort,
  VIEWER_VERSION,
  DEFAULT_PORT,
  type CliIO,
} from "./cli.js";

export {
  createViewerConfig,
  collectPreviewEntries,
  previewEntryKey,
  noStoreHtmlPlugin,
  DEFAULT_VIEWER_PORT,
  DEFAULT_HOST,
  BUILD_TARGET,
  type ViewerConfigOptions,
} from "./config.js";
