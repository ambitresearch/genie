/**
 * Public barrel for `@genie/viewer` (M4-01 scaffold). Mirrors the
 * `@genie/server` `index.ts` convention: downstream code (future M4
 * work, tests, or a consumer that wants to drive the CLI programmatically)
 * imports from here rather than reaching into `./cli.js` directly.
 *
 * Only the CLI surface exists at this milestone — the Vite config (M4-02),
 * grid renderer (M4-03), and HMR bridge (M4-04) each add their own exports
 * here as they land.
 */
export {
  buildProgram,
  runCli,
  parsePort,
  VIEWER_VERSION,
  DEFAULT_PORT,
  type CliIO,
} from "./cli.js";
