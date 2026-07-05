# @genie/viewer

Vite-backed live preview + UI-kit browser for genie. Watches a kit directory
(`.genie/manifest.json` + `components/`) and renders the same cards genie's
MCP tools produce, in a grid, with HMR — see the research report §3.4 and
§7 step 5 linked from [`docs/github/`](../../docs/github).

## Status: booting dev-server CLI (M4-08)

This package ships the `genie-viewer` CLI — it boots the Vite **multi-page dev
server** against a kit directory (every `components/**/preview.html` is its own
entry point), prints the preview URL, opens your browser, and stops cleanly on
Ctrl-C. The grid renderer and HMR card-refresh that fill that page land next
(M4-03 / M4-04).

| Milestone           | Adds                                                       |
| ------------------- | ---------------------------------------------------------- |
| M4-01               | package scaffold, CLI arg-parsing, usage/version           |
| M4-02               | Vite multi-page config — one entry per `preview.html`      |
| M4-08 (this change) | dev-server boot: URL print, port fallback, open, Ctrl-C    |
| M4-03               | iframe grid renderer                                       |
| M4-04               | chokidar watch + HMR-driven card refresh via `postMessage` |
| M4-05…M4-10         | UI-kit file browser, refine pane, polish                   |

See the issue backlog in [`docs/github/issues/`](../../docs/github/issues) for
the full M4 breakdown.

## Quickstart

```bash
# Boot a live preview of a synced kit (opens your browser at the URL):
npx genie-viewer ui_kits/acme
#   Preview: http://127.0.0.1:5173

# Pick a port (falls back to the next free one, with a warning, if it's taken):
npx genie-viewer ui_kits/acme --port 5180

# Headless / CI — print the URL but don't open a browser:
npx genie-viewer ui_kits/acme --no-open
```

Press **Ctrl-C** to stop: the watcher and dev server shut down within a second.

> **The kit must be synced first.** `genie-viewer` refuses a directory without a
> `.genie/manifest.json` (the client-side compiler's output) and exits non-zero,
> pointing you at running the genie MCP server against the kit first. That
> manifest is the signal the kit has cards to render.

## Usage

```bash
npx genie-viewer <kit-dir> [--port N] [--no-open]
```

```
Usage: genie-viewer <kit-dir> [--port N]

Vite-backed UI-kit preview grid.
Boots a live preview of <kit-dir> — every components/**/preview.html as a
card — prints the URL, and opens your browser. Ctrl-C stops it cleanly.

Arguments:
  kit-dir        path to the UI kit directory to preview

Options:
  -v, --version  print the version and exit
  --port <n>     dev server port (default: 5173)
  --open         open the preview in the system browser (default: true)
  --no-open      do not open a browser
  -h, --help     display help for command
```

## Serving a kit directly (without the CLI)

The Vite config (`vite.config.ts` → [`src/config.ts`](src/config.ts)) serves a
kit directory as a **multi-page app**: the kit's root `index.html` is the
always-present entry, and every `components/**/preview.html` becomes its own
Vite entry point (globbed with `fast-glob`), hot-reloaded independently. The
CLI above wraps this; to drive Vite yourself (e.g. debugging the config):

```bash
# Point the serve script at a kit (set GENIE_KIT_ROOT — see note below):
GENIE_KIT_ROOT=/path/to/kit pnpm --filter @genie/viewer serve

# ...with an explicit port too:
GENIE_KIT_ROOT=/path/to/kit GENIE_VIEWER_PORT=5180 pnpm --filter @genie/viewer serve
```

> **Why `GENIE_KIT_ROOT` is required here:** the kit root defaults to
> `process.cwd()`, but `pnpm --filter @genie/viewer` runs the script with the
> working directory set to the _viewer package_ (`packages/viewer`), not the
> directory you invoked it from — so without `GENIE_KIT_ROOT` it would try to
> serve the package dir (which has no kit `index.html`). Only a bare `vite`
> launched from _inside_ a kit picks that kit up via the cwd default. The
> `genie-viewer` CLI passes the `<kit-dir>` argument through for you, so you
> won't set this by hand.

Behaviour (the config's acceptance criteria):

| Aspect       | Behaviour                                                            |
| ------------ | -------------------------------------------------------------------- |
| Entries      | root `index.html` + one per `components/**/preview.html`             |
| Host / port  | `127.0.0.1:5173` (loopback only, no LAN exposure); port via `--port` |
| Build target | ES2022                                                               |
| Kit statics  | `tokens/`, `styles.css`, `_vendor/` served at their kit-root paths   |
| HTML caching | `Cache-Control: no-store` on HTML responses (never a stale card)     |
| Routing      | `appType: "mpa"` — a missing card 404s, no SPA index fallback        |

The config lives in a pure `createViewerConfig({ root, port })` factory so it
can be snapshot-tested without booting a server (`src/config.test.ts`); the
root `vite.config.ts` is a thin env-reading shim over it.

## Development

```bash
pnpm --filter @genie/viewer build       # tsc → dist/
pnpm --filter @genie/viewer typecheck   # tsc --noEmit
pnpm --filter @genie/viewer dev         # tsx watch src/cli.ts
pnpm --filter @genie/viewer serve       # vite (multi-page kit dev server)
```

Tests live alongside sources (`src/**/*.test.ts`) and run via the workspace
root's `pnpm test` (vitest).
