# genie — Design 4: "Instrument" (`design.md`)

> Alternative direction for review, alongside Design 1 (`docs/design/`),
> Design 2 (`docs/design-2/`), Design 3 (`docs/design-3/`).
> Hallmark-managed candidate. v0.1 (instrument direction). 2026-06.
>
> **Same product, different material.** Identical surfaces, content, and hard
> rules as Design 1 — only the visual system changes.

---

## One-line pitch

genie as a **precision instrument**: a true off-white, chroma-0 lab surface where the
clay accent is the *only* colour on the page — the sole signal, flat and exact. No lamp,
no glow, no warmth-by-default. Structure is rendered in hairlines and air; the eye goes
to clay because there is nothing else competing for it.

## Why this exists (relationship to Design 1)

Designs 1–3 all commit to warmth in the *surface* (cream, cool-grey-with-tint,
oxblood). Design 4 takes the **neutral-austere pole**: a genuinely uncoloured field
(OKLCH chroma 0) so the set spans the full temperature axis. This is the Swiss /
laboratory reading — genie as a calibrated measuring tool. The restraint makes the clay
accent *louder* by removing every other colour: ink-blue is demoted all the way to the
focus ring and text selection; semantic colours are the only other chroma and they
appear only in their moment. Speaks to **Dr. Lina Okafor** (headless/air-gapped
research) and **Kenji** (DevTools PM, CLI-first): exact, quiet, no theatre.

---

## Direction

Three facts shape everything:

1. **True off-white, chroma-0.** The surface is uncoloured white→light-grey (OKLCH
   C = 0). No warm tint, no cool tint — the deliberate refusal of the cream/sand AI
   default *and* of "cool-grey-because-tools." Neutrality is the statement.
2. **The harness supplies the chat.** Unchanged — genie owns preview + refine + the kit
   browser. The ghosted harness rail is the lightest possible grey hatch; the seam is a
   single hairline.
3. **Two product surfaces, not a Figma canvas.** Unchanged (RFC NG-1).

---

## Genre & voice

- **Genre:** Swiss-functional / instrument panel (laboratory white, hairline grid, air).
- **Voice:** exact, calm, unornamented. Says less; what it says is measured. Confidence
  through restraint, not flourish.
- **The one rule that carries the brand:** genie-clay appears ONLY on generation +
  refine — and here it is the **sole chroma** on an otherwise colourless page. Flat fill
  (no gradient, no glow, no gilt) — a precise mark, like a single calibration line on a
  white dial. Removing all other colour makes the scarce clay the loudest it is in any
  of the four directions.

---

## Color (OKLCH — see `tokens.css` for the full token block)

> **Chroma-0 neutral.** Paper + ink ramps at C = 0 (true grey). Clay is the ONLY
> chroma in resting state, and it is FLAT (no gradient). Ink-blue is demoted to the
> focus ring + selection. Semantic colours appear only in their moment.

| Role | Token | OKLCH | Hex | Use |
|---|---|---|---|---|
| Paper | `--color-paper` | `99% 0 0` | `#fbfbfb` | true off-white base |
| Paper-2 | `--color-paper-2` | `96.5% 0 0` | `#f4f4f5` | rails, wells |
| Paper-3 | `--color-paper-3` | `93.5% 0 0` | `#ececed` | sunken / code gutter |
| Ink | `--color-ink` | `19% 0 0` | `#16171a` | primary text (near-black, neutral) |
| Ink-2 | `--color-ink-2` | `36% 0 0` | `#454649` | secondary/body |
| Ink-3 | `--color-ink-3` | `58% 0 0` | `#86878b` | tertiary, placeholder (≥4.5:1) |
| Hairline | `--color-hairline` | `90% 0 0` | `#e2e2e4` | the primary structural device |
| Hairline strong | `--color-hairline-2` | `82% 0 0` | `#c9c9cc` | dividers, frames |
| **Accent (clay) — sole chroma** | `--color-accent` | `66% 0.105 42` | `#c87c5e` | generation, flat fill |
| Accent deep | `--color-accent-2` | `56% 0.115 38` | `#ac5a40` | pressed / clay text-on-light |
| Accent tint | `--color-accent-3` | `94% 0.030 46` | `#f6e2d8` | generating well (the only tinted fill) |
| Accent edge | `--color-accent-edge` | `82% 0.060 50` | `#e8bda8` | 1px frame on generating element |
| Struct (ink-blue) | `--color-struct` | `48% 0.13 264` | `#4064b9` | **focus ring + selection only** |
| Focus ring | `--color-focus` | `52% 0.14 264` | `#4f6fc6` | `:focus-visible` |
| Success | `--color-success` | `56% 0.13 152` | `#2f8f57` | validated (in-moment only) |
| Warning | `--color-warning` | `70% 0.12 70` | `#cf8a2e` | thin / dscard-warn |
| Danger | `--color-danger` | `55% 0.20 26` | `#c5372f` | error, missing @dsCard |

Ink-blue carries **no structural duty here** — it surfaces only when an element is
focused or text is selected. That is the inversion from Design 2 (where ink-blue
*leads*); Design 4 hands all structure to hairlines + spacing and keeps blue as a pure
interaction signal.

