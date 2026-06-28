# genie — Design 3: "Lamplight" (`design.md`)

> Alternative direction for review, alongside Design 1 (`docs/designs/design-1/`),
> Design 2 (`docs/designs/design-2/`), Design 4 (`docs/designs/design-4/`).
> Hallmark-managed candidate. v0.1 (lamplight direction). 2026-06.
>
> **Same product, different material.** Identical surfaces, content, and hard
> rules as Design 1 — only the visual system changes.

---

## One-line pitch

genie as **the lamp in the dark room**: a drenched, warm-dark oxblood surface where
the only true light is the clay itself — the act of generating *emits* an amber glow.
Where Design 1 is daylight parchment with a lamp on it, Design 3 *turns the lights off*
so the lamp is the whole point.

## Why this exists (relationship to Design 1)

Design 1 and 2 are both light-surface. Design 3 takes the **saturated-dark pole** so
the set isn't three pale variations. The brief explicitly bans "warm-charcoal SaaS
dark" — so this is **not** a near-black tool theme. The surface is a *committed brand
colour*: deep oxblood/umber (warm hue, pushed chroma), the drenched strategy. The clay
accent is the same hue but is now treated as **emitted light** — a luminous amber core
with bloom — so "generate" literally lights the room. Speaks to **Marco** (indie
builder): genie should feel a little magic, like a wish being granted.

---

## Direction

Three facts shape everything:

1. **Drenched warm-dark — a brand colour, not a charcoal.** Oxblood/umber surface
   (OKLCH L ~0.16–0.24, real chroma, hue ~25). It must read as "genie committed to a
   warm colour," never as a generic dark IDE. Warmth lives in the *surface*, not just
   the accent.
2. **The harness supplies the chat.** Unchanged — genie owns preview + refine and the
   kit browser. In the dark, the ghosted harness rail sits *in shadow*; the seam is
   literally the line where genie's lamplight meets the harness's darkness.
3. **Two product surfaces, not a Figma canvas.** Unchanged (RFC NG-1).

---

## Genre & voice

- **Genre:** atmospheric-editorial (a warm study after dark, one lamp lit).
- **Voice:** warm, literary, a little magical — but precise underneath. The
  **high-contrast serif** carries the literary warmth; the sans carries calm clarity;
  mono carries the protocol.
- **The one rule that carries the brand:** genie-clay appears ONLY on
  generation + refine — and here it is **light**. Conjure, the active slider, the
  focused comment, Apply *glow*. Everything structural is warm-cream ink, ghosted
  umber, and a *brightened* ink-blue. Because the field is dark, the scarce clay does
  the most work of any direction — it is the source of illumination.

---

## Color (OKLCH — see `tokens.css` for the full token block)

> **Drenched oxblood.** Surface is a deep warm brand colour (hue ~22–30, real chroma),
> NOT charcoal. Ink is warm cream. Clay is the emitted light — a luminous amber core
> brighter than its base. Ink-blue brightens to stay legible structure on the dark.

| Role | Token | OKLCH | Hex | Use |
|---|---|---|---|---|
| Paper (oxblood) | `--color-paper` | `18% 0.040 28` | `#241310` | drenched warm-dark base |
| Paper raised | `--color-paper-2` | `23% 0.045 27` | `#33211b` | rails, cards (lifted into light) |
| Paper sunken | `--color-paper-3` | `15% 0.035 28` | `#1d100d` | wells, deepest shadow |
| Ink (warm cream) | `--color-ink` | `94% 0.018 70` | `#f4ece3` | primary text |
| Ink-2 | `--color-ink-2` | `80% 0.020 64` | `#cbb9ac` | secondary/body |
| Ink-3 | `--color-ink-3` | `64% 0.022 58` | `#9a8579` | tertiary, placeholder (≥4.5:1) |
| Hairline | `--color-hairline` | `30% 0.030 30` | `#46342b` | borders in shadow |
| Hairline strong | `--color-hairline-2` | `38% 0.034 30` | `#5c4538` | dividers |
| **Accent core (light)** | `--color-accent-core` | `82% 0.110 62` | `#f0b483` | luminous amber — the lamp's flame |
| Accent (clay) | `--color-accent` | `66% 0.105 42` | `#c87c5e` | generation body |
| Accent deep | `--color-accent-2` | `56% 0.115 38` | `#ac5a40` | clay shadow side |
| Accent bloom | `--color-accent-glow` | `88% 0.090 68` | `#ffcf9e` | glow halo / rim-light |
| Struct (ink-blue) | `--color-struct` | `66% 0.10 262` | `#7d97c9` | brightened structure, links |
| Struct tint | `--color-struct-2` | `72% 0.10 263` | `#8fa6d6` | hover/selection |
| Focus ring | `--color-focus` | `70% 0.12 264` | `#7e9cdc` | `:focus-visible`, ≥3:1 on dark |
| Success | `--color-success` | `72% 0.15 152` | `#5cc47a` | validated |
| Warning | `--color-warning` | `78% 0.13 72` | `#e6ad55` | thin / marker-warn |
| Danger | `--color-danger` | `66% 0.17 26` | `#e8645a` | error, missing @genie |

