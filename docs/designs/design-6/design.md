# Design 6 — Warm Instrument

> Hallmark designation: **warm-instrument**
> Critique stamp: P5 H5 E5 S5 R5 V5

## 1. Direction in one sentence

Warm Instrument fuses design-1's warm bone-paper craft with design-4's hairline-driven
instrument shell, channels option-2's prompt-first onboarding, option-1's workbench split,
and option-3's explicit review/approval flow into a single coherent direction.

## 2. Hybrid rationale

| Borrowed from | What it contributes                                                              | What was left behind                                      |
| ------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| design-1      | Warm bone paper (`#faf8f5`), Newsreader serif display, near-black warm ink, clay | Lamp glow on structural chrome, large card blobs          |
| design-4      | Hairline-first structure, air-driven layout, near-flat elevation, sharp radii    | Cold off-white paper, Archivo single-family, chroma-0 ink |
| option-1      | Tree-left + detail-right workbench split                                         | Static preview-only browsing                              |
| option-2      | Prompt-first onboarding — generate box is the page's centre of gravity           | REPL-only monotone input                                  |
| option-3      | Explicit Approve / Request Changes review panel                                  | Inline-only comment flow without approval                 |

The synthesis: warm paper + ink + serif identity (design-1) held together by hairline
structure + disciplined whitespace (design-4), with a prompt-first front door (option-2),
a workbench split for kit browsing (option-1), and an explicit review flow (option-3).

**Clay/gilt rule (non-negotiable):** The clay (`#c87c5e`) accent appears **only** on
generate and refine moments — the Conjure button, Refine prompts, Apply, the `@genie`
marker, and generation-progress states. All structural chrome stays ink/neutral.
The structural **Primary button is ink-filled** (`--color-ink`), **not** clay: clay is
the generation spark, never a button-rank colour (see the **Button hierarchy** in §5).
This is an identity contract; violating it erases the sibling relationship with Claude Design.

## 3. Color system

```css
/* Warm paper (design-1 origin) */
--color-paper: oklch(98% 0.005 85); /* warm bone   #faf8f5 */
--color-paper-2: oklch(95.5% 0.008 82); /* raised      #f3f0ea */
--color-paper-3: oklch(92.5% 0.01 80); /* sunken/hover #eae6df */

/* Warm ink */
--color-ink: oklch(20% 0.004 60); /* near-black  #171614 */
--color-ink-2: oklch(37% 0.005 60); /* secondary   #423f3d */
--color-ink-3: oklch(55% 0.008 65); /* tertiary    #75716d */
--color-hairline: oklch(88% 0.008 82); /* border      #dad7d2 */

/* Clay / gilt — GENERATION MOMENTS ONLY */
--color-accent: oklch(66% 0.105 42); /* genie-clay  #c87c5e */
--color-accent-2: oklch(56% 0.115 38); /* deeper      #ac5a40 */
--color-accent-tint: oklch(93% 0.03 46); /* clay wash   #fae2d8 */
--color-accent-edge: oklch(82% 0.07 44); /* clay border #ecb6a0 */

/* Structural ink-blue (links / focus only — demoted from accent) */
--color-struct: oklch(45% 0.12 265); /* ink-blue    #345197 */
--color-struct-tint: oklch(93% 0.03 265); /* selected    #dee8fd */
```

## 4. Typography

| Role    | Family             | Weight  | Use                                              |
| ------- | ------------------ | ------- | ------------------------------------------------ |
| Display | Newsreader (serif) | 500–600 | Wordmark, generate-moment hero heading only      |
| Body    | Inter              | 400–700 | All UI text, labels, prose, tab names            |
| Mono    | JetBrains Mono     | 400–600 | `@genie` marker, selectors, code, protocol voice |

**Instrument discipline:** Newsreader is used **sparingly** — only the wordmark and the
generate-moment hero. Body copy and all UI labels use Inter. This is the restraint that
prevents Warm Instrument from sliding back into full editorial warmth.

## 5. Spacing and radii

Radii sit between design-1 (rounded) and design-4 (sharp):

| Token           | Value  | Rationale                    |
| --------------- | ------ | ---------------------------- |
| `--radius-xs`   | 3 px   | Checkboxes, micro-chips      |
| `--radius-sm`   | 5 px   | Buttons, selectors, tags     |
| `--radius-md`   | 8 px   | Prompt box, inspector panels |
| `--radius-lg`   | 12 px  | Cards, main content panels   |
| `--radius-xl`   | 16 px  | Modals, large overlays       |
| `--radius-pill` | 999 px | Status badges, pill labels   |