Dark mode: a neutral chroma-0 dark (`:root[data-scheme="dark"]`) — graphite, not warm,
not oxblood. Same instrument, lights down.

---

## Type

| Role | Family | Notes |
|---|---|---|
| Display + Body | **Archivo** (free Google grotesque) | ONE family across the whole UI; hierarchy by **weight + size only** — display 600/700 tight, body 400. The Swiss one-family move. |
| Mono | **JetBrains Mono** | `@dsCard` markers, tokens, paths, counts, dimensions |

Pairing axis: **single family in multiple weights** (impeccable-sanctioned alternative
to a contrast pairing) + the mono as the constant "protocol" voice. This is the sharpest
departure from Designs 1/3 (serif display) and 2 (Space Grotesk + Inter): here there is
no display/body *contrast of family* at all — the discipline is that one grotesque does
everything, and the restraint is the character. No italics; emphasis via weight.

Scale (1.250, 16px base): xs 12 · sm 14 · base 16 · md 18 · lg 22 · xl 28 · 2xl 36 ·
3xl 48 · display 60. Display weight 700, tracking −0.02em (never below −0.04em); body
400, 1.55 leading, capped 65–75ch.

---

## Spacing · radii · motion

- **Spacing (4pt):** shared scale with the set, but used with more **air** — the
  instrument breathes; whitespace is the second structural device after the hairline.
- **Radii:** sm 3 · md 5 · lg 7 · xl 10 · pill 999 — the **sharpest** of the four
  directions (precise corners suit a measuring tool).
- **Elevation:** near-flat. Shadows are minimal, neutral (C = 0), low-opacity; structure
  comes from **hairlines + space**, not from float. No glow, ever.
- **Motion:** `--ease-out` cubic-bezier(0.16,1,0.3,1); fast 120 / base 200 / slow 320;
  generate = a single clay fill + a precise 1px tick, no swell, no bloom. Reduced-motion
  = instant. Transform + opacity only.

---

## Craft signatures (what makes this "Instrument")

- **Hairlines do the structural work** — frames, dividers, the kit-tree, the live-render
  stage are all 1px neutral rules. No filled panels competing for attention.
- **Air as structure** — generous, deliberate whitespace; alignment to a strict modular
  grid is visible and intentional.
- **Clay is flat** — solid fill, no gradient/gilt/glow. A single precise mark.
- **One registration tick** (1px clay) marks a generate affordance — the minimal echo of
  Design 2's dimension language, dialled all the way down.
- **No lamp, no wisp, no warmth-by-default.** The personality is the precision.
- Mono carries every number/marker/path — the instrument's read-out.

---

## The two tiers (MCP-App constraint) — unchanged in spirit

Same as Design 1 (RFC G-5). Web fonts can't load embedded.

- **Embedded tier** (`ui://genie/grid`): system fonts only (`system-ui` / `ui-monospace`)
  and **defers surface + ink to the host theme** (`.genie-embedded`). Design 4 is the
  *most* host-deferential of the four — its resting state is already near-neutral, so
  adopting host surface/ink is almost seamless; identity holds via the flat clay accent
  + the hairline discipline.
- **Standalone tier** (Vite viewer, README, docs): full chroma-0 white + Archivo +
  JetBrains Mono.

Card markup byte-identical across vehicles. Display modes (`inline`/`fullscreen`/`pip`)
per spec — identical negotiation to Design 1.

---

## Surfaces (mockups in this folder)

| File | Surface |
|---|---|
| `00-front-door.svg` | empty / generate state — "Your wish is my command." set in Archivo, hairline prompt frame, flat-clay Conjure, starter blueprints, recent kits + `/genie-sync`. |
| `01-ds-browser.svg` | UI-kit browser → component detail; hairline live-render stage, `@dsCard` marker, ✓ validated. |
| `02-preview-refine.svg` | rendered component + Tweaks/Comments + sliders + state strip + code + Apply; ghosted harness rail (lightest grey hatch, hairline seam). |
| `03-embedded-modes.svg` | embedded tier in 3 MCP-App modes; deferring to host theme, system fonts, byte-identical card. |

Content matches Design 1 exactly so the directions compare like-for-like.

---

## Anti-patterns (on top of Hallmark's + genie's shared list)

- ❌ **Warm tint "for friendliness."** The surface is chroma-0; adding warmth would
  collapse it toward Design 1. Neutrality is the whole point.
- ❌ **Cool-grey tint** — that's Design 2's territory; Design 4 is true neutral, not blue-grey.
- ❌ Gradient / glow / gilt on the accent — clay is **flat** here. No exceptions.
- ❌ Ink-blue as structure — it is focus + selection only.
- ❌ Identical card grids / hero-metric template — austerity is not an excuse for the
  lazy card reflex; use the hairline grid + air instead.
- ❌ Terracotta accent; clay on anything structural; a Figma-canvas hero.

---

## Exports

Token formats live in `tokens.css`. When a real build starts, generate Tailwind
`@theme`, DTCG `tokens.json`, and shadcn CSS vars from the same block.
