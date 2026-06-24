# genie — Design System (`design.md`)

> Locked design system for `genie`. Hallmark-managed. v1.0 (hybrid direction).
> Last revised: 2026-06-22.
>
> **This file is the source of truth.** Every surface, mockup, and the eventual
> Vite viewer build defers to it. Iterate by amending this file, not by drifting.

---

## Direction

genie is the **harness-native sibling of Anthropic's Claude Design**. Same
warm-editorial premium feel, but its **own accent** (genie-clay clay-coral, not
Claude Design's terracotta) so it reads as sibling, not clone.

Three facts shape everything:

1. **Warm-editorial, not techy.** Cream paper, near-black serif display, lots of
   air. Calm and premium. Decided after reviewing the real Claude Design UI — the
   first (indigo + grotesk) direction read as a different, techier product.
2. **The harness supplies the chat.** Claude Design builds its own conversation
   panel because it's a standalone destination. genie lives inside Claude Code /
   Cursor / VS Code — the harness IS the chat. genie owns only the **preview +
   refine pane** and the **design-system browser**. This is the wedge no
   competitor can copy.
3. **Two product surfaces, not a Figma canvas.** genie is (a) a design-system
   file-browser (groups → components, readme, Published/Default) and (b) a
   preview+refine pane (rendered component, Tweaks/Comments toolbar, sliders
   genie generates). It is NOT a draggable-canvas tool in v1 (RFC NG-1).

---

## Genre & voice

- **Genre:** editorial-modern (warm-editorial leaning).
- **Voice:** confident, calm, premium. Serif display carries authority; sans body
  carries clarity; mono carries the protocol (markers, tokens, file paths).
- **The one rule that carries the brand:** genie-clay appears ONLY on
  generation + refine moments — Generate, the active slider, the comment in
  focus, Apply. Everything structural is ink / ink-blue / warm neutral. Scarcity
  makes the clay read as magic, and it survives the MCP-App CSP (color identity
  doesn't need a font to load).

---

## Color (OKLCH — see `tokens.css` for the full token block)

> **Claude-aligned.** Paper/ink use Claude's warm bone + near-black; the accent
> is a softened clay/coral in the Claude coral family (`#c87c5e`, not the brighter
> gold of the first pass — it was too hot against the bone). genie reads as a
> Claude first-party sibling. Ink-blue (`--color-struct`) stays for focus/selection.

| Role | Token | OKLCH | Hex | Use |
|---|---|---|---|---|
| Paper | `--color-paper` | `98% 0.005 85` | `#faf8f5` | warm bone base (Claude-aligned) |
| Paper raised | `--color-paper-2` | `95.5% 0.008 82` | `#f3f0ea` | rails, cards |
| Paper sunken | `--color-paper-3` | `92.5% 0.010 80` | `#eae6df` | hover, wells |
| Ink | `--color-ink` | `20% 0.004 60` | `#171614` | near-black warm text |
| Ink-2 | `--color-ink-2` | `37% 0.005 60` | `#423f3d` | secondary text |
| Ink-3 | `--color-ink-3` | `55% 0.008 65` | `#75716d` | tertiary, placeholder |
| Hairline | `--color-hairline` | `88% 0.008 82` | `#dad7d2` | borders, rules |
| **Accent (clay)** | `--color-accent` | `66% 0.105 42` | `#c87c5e` | **generation + emphasis ONLY** |
| Accent deep | `--color-accent-2` | `56% 0.115 38` | `#ac5a40` | clay hover/pressed |
| Accent tint | `--color-accent-tint` | `93% 0.030 46` | `#fae2d8` | generating fill |
| Struct (ink-blue) | `--color-struct` | `45% 0.12 265` | `#345197` | links, selection, focus base |
| Focus ring | `--color-focus` | `52% 0.14 265` | `#4064b9` | `:focus-visible`, ≥3:1 |
| Success | `--color-success` | `58% 0.13 150` | `#348f4f` | validated, saved |
| Warning | `--color-warning` | `72% 0.14 68` | `#dd9231` | thin / dscard-warn |
| Danger | `--color-danger` | `55% 0.18 28` | `#c5372f` | error, missing @dsCard |

Dark mode = warm charcoal (`#161310` paper), clay + ink-blue brighten, never cold.
See `tokens.css` `:root[data-scheme="dark"]`.

---

## Type

| Role | Family | Notes |
|---|---|---|
| Display | **Newsreader** (free Google serif, Tiempos/Times feel) | headings, wordmark; weight 500–600; tracking −0.015em; **roman always** |
| Body | **Inter** | descriptions, prose; 16px / 1.55 |
| Mono | **JetBrains Mono** | `@dsCard` markers, tokens, file paths, counts |

Scale (1.250 major-third, 16px base): xs 12 · sm 14 · base 16 · md 18 · lg 22 ·
xl 28 · 2xl 36 · 3xl 48 · display 72 / 56 (long copy).

**No italic headers** (Hallmark gate 38a) — emphasis via weight, clay, or
ink-blue, never an italic display face.

---

## Spacing · radii · motion

- **Spacing (4pt):** 2xs 4 · xs 8 · sm 12 · md 16 · lg 24 · xl 32 · 2xl 48 · 3xl 64 · 4xl 96
- **Radii:** sm 6 · md 10 · lg 14 · xl 20 · pill 999
- **Elevation:** warm shadows (hue 70°, never cold black). `--shadow-clay` =
  clay glow for generating state.
- **Motion:** `--ease-out` cubic-bezier(0.16,1,0.3,1); durations fast 120 / base
  200 / slow 320; animate transform + opacity only; honor `prefers-reduced-motion`.

---

## The two tiers (MCP-App constraint)

genie ships the same cards through three vehicles (RFC G-5): `file://`,
`localhost:5173` (Vite viewer), `ui://genie/grid` (MCP App). The MCP App runs
under `default-src 'none'; connect-src 'none'` — **web fonts can't load**. So:

- **Embedded tier** (`ui://genie/grid`, in-host): system fonts only
  (`--font-*-safe`), defers surface/ink to host theme (`.genie-embedded`),
  identity held by genie-clay + structure. Web fonts blocked by CSP.
- **Standalone tier** (Vite viewer, README, docs): full brand — Newsreader serif
  + Inter + JetBrains Mono (`--font-*-brand`).

Card markup is byte-identical across vehicles; only the surrounding shell differs.

### Display modes (MCP Apps spec, 2026-01-26)

The embedded `ui://genie/grid` iframe negotiates ONE of three display modes with
the host — it is NOT fixed to one spot. Per
`modelcontextprotocol/ext-apps/specification/2026-01-26/apps.mdx`:

- **`inline`** (default) — embedded in the host's content flow (a card in the
  conversation). genie shows a compact preview here.
- **`fullscreen`** — the View takes over the full screen/window. This is what
  Claude Desktop does — genie's grid/canvas owns the screen, host chrome recedes.
  The richest genie surface.
- **`pip`** — picture-in-picture, a floating overlay. A persistent mini-preview
  while you work elsewhere.

Negotiation: genie declares `appCapabilities.availableDisplayModes` at
`ui/initialize`; host advertises `HostContext.availableDisplayModes`; genie calls
`ui/request-display-mode { mode }` to switch; host returns the actual mode set
(may differ). Host notifies changes via `ui/notifications/host-context-changed`.
Sizing is separate (`containerDimensions` fixed/flexible/unbounded +
`ui/notifications/size-changed`), not per-mode.

URI MUST start `ui://`; MIME MUST be `text/html;profile=mcp-app`.

Design implication: the embedded surface must look right at THREE scales — a
small inline card, a full-window takeover, and a floating pip. Same artifact,
three framings.

---

## Surfaces (current mockups)

| File | Surface | Models |
|---|---|---|
| `00-front-door.svg` | empty / generate state — "Your wish is my command." prompt box (UI-kit + model + Conjure), starter blueprints (5 categories), recent kits + `/genie-sync` callout, the harness-native pitch | Claude Design "What will you design today?" + v0 prompt |
| `01-ds-browser.svg` | UI-kit file-browser → component-detail view (variants grid, `@dsCard` marker, files, Published/Default, `✓ synced` status) | Claude Design DS view |
| `02-preview-refine.svg` | rendered component + Tweaks/Comments toolbar + genie-generated sliders + state-strip + code block + Apply; harness chat shown ghosted | Claude Design artifact view |
| `03-embedded-modes.svg` | the embedded tier in all 3 MCP-App display modes — inline (chat card) / fullscreen (window takeover) / pip (floating overlay); system fonts, host-deferred | MCP Apps spec 2026-01-26 |
| `ref-foundations.svg` | reference — system at a glance (palette, type, spacing, the two-hue story) | — |
| `ref-primitives.svg` | reference — buttons (8 states), inputs, badges, model selector, code chips | — |
| `ref-dscard.svg` | reference — the @dsCard component dissected: anatomy + marker + 4 validation states + light/dark | — |

All four product screens (00–03) are 3 craft passes deep: structure → content
depth → premium polish (lit edges, clay gradient). Reference sheet documents the
locked system.

---

## Anti-patterns (genie-specific, on top of Hallmark's)

- ❌ Indigo/grotesk techy direction (the rejected v1 — archived in `_archive-v1/`).
- ❌ Drawing a chat panel genie has to build — the harness supplies it. Show the
  seam, ghost the harness.
- ❌ Terracotta accent — that's Claude Design's. genie is clay.
- ❌ A draggable Figma canvas as the *hero workflow* — genie v1 is browser +
  preview, not a freeform canvas tool. (Light selection feedback — a selection
  box + resize handles on the focused component — is fine and useful; the
  anti-pattern is making free-canvas manipulation the primary way you work, the
  way Figma does. genie's primary refine model is comment-pins + generated
  sliders, with selection handles as secondary affordance.)
- ❌ genie-clay on anything structural — clay is generation-only.

---

## Exports

Token formats live in `tokens.css` (CSS custom properties). When the real viewer
build starts, generate Tailwind `@theme`, DTCG `tokens.json`, and shadcn CSS vars
from the same token block (Hallmark `export-formats`).