Spacing scale (px): 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96

### Button hierarchy (locked)

The button ladder is canonical. Clay is **never** a button-rank colour — it is the
generation spark. The loudest *structural* action is **ink-filled**, so clay can never
ride in on a Save / Submit / Delete. This is what makes "clay only on generation"
enforceable at the component level.

| Rank | Treatment | Tokens | Use |
| --- | --- | --- | --- |
| **Primary** | ink-filled | `--color-ink` (`#171614`) fill, `--color-paper` (`#faf8f5`) text; hover/active = a warmer/deeper ink (never cold black, per §6); disabled = ink @ ~0.42 opacity | The loudest **structural** action — Save, Confirm |
| **Secondary** | neutral outline | `--color-paper` fill + `--color-hairline-2` border + `--color-ink` text | Secondary structural action |
| **Ghost** | text only | `--color-struct` (ink-blue) text, no fill | Low-emphasis / inline action |
| **Delete / danger** | danger | `--color-danger` | Destructive action |
| **Generate / Conjure / Apply** | clay — the **sole** clay button | `--color-accent` (the generation spark) | Conjure, Refine, Apply only |

Clay is **never** the fill of a generic Primary / Save / Submit / Delete button.

## 6. Elevation

Warm shadows (**never cold black**) appear **only** on floating / lifted elements:

- `--shadow-sm` — prompt box at rest, flat cards in a stream
- `--shadow-md` — floating panels, popovers, tooltips
- `--shadow-lg` — modal overlays, sheet overlays
- `--shadow-accent` — clay glow during generating state **only**

Structural panels, sidebars, rails: **no shadow** — hairline + air only.

## 7. Surfaces (the four mocks)

### 00 — Front door (empty state / generate)

