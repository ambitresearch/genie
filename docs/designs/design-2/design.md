# genie — Design 2: "Drafting Room" (`design.md`)

> Alternative direction for review, alongside Design 1 (`docs/designs/design-1/`),
> Design 3 (`docs/designs/design-3/`), Design 4 (`docs/designs/design-4/`).
> Hallmark-managed candidate. v0.1 (drafting-room direction). 2026-06.
>
> **Same product, different material.** Identical surfaces, content, and hard
> rules as Design 1 — only the visual system changes, so the four directions
> can be compared like-for-like.

---

## One-line pitch

genie as the **draftsman's bench**: a cool, measured, squared-off engineering
surface where components are *drafted to spec* against your UI kit. Where Design 1
is warm parchment + candle-lamp, Design 2 is the cool morning light of a precision
drawing table — ink-blue rules, dimension lines, registration ticks.

## Why this exists (relationship to Design 1)

Design 1 is warm-light editorial. To avoid four variations on one idea, Design 2
takes the **cool-technical pole**: it escapes the warm-neutral band entirely (no
cream — a genuinely cool off-white), and **promotes ink-blue from a demoted focus
colour to the lead structural identity**. The clay accent is unchanged, but against
a cool field it reads *crisper and hotter* — the warm-against-cool contrast is the
most legible "this is the generate moment" signal in the whole set. Speaks directly
to **Priya** (staff design-systems engineer): precision, validation, measurement.

---

## Direction

Three facts shape everything:

1. **Cool, measured, technical — not cozy.** A cool off-white drafting surface
   (blue-grey, not bone), squared corners, hairline ink-blue rules, lots of air.
   Reads as an instrument bench, calm but exacting.
2. **The harness supplies the chat.** Unchanged from Design 1 — genie owns only the
   **preview + refine pane** and the **UI-kit browser**; the harness (Claude Code /
   Cursor / VS Code) is the conversation. Show the seam, ghost the harness.
3. **Two product surfaces, not a Figma canvas.** Unchanged (RFC NG-1): a UI-kit
   file-browser and a preview+refine pane. Light selection feedback is fine; free
   canvas as the hero is not.

---

## Genre & voice

- **Genre:** technical-modernist (drafting-table precision).
- **Voice:** exact, calm, engineered. The **grotesque display** carries technical
  authority; sans body carries clarity; mono carries the protocol *and* the
  measurements (dimensions, counts, `@genie` markers).
- **The one rule that carries the brand:** genie-clay appears ONLY on
  generation + refine moments — Conjure, the active slider, the comment in focus,
  Apply. Everything structural is ink / **ink-blue** / cool neutral. Against the cool
  field the scarcity reads as a precise instrument signal, and it survives the
  MCP-App CSP (colour identity needs no font to load).

---

## Color (OKLCH — see `tokens.css` for the full token block)

> **Cool-technical.** Surface is a true cool off-white (hue ~255, *away* from warm);
> ink is a cool near-black. **Ink-blue is the lead structural colour** — rules,
> labels, the dimension lines, selection, links. Clay is retained exactly, generate
> only. This is genie reading as a measuring instrument, not a warm reading-room.

| Role | Token | OKLCH | Hex | Use |
|---|---|---|---|---|
| Paper | `--color-paper` | `97% 0.008 255` | `#f4f6f9` | cool off-white base |
| Paper raised | `--color-paper-2` | `94% 0.010 255` | `#ebeef3` | rails, cards |
| Paper sunken | `--color-paper-3` | `91% 0.012 256` | `#e2e7ee` | wells, hover |
| Ink | `--color-ink` | `19% 0.012 262` | `#14171f` | cool near-black text |
| Ink-2 | `--color-ink-2` | `34% 0.014 262` | `#39414f` | secondary text/body |
| Ink-3 | `--color-ink-3` | `52% 0.016 258` | `#697384` | tertiary, placeholder |
| Hairline | `--color-hairline` | `87% 0.012 256` | `#d3dae3` | borders, rules |
| Hairline strong | `--color-hairline-2` | `80% 0.016 257` | `#bcc5d2` | dividers |
| **Struct (ink-blue, LEAD)** | `--color-struct` | `45% 0.12 265` | `#345197` | rules, labels, links, selection |
| Struct deep | `--color-struct-2` | `36% 0.13 266` | `#27407a` | pressed/heading rule |
| Struct tint | `--color-struct-tint` | `93% 0.03 265` | `#dde6f5` | selection fill, measured wells |
| Dimension line | `--color-dimension` | `66% 0.07 262` | `#8ba0c9` | CAD-style measure marks |
| Focus ring | `--color-focus` | `52% 0.14 265` | `#4064b9` | `:focus-visible`, ≥3:1 |
| **Accent (clay)** | `--color-accent` | `66% 0.105 42` | `#c87c5e` | **generation + emphasis ONLY** |
| Accent deep | `--color-accent-2` | `56% 0.115 38` | `#ac5a40` | clay hover/pressed |
| Accent tint | `--color-accent-tint` | `93% 0.030 46` | `#f7e1d6` | generating fill |
| Accent edge | `--color-accent-edge` | `82% 0.070 44` | `#ecb6a0` | clay keyline |
| Success | `--color-success` | `57% 0.13 152` | `#2f8f57` | validated, saved |
| Warning | `--color-warning` | `70% 0.13 70` | `#cf8a2e` | thin / marker-warn |
| Danger | `--color-danger` | `55% 0.18 28` | `#c5372f` | error, missing @genie |

