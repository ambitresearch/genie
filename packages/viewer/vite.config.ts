/**
 * M4-02 (DRO-264) — `@genie/viewer` Vite entry config.
 *
 * AC1 names THIS file (`packages/viewer/vite.config.ts`) as the config Vite
 * loads. It is deliberately a thin shim: every decision — the glob-built
 * multi-page `input`, host/port, ES2022 target, the no-store HTML plugin —
 * lives in the pure, unit-tested `createViewerConfig` factory
 * (`src/config.ts`). Here we only bridge the runtime env the CLI/dev-server
 * boot (M4-08) will set into that factory:
 *
 *   - `GENIE_KIT_ROOT` — the `<kit-dir>` to serve. Defaults to `process.cwd()`,
 *     so a bare `vite` launched from inside a kit serves that kit. NOTE: run
 *     via `pnpm --filter @genie/viewer serve`, cwd is the *viewer package*
 *     dir, not your kit — set `GENIE_KIT_ROOT` explicitly there (the polished
 *     M4-08 CLI will pass the kit-dir arg through this same env).
 *   - `GENIE_VIEWER_PORT` — optional port override (AC3), parsed leniently by
 *     `parseViewerPortEnv`: unset / non-numeric / out-of-range falls back to
 *     the factory's 5173 default rather than crashing.
 *
 * Keeping the env-read here (not in the factory) preserves the factory's
 * purity: tests call `createViewerConfig({ root })` directly, never touching
 * `process.env`. (The parse itself lives in `config.ts` so its branches are
 * unit-tested without importing this shim.)
 */
import { defineConfig } from "vite";

import { createViewerConfig, parseViewerPortEnv } from "./src/config.js";

const kitRoot = process.env.GENIE_KIT_ROOT ?? process.cwd();

// A malformed GENIE_VIEWER_PORT degrades to the factory's 5173 default rather
// than crashing the dev server (see parseViewerPortEnv). An explicit --port
// typo is a hard error, but that path is the CLI's (cli.ts parsePort), not
// this ambient-env shim's.
const port = parseViewerPortEnv(process.env.GENIE_VIEWER_PORT);

export default defineConfig(createViewerConfig({ root: kitRoot, port }));