The page's centre of gravity is the generate prompt box — option-2's prompt-first
onboarding on warm bone paper. A Newsreader serif headline above the box; below the
box a hairline blueprint table (option-2's command-discipline); below that a recent-kits
list. The top bar is hairline-separated, no fill.

Clay appears: Conjure button fill, generate cursor.
Structure stays: all rails, headings, and cards ink/neutral.

### 01 — UI kit browser (workbench)

Option-1's workbench split — kit tree left (240 px) + component detail right. The tree
uses hairline structure with no background fills, warm bone paper. The detail pane shows
component variants, the `@genie` marker in JetBrains Mono, status badges, and a code
snippet with hairline container.

Clay appears: `@genie` marker text.
Structure stays: ink/neutral everywhere else.

### 02 — Preview + refine

Three-pane: ghosted harness chat (left, 280 px), rendered component stage (centre), refine

- review panel (right, 320 px). The refine panel embodies option-3's explicit review flow:
  Approve / Request Changes buttons at top, staged-tweaks list with clay highlight, Apply
  button (clay fill), comment thread below.

Clay appears: `@genie` marker, Refine prompt, Apply button, Approve badge.
Structure stays: panel borders, toolbar, chat rail, Request Changes button.

### 03 — Embedded tier (3 display modes)

The same `ui://genie/grid` iframe in three MCP-App display modes: **inline · fullscreen
· pip**. System fonts under the App CSP (`default-src 'none'`). Surface and ink defer to
host; genie-clay + structure carry identity. The constraint strip at top documents the
CSP laws that apply to this tier.

## 8. Two tiers — the CSP law

```
EMBEDDED  (ui://genie/grid)
  default-src 'none'
  connect-src 'none'
  font-src:   none  (system fonts only)
  → Use --font-*-safe stacks
  → .genie-embedded defers surface/ink to host
  → Clay accent (#c87c5e) NEVER defers — identity holds

STANDALONE  (Vite viewer, file://, docs)
  Full brand fonts allowed (Newsreader + Inter via bundler/CDN-free)
  → .genie-standalone uses --font-*-brand stacks
```

Cards are byte-identical across `file://`, `localhost`, and `ui://`. The embedded-tier
override is CSS-only: `.genie-embedded {}` adjusts font and color tokens; no JavaScript.

## 9. Anti-patterns

- ❌ Lamp glow on structural chrome (reserved for generate-moment, even then minimal)
- ❌ Gradient fills on nav, sidebar, or rails (hairline + air only)
- ❌ Clay accent on tabs, breadcrumbs, or structural navigation
- ❌ Clay as the fill of a generic Primary/Save/Submit button (clay is the generation spark only — Primary is ink-filled)
- ❌ Radius > 16 px on structural panels
- ❌ Cold off-white or chroma-0 paper
- ❌ Archivo or single-family sans-serif (Inter + Newsreader is the pairing)
- ❌ Web fonts in the embedded tier (App CSP blocks them)
- ❌ Skybridge (parked; must not be referenced)

## 10. Genie hard rules

All Genie interop terms carry forward verbatim:

- **DesignSync** — the two-way Figma ↔ code sync protocol
- **Claude Design** — the upstream tool genie acts as a harness for
- **@dsCard** — Anthropic Claude Design's annotation marker (interop only; genie-native is `@genie`)
- **\_ds\_\*** — Anthropic Claude Design's naming prefix convention (interop only; genie-native bookkeeping lives under `.genie/`)
- **design-sync** — the sync workflow
- **UI kit** — the user's component library (not "component library", not "design system")
- **blueprints** — starter templates (not "templates", not "starters")
- Clay/gilt accent **only** on generation and refine moments — non-negotiable identity rule

---

## 11. Information architecture (per surface)

Genie is an **app UI** (workbench / data-dense / task-focused), not a landing page.
Each surface declares an explicit primary → secondary → tertiary focus order so the eye
lands in the same place every time. The top bar (`Generate · Browse · Review`) is the only
persistent global nav; it stays ink/neutral (never clay).

| Surface | Primary (first) | Secondary (second) | Tertiary (third) |
| --- | --- | --- | --- |
| **00 Front door** | The prompt box + Conjure (centre of gravity) | Blueprints table | Recent-kits row |
| **01 UI-kit browser** | The selected component preview stage | Kit tree (240 px, left) | Selector/status meta + code snippet |
| **02 Preview + refine** | The rendered component stage (centre) | Review & Refine panel (320 px, right) | Conversation rail (280 px, left) |
| **03 Embedded** | The active `@genie` widget (per display mode) | The CSP constraint strip | Host-page chrome (ghosted, deferred) |

**Trunk test:** cover the top nav and each surface is still self-identifying — the front
door reads "generate," the browser reads "library workbench," review reads "approve a
draft." If a surface ever fails the trunk test, its primary element is under-weighted.

**Constraint-worship rule:** if a surface can only show three things, it shows the three
in its Primary/Secondary/Tertiary row above — everything else is progressive disclosure.

---

## 12. Interaction states (what the user sees)

Every interactive feature commits to all five states. **Empty states are features**, not
blanks — they teach the next action. Descriptions are what the *user sees*, not backend.

| Feature | Loading | Empty | Error | Success | Partial |
| --- | --- | --- | --- | --- | --- |
| **Prompt box / Conjure** | Conjure → `✦ Conjuring…` clay button, clay glow (`--shadow-accent`), input locked | Placeholder prompt + greyed Conjure (disabled until ≥1 char) | Inline clay-edged notice under box: model/endpoint error + "Try again"; prompt text preserved | Routes to Review with `draft #1`; toast "Generated <Name>" | Streamed tokens fill a skeleton card in place; Conjure stays in generating state until validated |
| **Kit tree (01)** | Hairline shimmer rows (no spinner) | "No kits yet — Conjure your first component" with a link to the front door | Row marked with neutral `⚠` + retry affordance; tree stays navigable | Selected node bolds, breadcrumb updates | Lazy groups show a count + a disclosure caret; un-expanded groups render their header only |
| **Component preview stage (01/02)** | "PREVIEW · …" label with a thin shimmer in the stage | "(rendered empty)" thin-card treatment (matches `ref-genie-card` thin state) | Sandboxed-iframe render failure → neutral "Preview unavailable" card, code panel still shown | Component renders at declared viewport (`@2x`) | Variant tabs (Default/Hover/Focus/Disabled) load independently; unbuilt variants are greyed |
| **Refine panel (02)** | Refine → clay generating state; diff stats show `…` until the diff returns | "No changes yet — describe a refinement or drag a slider" | Refine failed validation → diff rejected, panel shows the validator's reason in a neutral notice, prior draft intact (see §15 rejected-refine) | Checklist ticks green; "Apply to kit" enabled | Sliders re-parameterise instantly (no model call); only structural edits show the generating state |
| **Approve / Request changes (02)** | Approve shows a brief clay confirm; Request changes is neutral throughout | Decision row disabled until a draft exists | Apply/commit failure → neutral error with the git/plan reason; draft stays open | Approve → "Applied to kit" + commit ref; surface returns to Browse | Approve enabled but "Apply to kit" gated on a green checklist (keyboard-nav item may stay manual `○`) |
| **Embedded grid (03)** | Host-themed skeleton tiles (system fonts, no web-font flash) | "Generate a component" inline prompt (each mode has its own empty CTA) | CSP-blocked asset → silent host-deferred fallback; clay identity still holds | Cards render byte-identical to standalone (G-5) | Inline/PiP modes show a "Recent" stub list while the full grid is fetched |

---

## 13. Responsive & narrow-pane behaviour

Genie lives **inside a resizable harness pane** (Claude Code / Cursor / VS Code side
panels), so narrow widths are the common case, not an edge case. Layout responds to the
*pane* width, not the device. Breakpoints are content-driven, named by what collapses.

| Width band | 01 Browser | 02 Preview + refine | 00 Front door |
| --- | --- | --- | --- |
| **≥ 1100 px (full)** | Tree 240 + detail | Chat 280 · stage · refine 320 (three-pane) | Centred prompt, 2-col supporting tables |
| **720–1099 px (tablet/half-pane)** | Tree collapses to a 44 px rail of group icons; click expands an overlay tree | Conversation rail collapses to a toggle; stage + refine remain | Prompt full-width; blueprints + recent-kits stack to one column |
| **< 720 px (narrow pane)** | Single column: tree becomes a top breadcrumb-dropdown; detail fills width | Single column with a **segmented switch** (`Preview ⇄ Review`) — never three cramped columns; the refine panel becomes a bottom sheet | Prompt + Conjure only above the fold; everything else scrolls below |

**Rules:** panels **reflow, they do not merely shrink** — a 320 px refine panel never
squeezes below ~280 px; it docks to a bottom sheet instead. The clay accent and the
hairline structure are width-invariant. No horizontal scrolling of structural chrome.
The embedded tier defers its own width logic to the host display mode (inline/fullscreen/
pip) per §7-03.

---

## 14. Accessibility

Commitments are testable. Contrast values below are measured against `--color-paper`
(`#faf8f5`) unless noted; AA body text target is **≥ 4.5:1**, large/UI ≥ 3:1.

**Contrast ledger (measured):**

| Pair | Ratio | Verdict / usage rule |
| --- | --- | --- |
| `--color-ink` on paper | 17.1:1 | ✓ primary text |
| `--color-ink-2` on paper | 9.9:1 | ✓ secondary text |
| `--color-ink-3` on paper | 4.6:1 | ✓ on **base paper only** |
| `--color-ink-3` on paper-2 / paper-3 | 4.25:1 / 3.9:1 | ✗ as body — use `--color-ink-2` for text on raised/sunken surfaces; `ink-3` there is for non-text hairline labels only |
| `--color-struct` on paper | 7.2:1 | ✓ links |
| `--color-focus` on paper | 5.3:1 | ✓ focus ring (≥ 3:1) |
| `--color-accent` (clay) on paper | **3.05:1** | ✗ for normal text — see clay-text rule below |
| `--color-accent-2` (deep clay) on paper | 4.6:1 | ✓ — the **text-safe clay**; use for clay-coloured labels/`@genie` marker at body size |
| white on `--color-accent` | 3.2:1 | large/bold UI only (Conjure label ≥ 16 px semibold meets 3:1); for normal-size text on a clay fill, use `--color-accent-2` |
| white on `--color-accent-2` | 4.9:1 | ✓ button text |

**Clay-text rule (a11y refinement of the identity rule):** clay still appears *only* on
generate/refine moments — but where clay carries **text** at body size (the `@genie`
marker, refine labels), it renders in `--color-accent-2` (`#ac5a40`, 4.6:1), not
`--color-accent` (`#c87c5e`, 3.05:1). `--color-accent` remains the fill/large-control hue.
This changes no token and no identity — only which existing clay token small clay *text*
points at.

**Keyboard & focus:** every interactive element is tabbable in DOM/reading order;
focus is shown with a 2 px `--color-focus` ring (never removed, never clay). Per-surface
tab order follows the IA order in §11 (primary region first). The prompt box is the front
door's initial focus; the stage is the browser's; the draft + decision row is review's.

**ARIA landmarks (per surface):** `banner` (top bar) · `navigation` (kit tree / tabs) ·
`main` (the primary region from §11) · `complementary` (refine panel, conversation rail) ·
`contentinfo` (footer strip). The CSP constraint strip (03) is a `region` with an
accessible name.

**Targets & motion:** interactive targets are ≥ 44×44 px (tree rows, tabs, slider thumbs,
decision buttons). Generating animations (clay glow, streamed skeletons) honour
`prefers-reduced-motion: reduce` — they fall back to a static clay state with no pulsing.
The embedded tier additionally defers motion to the host where the host signals reduced
motion.

---

## 15. Unresolved design decisions

Tracked so they are not silently deferred into implementation. Each names what breaks if
it ships undecided.

| # | Decision needed | If deferred, what happens |
| --- | --- | --- |
| U-1 | **What the grid shows while conjuring** — skeleton card in place vs. modal vs. separate "drafts" lane | Conjure feels like a dead click; users re-submit and double-spend a model call |
| U-2 | **Narrow-pane nav pattern** — breadcrumb-dropdown vs. bottom-sheet vs. segmented switch (§13 proposes per-surface) | Each surface invents its own collapse, harness side-panel use (the primary vehicle) feels broken |
| U-3 | **How a rejected refine is surfaced** — inline notice + intact prior draft (proposed) vs. diff-with-errors vs. blocking modal | Failed validation silently discards work or applies a broken diff; the "freeze the rest" promise (D-I) looks untrue |
| U-4 | **Multi-kit ambiguity UI** (D-F resolution ladder: explicit→default→sole→ask) — what the "stop and ask" picker looks like on each surface | Genie either guesses a kit (betrays adherence) or hard-stops with no recovery affordance |
| U-5 | **Sync-state badge semantics** — is the clay "synced"/"design-sync active" pill a generate-moment (clay) or structural status (neutral)? | **DECIDED (iteration 2):** structural **status**, not a generate moment → **neutral**. The pill recolours clay→the success-green status semantic already used for "✓ validated" (`--color-success`), reading as status rather than an identity hue. Pixel re-render is owner-gated (see note). |
| U-6 | **"Primary = clay" vs. structural confirmations** — `ref-primitives` shows a clay Primary ("Save kit"); product surfaces keep non-generation confirmations neutral | **DECIDED (iteration 2):** Primary is **ink-filled**; clay is the spark only (see §5 *Button hierarchy*). `ref-primitives.svg` must be re-rendered (see note); product surfaces 00–03 are already compliant. |
| U-7 | **Diff stats / checklist source of truth** — are `+14/−6` and the checklist live validator output or static labels? | Review panel shows stale numbers; "Apply to kit" gating on the checklist becomes cosmetic |
| U-8 | **Embedded empty-state per display mode** — inline vs. fullscreen vs. pip each need a distinct first-run CTA | The three modes share one CTA that fits none; pip especially has no room for the front-door prompt |

**Reference-sheet re-render (owner-gated, separate task).** Resolving U-5/U-6 changes
the *spec* (§2, §5, §9 above); the matching **pixel** edit to the decorative
reference/status mocks is a small, low-risk, owner-gated follow-up, consistent with the
project's established "mock re-render is a separate task" workflow. **Nothing about the
locked palette/identity changes** — these are existing-token recolours, no new colour.
This is the **only** known accent-rule defect, and it is **isolated to the
reference/status decoration**; the product surfaces (00–03) are already compliant
(non-generation actions stay neutral; "Request changes" is neutral).

- **U-6 re-render:** in `ref-primitives.svg`, recolour the Primary 8-state demo
  (lines 30–48) and the "Primary" variant (line 56) **clay → ink** (`#171614` fill,
  `#faf8f5` text; disabled = ink @ 0.42; keep the existing blue focus ring;
  error/success states unchanged). The dedicated "✦ Generate / ✦ Conjuring" spark
  (lines 68–70) and all `@genie` / Conjure / generating elements **stay clay**.
- **U-5 re-render:** in `00-front-door.svg` and `01-ui-kit-browser.svg`, recolour the
  "synced" / "@genie synced" status pill **clay → success-green** — the same green status
  semantic as the existing "✓ validated" badge (`--color-success`; the validated badge
  renders this family as `#2a7a42` text on a neutral chip). All `@genie` / Conjure /
  generating elements **stay clay**.
