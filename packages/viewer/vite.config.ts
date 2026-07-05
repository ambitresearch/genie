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
 *   - `GENIE_KIT_ROOT` — the `<kit-dir>` to serve (defaults to CWD so a bare
 *     `vite`/`pnpm --filter @genie/viewer serve` from inside a kit still works).
 *   - `GENIE_VIEWER_PORT` — optional `--port` override (AC3); ignored if unset
 *     or non-numeric, so the factory's 5173 default applies.
 *
 * Keeping the env-read here (not in the factory) preserves the factory's
 * purity: tests call `createViewerConfig({ root })` directly, never touching
 * `process.env`.
 */
import { defineConfig } from "vite";

import { createViewerConfig } from "./src/config.js";

const kitRoot = process.env.GENIE_KIT_ROOT ?? process.cwd();

const portEnv = process.env.GENIE_VIEWER_PORT;
const parsedPort = portEnv === undefined ? undefined : Number(portEnv);
const port =
  parsedPort !== undefined && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : undefined;

export default defineConfig(createViewerConfig({ root: kitRoot, port }));
