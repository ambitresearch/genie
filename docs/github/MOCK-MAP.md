# MOCK-MAP.md — issue → design-mock mapping

> Which issues carry a **## Design Reference** and which mock an agent validates
> against. Two tiers: **pixel-diff** (the issue renders a genie surface — screenshot it
> and compare to the mock) and **reference** (the issue's output is shaped by a surface
> but isn't a direct visual diff — use the mock for context + identity rules).
>
> Mocks live in `docs/designs/design-1/*.svg`. On GitHub they render at:
> `https://github.com/roshangautam/genie/blob/main/docs/designs/design-1/<file>.svg`
> In a clone: open `docs/designs/design-1/<file>.svg` directly.
>
> **Validation protocol** for any issue with a Design Reference: see `AGENTS.md` §3.

## The mocks

| Mock | Depicts |
|---|---|
| `00-front-door.svg` | Empty/generate state — prompt box (UI-kit + model + Conjure), 5 blueprint tiles, recent kits, `/genie-sync` callout |
| `01-ds-browser.svg` | UI-kit file-browser → component detail (variants grid, `@dsCard` marker, files, `✓ synced`) |
| `02-preview-refine.svg` | Rendered component + Tweaks/Comments toolbar + sliders + state-strip + code block + Apply |
| `03-embedded-modes.svg` | Embedded tier in 3 MCP-App modes — inline / fullscreen / pip; system fonts, host-deferred |
| `ref-foundations.svg` | Reference — palette, type scale, spacing, two-hue story |
| `ref-primitives.svg` | Reference — buttons (8 states), inputs, badges, model selector, code chips |
| `ref-dscard.svg` | Reference — `@dsCard` anatomy + marker + 4 validation states + light/dark |

## Tier 1 — pixel-diff targets (screenshot your build, compare to mock)

| Issue | Renders | Primary mock | Supporting |
|---|---|---|---|
| **M4-03** iframe grid renderer | the card grid | `02-preview-refine.svg` | `ref-dscard.svg` (card anatomy) |
| **M4-04** HMR per-card refresh | card re-render in place | `02-preview-refine.svg` | — |
| **M4-05** `render_preview` tool | the `ui://` grid payload | `03-embedded-modes.svg` (inline) | `02-preview-refine.svg` |
| **M4-06** register `ui://genie/grid` | inline/fullscreen/pip framings | `03-embedded-modes.svg` | — |
| **M4-07** CSP hardening for `ui://` | hardened payload renders identically | `03-embedded-modes.svg` | G-5 byte-identical check |
| **M4-08** `genie-viewer` CLI | the booted viewer at localhost | `02-preview-refine.svg` | `00-front-door.svg` (empty state) |
| **M4-09** a11y audit (axe-core) | the rendered viewer (contrast, roles) | `ref-foundations.svg` (palette/contrast) | `02-preview-refine.svg` |
| **M4-10** viewer E2E (file/localhost/ui) | all 3 vehicles, same cards | `03-embedded-modes.svg` | G-5 — cards must be byte-identical |
| **M3-03** `manifest.json` writer | feeds the grid; verify cards group right | `01-ds-browser.svg` (grouping) | `02-preview-refine.svg` |
| **M3-04** `validate_design_system` | the 4 validation states a card can show | `ref-dscard.svg` (4 states) | — |

## Tier 2 — reference context (shape output + obey identity rules; not a pixel diff)

| Issue | Why it gets a mock | Reference mock |
|---|---|---|
| **M4-01** viewer package scaffold | sets up the surface everything else renders into | `02-preview-refine.svg` |
| **M4-02** Vite multi-page config | each `preview.html` is a card entry point | `02-preview-refine.svg` |
| **M1-15** `list_components` | response feeds the browser grouping | `01-ds-browser.svg` |
| **M2-03** `generate_component` | the generate moment — clay/gilt accent applies here | `00-front-door.svg` + `02-preview-refine.svg` |
| **M2-04** `refine_component` | the refine moment — sliders + region rect | `02-preview-refine.svg` |
| **M3-01** `@dsCard` regex validator | the marker the card detail depends on | `ref-dscard.svg` |
| **M3-06** `_ds_sync.json` writer | the `✓ synced` status the browser shows | `01-ds-browser.svg` |
| **M1-12** `report_validate` | advisory telemetry on validation states | `ref-dscard.svg` |

## Identity guardrail (every visual issue)

The genie accent rule is the #1 visual-validation check: **clay/gilt
(`#c87c5e`/`#ac5a40`) appears ONLY on generation + refine moments.** Structure —
chrome, browser, grid, layout — stays ink/ink-blue/neutral. An agent screenshotting
its build must confirm it didn't bleed accent into structural chrome. See `AGENTS.md`
§3 + the hard rules.