There is no separate light mode here — Lamplight *is* the dark. A light fallback
(`:root[data-scheme="light"]`) is provided for accessibility/host-deference parity;
it warms toward Design-1 territory but keeps Fraunces + the glow language.

---

## Type

| Role | Family | Notes |
|---|---|---|
| Display | **Fraunces** (free Google high-contrast old-style serif) | headings, wordmark; opsz high, weight 400–600; tracking −0.015em; warm literary character (distinct from Design 1's Newsreader) |
| Body | **Inter** | descriptions, prose; 16px / 1.55 — calm sans clarity against the serif |
| Mono | **JetBrains Mono** | `@genie` markers, tokens, paths, counts |

Pairing axis: **high-contrast serif display + neutral sans body** — same axis family
as Design 1 but a *different serif* (Fraunces' sharper contrast + optical sizing reads
more dramatic by lamplight than Newsreader's bookish calm). **No display italics** —
emphasis via weight + glow.

Scale (1.250, 16px base): xs 12 · sm 14 · base 16 · md 18 · lg 22 · xl 28 · 2xl 36 ·
3xl 48 · display 64 / 52. Display tracking −0.015em (never below −0.04em).

---

## Spacing · radii · motion

- **Spacing (4pt):** identical scale to Design 1/2 (rhythm is shared across the set).
- **Radii:** sm 6 · md 9 · lg 14 · xl 20 · pill 999 — slightly softer than Design 2;
  warm light wraps rounded forms.
- **Elevation:** shadows are deep and warm (hue 28°, higher opacity on the dark field);
  the signature is **light, not shadow** — `--shadow-glow` (amber bloom) on generating
  elements and a warm **rim-light** on lifted card edges.
- **Motion:** `--ease-out` cubic-bezier(0.16,1,0.3,1); fast 120 / base 200 / slow 320;
  generate = a **glow swelling up** (opacity/blur of the bloom layer), reduced-motion =
  instant amber fill. Transform + opacity + filter(blur on the glow) only.

---

## Craft signatures (what makes this "Lamplight")

- **The lamp-glow is the hero**, not a touch: a radial amber bloom behind the prompt
  box and beneath every generate affordance. In the dark this is the brand.
- **Warm rim-light** (amber, *not* white) on the top edge of lifted cards/rails — the
  light source is genie's own lamp, raking across surfaces.
- **Smoke/wisp** returns as a soft warm vapour off the lamp mark (Design 1 had wisps;
  here they curl up into darkness).
- **Ghosted harness rail sits in shadow** — darker than genie's panels, low-contrast
  hatch; the dashed seam is the lit/unlit boundary.
- Ink-blue is *brightened* so structure stays readable without stealing the clay's job
  as the only warm light.

---

## The two tiers (MCP-App constraint) — unchanged in spirit

Same as Design 1 (RFC G-5). Web fonts can't load embedded.

- **Embedded tier** (`ui://genie/grid`): system fonts only; **defers surface + ink to
  the host theme** (`.genie-embedded`). This matters most for Lamplight — inside a
  *light* host (Claude Desktop light), genie does NOT force its dark oxblood; it adopts
  the host surface and keeps identity via clay-glow + ink-blue. The drenched dark is a
  *standalone* expression; embedded, the lamp glows on whatever surface the host gives.
- **Standalone tier** (Vite viewer, README, docs): full drenched oxblood + Fraunces +
  Inter + JetBrains Mono.

Card markup byte-identical across vehicles. Display modes (`inline`/`fullscreen`/`pip`)
per spec — identical negotiation to Design 1.

---

## Surfaces (mockups in this folder)

| File | Surface |
|---|---|
| `00-front-door.svg` | empty / generate state — "Your wish is my command." prompt box glowing in the dark, starter blueprints, recent kits + `/genie-sync`. The lamp lit. |
| `01-ui-kit-browser.svg` | UI-kit browser → component detail; live render stage lit by lamplight, `@genie` marker, ✓ validated. |
| `02-preview-refine.svg` | rendered component + Tweaks/Comments + sliders + state strip + code + Apply; harness rail in shadow (the lit/unlit seam). |
| `03-embedded-modes.svg` | embedded tier in 3 MCP-App modes; **shown deferring to a light host** to prove the lamp travels (system fonts, host-deferred). |

Content matches Design 1 exactly so the directions compare like-for-like.

---

## Anti-patterns (on top of Hallmark's + genie's shared list)

- ❌ **Warm-charcoal SaaS dark / terminal-native dark** — the second-order reflex. The
  surface must read as committed oxblood (real chroma, warm hue), not neutral charcoal.
- ❌ Neon / cyberpunk glow — the glow is a warm *lamp flame*, soft and amber, never a
  saturated neon ring.
- ❌ Pure-black `#000` surfaces — it's a warm dark, never void-black.
- ❌ Terracotta accent — genie is clay. ❌ Clay/glow on anything structural (glow only
  marks generate/refine).
- ❌ A draggable Figma canvas as the hero workflow.

---

## Exports

Token formats live in `tokens.css`. When a real build starts, generate Tailwind
`@theme`, DTCG `tokens.json`, and shadcn CSS vars from the same block.
