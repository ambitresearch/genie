# @genie/viewer

Vite-backed live preview + UI-kit browser for genie. Watches a kit directory
(`.genie/manifest.json` + `components/`) and renders the same cards genie's
MCP tools produce, in a grid, with HMR — see the research report §3.4 and
§7 step 5 linked from [`docs/github/`](../../docs/github).

## Status: Vite multi-page config (M4-02)

This package ships the `genie-viewer` CLI's argument parser plus the Vite
**multi-page config** that serves a kit directory with every
`components/**/preview.html` as its own entry point. The polished dev-server
_boot_ (`genie-viewer <kit-dir>` actually starting Vite, port-fallback,
auto-open, Ctrl-C teardown) is still M4-08; today you drive Vite directly via
the `serve` script (see [Serving a kit](#serving-a-kit)).

| Milestone           | Adds                                                       |
| ------------------- | ---------------------------------------------------------- |
| M4-01               | package scaffold, CLI arg-parsing, usage/version           |
| M4-02 (this change) | Vite multi-page config — one entry per `preview.html`      |
| M4-03               | iframe grid renderer                                       |
| M4-04               | chokidar watch + HMR-driven card refresh via `postMessage` |
| M4-05…M4-10         | UI-kit file browser, refine pane, polish                   |

See the issue backlog in [`docs/github/issues/`](../../docs/github/issues) for
the full M4 breakdown.

## Usage

```bash
npx genie-viewer <kit-dir> [--port N]
```

```
Usage: genie-viewer <kit-dir> [--port N]

Vite-backed UI-kit preview grid.
Scaffold build (M4-01): parses arguments and prints usage only.
The dev server, grid renderer, and HMR bridge land in M4-02 through M4-08.

Arguments:
  kit-dir        path to the UI kit directory to preview

Options:
  -v, --version  print the version and exit
  --port <n>     dev server port (default: 5173)
  -h, --help     display help for command
```

Until the M4-08 dev-server boot lands, passing a `kit-dir` to `genie-viewer`
only echoes what was parsed — to actually serve a kit today, use the `serve`
script below.

## Serving a kit

The Vite config (`vite.config.ts` → [`src/config.ts`](src/config.ts)) serves a
kit directory as a **multi-page app**: the kit's root `index.html` is the
always-present entry, and every `components/**/preview.html` becomes its own
Vite entry point (globbed with `fast-glob`), hot-reloaded independently.

```bash
# From inside a kit directory (root defaults to CWD):
pnpm --filter @genie/viewer serve

# Or point at an explicit kit + port:
GENIE_KIT_ROOT=/path/to/kit GENIE_VIEWER_PORT=5180 pnpm --filter @genie/viewer serve
```

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