Dark mode = cool slate (`#13161c` paper), ink-blue and clay both brighten; the field
stays cool, never warm. See `tokens.css` `:root[data-scheme="dark"]`.

---

## Type

| Role | Family | Notes |
|---|---|---|
| Display | **Space Grotesk** (free Google geometric-grotesque) | headings, wordmark; weight 500–700; tracking −0.01em; engineered, measured character |
| Body | **Inter** | descriptions, prose; 16px / 1.55 — humanist, contrasts the geometric display |
| Mono | **JetBrains Mono** | `@genie` markers, tokens, paths, **dimensions & counts** |

Pairing axis: **geometric-grotesque display + humanist-sans body** (a real contrast
axis, not two near-identical sans). Mono is the constant "protocol voice" across all
four genie directions.

Scale (1.250 major-third, 16px base): xs 12 · sm 14 · base 16 · md 18 · lg 22 ·
xl 28 · 2xl 36 · 3xl 48 · display 64 / 52. Display tracking −0.01em (grotesque sits
tighter than the serif but never below −0.04em).

**No display italics** — emphasis via weight, clay, or ink-blue.

---

## Spacing · radii · motion

- **Spacing (4pt):** 2xs 4 · xs 8 · sm 12 · md 16 · lg 24 · xl 32 · 2xl 48 · 3xl 64 · 4xl 96
- **Radii (squared — drafting precision):** sm 4 · md 6 · lg 8 · xl 12 · pill 999.
  Deliberately tighter than Design 1; the bench is precise, not soft.
- **Rules:** the **ink-blue hairline is the primary divider** (not a warm grey).
  Dimension lines use `--color-dimension` with tick caps.
- **Elevation:** cool, low shadows (hue 260°). `--shadow-accent` = clay glow for
  generating state only.
- **Motion:** `--ease-out` cubic-bezier(0.16,1,0.3,1); fast 120 / base 200 / slow
  320; transform + opacity only; honor `prefers-reduced-motion`. Generate = a precise
  draw-in, not a bounce.

---

## Craft signatures (what makes this "Drafting Room")

- **Ink-blue dimension lines** annotate live renders (`|—— 180 ——|`, `56 ⏐`), like
  CAD measurement marks — the validation/precision tell.
- **Registration ticks** at panel corners (small crosshair marks); a *very* faint
  cool grid wash behind the hero (a whisper of graph paper, never a loud blueprint).
- **Squared corners + hairline ink-blue rules** instead of warm soft cards.
- **No lamp glow, no smoke, no gilt gradient.** The "magic" is exactness. Conjure is
  a flatter clay fill with a thin clay keyline and a single registration tick where
  Design 1 had a wisp.
- Lit edges become a **cool** 1px top highlight (`#ffffff` at low opacity), not warm.

---

## The two tiers (MCP-App constraint) — unchanged in spirit

Same as Design 1 (RFC G-5): `file://`, `localhost:5173` (Vite viewer), and
`ui://genie/grid` (MCP App under `default-src 'none'`). Web fonts can't load in the
embedded tier.

- **Embedded tier** (`ui://genie/grid`): system fonts only (`--font-*-safe`), defers
  surface/ink to host theme (`.genie-embedded`); identity held by genie-clay +
  ink-blue structure. Display falls back to `ui-sans-serif`/grotesque-safe stack.
- **Standalone tier** (Vite viewer, README, docs): full brand — Space Grotesk +
  Inter + JetBrains Mono (`--font-*-brand`).

Card markup byte-identical across vehicles; only the shell differs. Display modes
(`inline` / `fullscreen` / `pip`) per MCP Apps spec — see Design 1 `design.md` for
the negotiation detail; identical here.

---

## Surfaces (mockups in this folder)

| File | Surface |
|---|---|
| `00-front-door.svg` | empty / generate state — "Your wish is my command." prompt box (UI-kit + model + Conjure), starter blueprints, recent kits + `/genie-sync`. Cool drafting field, ink-blue rules. |
| `01-ui-kit-browser.svg` | UI-kit file-browser → component detail (variants live render with dimension lines, `@genie` marker, files, ✓ validated). |
| `02-preview-refine.svg` | rendered component + Tweaks/Comments + genie sliders + state strip + code + Apply; harness chat ghosted (the seam). |
| `03-embedded-modes.svg` | the embedded tier in all 3 MCP-App display modes (inline / fullscreen / pip); system fonts, host-deferred. |

Content matches Design 1 exactly so the directions compare like-for-like.

---

## Anti-patterns (on top of Hallmark's + genie's shared list)

- ❌ Cream / warm-neutral surface — that's Design 1's lane; Design 2 must stay cool.
- ❌ A literal blueprint-grid wallpaper or cyan "blueprint" cliché — the grid is a
  whisper; ink-blue is a precise structural navy, not blueprint-cyan.
- ❌ Indigo/grotesk *techy-SaaS* read (the archived v1) — ink-blue here is a measured
  drafting navy with a warm clay counterpoint and humanist body, not a cold dev-tool.
- ❌ Terracotta accent — genie is clay. ❌ Clay on anything structural.
- ❌ A draggable Figma canvas as the hero workflow.

---

## Exports

Token formats live in `tokens.css`. When a real build starts, generate Tailwind
`@theme`, DTCG `tokens.json`, and shadcn CSS vars from the same block.
