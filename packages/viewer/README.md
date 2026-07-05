# @genie/viewer

Vite-backed live preview + UI-kit browser for genie. Watches a kit directory
(`.genie/manifest.json` + `components/`) and renders the same cards genie's
MCP tools produce, in a grid, with HMR — see the research report §3.4 and
§7 step 5 linked from [`docs/github/`](../../docs/github).

## Status: scaffold (M4-01)

This package currently ships only the `genie-viewer` CLI's argument parser
and usage/version output. It does **not** boot a dev server, watch the
filesystem, or render anything yet — that lands incrementally:

| Milestone            | Adds                                                       |
| -------------------- | ---------------------------------------------------------- |
| M4-01 (this package) | package scaffold, CLI arg-parsing, usage/version           |
| M4-02                | Vite multi-page config                                     |
| M4-03                | iframe grid renderer                                       |
| M4-04                | chokidar watch + HMR-driven card refresh via `postMessage` |
| M4-05…M4-10          | UI-kit file browser, refine pane, polish                   |

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

Until M4-02+ lands, passing a `kit-dir` only echoes what was parsed — nothing
is served.

## Development

```bash
pnpm --filter @genie/viewer build       # tsc → dist/
pnpm --filter @genie/viewer typecheck   # tsc --noEmit
pnpm --filter @genie/viewer dev         # tsx watch src/cli.ts
```

Tests live alongside sources (`src/**/*.test.ts`) and run via the workspace
root's `pnpm test` (vitest).
