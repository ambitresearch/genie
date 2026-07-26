/**
 * #247 (2/2) — dedicated computed-style contrast pinning for the M7-02 Browse
 * workbench.
 *
 * ── Why this exists, given `a11y.test.ts` already runs axe-core ──────────────
 * axe-core's `color-contrast` rule audits whatever happens to be *rendered on
 * the page at scan time*. That is a broad net, but it is not a pin: it never
 * names a pair, so it cannot tell you that `.variant-tab.active` specifically
 * is meant to be ink-on-paper-3. A token rename, a cascade reshuffle, or a new
 * rule landing later in the sheet can quietly move one of these pairs and axe
 * will keep passing as long as *some* accessible colour ends up applied — and
 * axe skips elements it considers hidden or ambiguous outright.
 *
 * `docs/designs/design-6/contrast-check.mjs` sits at the other extreme: it
 * static-parses `tokens.css` and pins the token *ledger*, but it never opens a
 * browser, so it cannot see which token a given selector actually resolves to
 * after the cascade runs. Between the two, "`.browse-tree__item` is ink-2 on
 * paper" was assumed, never asserted.
 *
 * This file closes that gap: real Chromium, real `static/` shell, real
 * cascade, `getComputedStyle` — then the same WCAG maths and the same
 * AA_BODY/AA_UI thresholds as `contrast-check.mjs`, applied to the exact
 * selectors #247 names (`.browse-*`, `.variant-tab`, `.btn-clay`) in BOTH
 * colour schemes.
 *
 * ── How colours are read ────────────────────────────────────────────────────
 * Chromium's serialisation of a computed `oklch()` colour is version
 * dependent (`oklch(0.19 …)` vs `oklch(19% …)` vs `rgb(…)` vs `color(srgb …)`)
 * — `a11y.test.ts` already carries a dual-parser to cope with that. Rather
 * than add a third variant of that parser, this file hands the string straight
 * back to the engine via a 1×1 `<canvas>` and reads the painted pixel. That is
 * serialisation-agnostic by construction: whatever Chromium can *render*, it
 * can parse, and the pixel is the ground truth a user's eye receives.
 *
 * Alpha is handled properly rather than assumed away: the effective background
 * is found by walking ancestors until an opaque layer is reached, compositing
 * every translucent layer on the way down, and cumulative ancestor `opacity`
 * is folded into the foreground alpha (this matters for `.variant-tab:disabled`,
 * which is styled with `opacity: 0.6`).
 *
 * ── Gating policy ───────────────────────────────────────────────────────────
 * Thresholds mirror `contrast-check.mjs`: AA_BODY 4.5 for text, AA_UI 3.0 for
 * UI affordances. Pairs on genuinely disabled controls are recorded in the
 * ledger but left ungated (`target: null`) — WCAG 1.4.3 exempts inactive
 * controls, and the existing token ledger already uses `null` the same way for
 * its ink-3-on-paper-2/paper-3 rows.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Server } from "node:http";
import { rm } from "node:fs/promises";

import { buildViewerRoot, serveDir, listen, closeServer } from "./support/viewer-static-harness.js";

// ── Chromium-absent skip ────────────────────────────────────────────────────
// Same contract as `a11y.test.ts`: a machine that has never run
// `npx playwright install` must still get a green `pnpm test`, but the
// dedicated CI job sets GENIE_REQUIRE_A11Y_BROWSER=1 so a misconfigured leg
// fails loudly instead of silently skipping into a vacuous pass.
async function isChromiumAvailable(): Promise<boolean> {
  if (process.env.GENIE_SKIP_A11Y_TESTS === "1") return false;
  try {
    const probe = await chromium.launch();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = await isChromiumAvailable();
if (!chromiumAvailable) {
  console.info(
    "[browse-contrast] no launchable Chromium detected — skipping the computed-style " +
      "contrast pins (run `npx playwright install --with-deps chromium` to run them " +
      "locally; CI's viewer-a11y job runs them for real).",
  );
}
if (!chromiumAvailable && process.env.GENIE_REQUIRE_A11Y_BROWSER === "1") {
  throw new Error(
    "GENIE_REQUIRE_A11Y_BROWSER=1 but Chromium failed to launch — the CI viewer-a11y " +
      "job must have a working browser; these contrast pins are not allowed to " +
      "silently skip on that leg.",
  );
}

// ── WCAG maths (identical formulas to docs/designs/design-6/contrast-check.mjs) ──

/** WCAG 2.x relative luminance from 8-bit sRGB components. */
function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio between two opaque sRGB triples. */
function contrastRatio(
  fg: readonly [number, number, number],
  bg: readonly [number, number, number],
): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const AA_BODY = 4.5;
const AA_UI = 3.0;

// ── The pin ledger ──────────────────────────────────────────────────────────

type PinState = "initial" | "selected" | "no-match";

interface Pin {
  /** Human-readable ledger label, printed on both pass and fail. */
  label: string;
  /** CSS selector, resolved against the live page. Must match ≥1 element. */
  selector: string;
  /** Which Browse state must be driven before reading. */
  state: PinState;
  /** AA_BODY / AA_UI, or `null` to record without gating (disabled controls). */
  target: number | null;
  /** Hover the element before reading (pins `:hover` rules). */
  hover?: boolean;
  /**
   * Temporarily clear BOTH `disabled` and `aria-disabled` to read the
   * control's enabled palette.
   *
   * Both are required: `viewer.css` disables the clay fill twice over —
   * `.btn-clay:disabled` (line ~423) and `.btn-clay[aria-disabled="true"]`
   * (line ~1602) — and `viewer-browse.js` sets both on the standalone Refine
   * button. Clearing only the property leaves the attribute selector matching,
   * which silently re-measures the disabled pair and reports it as the clay
   * identity pair. That is exactly the false positive the first draft of this
   * file shipped, so the toggle is asserted (below) to actually change the
   * resolved colour rather than trusted to work.
   *
   * Mutating the DOM to reach a state is the same technique `hover` uses; the
   * rule under test (`.btn-clay { background: accent; color: on-accent }`) is
   * evaluated by the real cascade in the real page either way. Browse's own
   * instance is only ever disabled because the standalone tier is read-only.
   */
  forceEnabled?: boolean;
  /** Why an ungated row is ungated — required whenever `target` is null. */
  note?: string;
}

const PINS: readonly Pin[] = [
  // ── State: freshly booted Browse, nothing selected ────────────────────────
  {
    label: ".browse-tree__group-label (group heading)",
    selector: "#browse-tree-nav .browse-tree__group-label",
    state: "initial",
    target: AA_BODY,
  },
  {
    label: ".browse-tree__item (resting row)",
    selector: '#browse-tree-nav [role="treeitem"]',
    state: "initial",
    target: AA_BODY,
  },
  {
    label: ".browse-tree__item:hover",
    selector: '#browse-tree-nav [role="treeitem"]',
    state: "initial",
    target: AA_BODY,
    hover: true,
  },
  {
    label: ".browse-detail__placeholder (empty detail pane)",
    selector: "#browse-detail .browse-detail__placeholder",
    state: "initial",
    target: AA_BODY,
  },

  // ── State: a component is selected ────────────────────────────────────────
  {
    label: '.browse-tree__item[aria-selected="true"] (active row)',
    selector: '#browse-tree-nav [role="treeitem"][aria-selected="true"]',
    state: "selected",
    target: AA_BODY,
  },
  {
    label: ".browse-breadcrumb",
    selector: "#browse-detail .browse-breadcrumb",
    state: "selected",
    target: AA_BODY,
  },
  {
    label: ".browse-detail__heading > div (component title)",
    selector: "#browse-detail .browse-detail__heading > div",
    state: "selected",
    target: AA_BODY,
  },
  {
    label: ".browse-metadata dt (metadata key)",
    selector: "#browse-detail .browse-metadata dt",
    state: "selected",
    target: AA_BODY,
  },
  {
    label: ".browse-metadata dd (metadata value)",
    selector: "#browse-detail .browse-metadata dd",
    state: "selected",
    target: AA_BODY,
  },
  {
    label: ".browse-refine-explain (standalone read-only notice)",
    selector: "#browse-detail .browse-refine-explain",
    state: "selected",
    target: AA_BODY,
  },
  {
    label: ".variant-tab.active (selected variant)",
    selector: "#browse-detail .variant-tab.active",
    state: "selected",
    target: AA_BODY,
  },
  {
    label: ".variant-tab:disabled (declared-but-unavailable variant)",
    selector: "#browse-detail .variant-tab:disabled",
    state: "selected",
    target: null,
    note:
      "WCAG 1.4.3 exempts inactive controls; these tabs are genuinely disabled " +
      "(`aria-disabled`) and dimmed with opacity 0.6 by design. Recorded so a " +
      "regression is still visible in the ledger.",
  },
  {
    label: ".btn-clay:disabled (Refine, standalone tier)",
    selector: "#browse-detail .btn-clay",
    state: "selected",
    target: null,
    note:
      "WCAG 1.4.3 exempts inactive controls. Recorded so a regression is still " +
      "visible in the ledger. NOTE: viewer.css layers a translucent hatch " +
      "`background-image` over the disabled fill; this reading resolves " +
      "`background-color` only, so the true value is marginally lighter. That " +
      "approximation is acceptable precisely because the row is ungated — every " +
      "GATED pin below/above resolves to a solid `background` shorthand, which " +
      "resets `background-image` to none.",
  },
  {
    label: ".btn-clay (Refine, ENABLED — clay identity pair)",
    selector: "#browse-detail .btn-clay",
    state: "selected",
    target: AA_BODY,
    forceEnabled: true,
  },

  // ── State: a filter that matches nothing ──────────────────────────────────
  {
    label: ".browse-tree__no-match (empty-result copy)",
    selector: "#browse-tree-nav .browse-tree__no-match",
    state: "no-match",
    target: AA_BODY,
  },
  {
    label: ".browse-tree__no-match [data-clear-filter] (recovery affordance)",
    selector: "#browse-tree-nav .browse-tree__no-match [data-clear-filter]",
    state: "no-match",
    // AA_BODY, not AA_UI. This is a button, but the pair being pinned is its
    // visible "Clear filter" *text*, and the button inherits `--text-sm`
    // (0.875rem = 14px) from `.browse-tree__no-match` without overriding it.
    // 14px is under WCAG's large-text floor (18pt/24px, or 14pt/18.66px bold),
    // so 1.4.3 governs at 4.5:1 — the 3:1 of 1.4.11 applies to non-text
    // component boundaries, not to a label. Gating at AA_UI would let a
    // regression into the 3:1–4.49:1 band pass this dedicated check.
    target: AA_BODY,
  },
];

// ── In-page colour resolution ───────────────────────────────────────────────
// Serialised into the page as one self-contained function: Playwright's
// `evaluate` cannot close over module scope.

interface Reading {
  selector: string;
  fg: [number, number, number];
  bg: [number, number, number];
  fgCss: string;
  bgCss: string;
}

/**
 * Read the effective foreground/background sRGB triples for `selector`,
 * compositing alpha and ancestor `opacity` the way the compositor does.
 */
async function readPair(page: Page, selector: string): Promise<Reading> {
  const reading = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`contrast pin selector matched nothing: ${sel}`);

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");

    // Hand the CSS string back to the engine and read the painted pixel: this
    // is agnostic to how Chromium chose to serialise the computed value.
    // A sentinel detects a value the canvas refused (fillStyle silently keeps
    // its previous value on a parse failure).
    const SENTINEL = "#010203";
    const parse = (css: string): [number, number, number, number] | null => {
      if (!css) return null;
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = css;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
      if (r === 1 && g === 2 && b === 3 && a === 255) {
        // Either the value was rejected, or it really is #010203 — neither is
        // a colour this design system uses, so treat it as a hard failure
        // rather than silently pinning a wrong pair.
        throw new Error(`could not resolve CSS colour: ${css}`);
      }
      return [r, g, b, a / 255];
    };

    const over = (
      top: [number, number, number, number],
      bottom: [number, number, number],
    ): [number, number, number] => [
      Math.round(top[0] * top[3] + bottom[0] * (1 - top[3])),
      Math.round(top[1] * top[3] + bottom[1] * (1 - top[3])),
      Math.round(top[2] * top[3] + bottom[2] * (1 - top[3])),
    ];

    // Walk up collecting translucent layers until an opaque one is found.
    const layers: [number, number, number, number][] = [];
    let node: Element | null = el;
    let opaque: [number, number, number] | null = null;
    let bgCss = "";
    while (node) {
      const parsed = parse(getComputedStyle(node).backgroundColor);
      if (parsed && parsed[3] > 0) {
        if (!bgCss) bgCss = getComputedStyle(node).backgroundColor;
        if (parsed[3] >= 1) {
          opaque = [parsed[0], parsed[1], parsed[2]];
          break;
        }
        layers.push(parsed);
      }
      node = node.parentElement;
    }
    // The canvas below the root element is the browser's default white.
    let bg: [number, number, number] = opaque ?? [255, 255, 255];
    if (!bgCss) bgCss = "(transparent → canvas default)";
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer) bg = over(layer, bg);
    }

    // Cumulative ancestor opacity multiplies into the text's own alpha —
    // `.variant-tab:disabled` relies on exactly this.
    let cumulative = 1;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const o = parseFloat(getComputedStyle(n).opacity);
      if (!Number.isNaN(o)) cumulative *= o;
    }

    const fgCss = getComputedStyle(el).color;
    const fgParsed = parse(fgCss);
    if (!fgParsed) throw new Error(`no computed color for ${sel}`);
    const fg = over([fgParsed[0], fgParsed[1], fgParsed[2], fgParsed[3] * cumulative], bg);

    return { selector: sel, fg, bg, fgCss, bgCss };
  }, selector);
  return reading as Reading;
}

// ── Browser lifecycle ───────────────────────────────────────────────────────

let browser: Browser | undefined;
let root: string;
let server: Server;
let port: number;

beforeAll(async () => {
  if (!chromiumAvailable) return;
  browser = await chromium.launch();
  root = await buildViewerRoot("genie-browse-contrast-");
  server = serveDir(root);
  port = await listen(server);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeServer(server);
  if (root) await rm(root, { recursive: true, force: true });
  // Explicit budget: vitest's default *hook* timeout is 10s, and this teardown
  // closes Chromium, closes the HTTP server, and recursively removes the
  // fixture root. That combination has already blown 10s on a loaded runner,
  // which surfaces as `Error: Hook timed out in 10000ms` and a non-zero exit
  // even when every test passed. 30s matches the sibling E2E suite's teardown.
}, 30_000);

/** Boot Browse in `scheme`, drive it into `state`, and hand back the page. */
async function bootBrowse(
  scheme: "light" | "dark",
): Promise<{ context: BrowserContext; page: Page }> {
  if (!browser) throw new Error("bootBrowse() without a launched browser");
  const context = await browser.newContext({
    colorScheme: scheme,
    // Not cosmetic — REQUIRED for correctness. viewer.css puts a 120ms
    // `background-color` transition on `.btn-clay`/`.btn-ink`/`.btn-neutral`
    // under `prefers-reduced-motion: no-preference`, so a computed style read
    // straight after a state change samples the OLD colour mid-interpolation.
    // The first draft of this file did exactly that and pinned the disabled
    // fill while calling it the enabled clay pair.
    //
    // `reduce` is used rather than an injected `* { transition: none }` sheet
    // because viewer.css already ships `transition: none` for these controls
    // under `prefers-reduced-motion: reduce` — so this measures a real,
    // shipped user configuration instead of a synthetic one. That block
    // touches `transition`/`animation` only; no colour token changes with it.
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?route=browse`);
  // Wait for the real fetch('./.genie/manifest.json') boot path to paint the
  // tree rather than racing the reads against an unpopulated shell.
  await page.waitForSelector('#browse-tree-nav [role="treeitem"]', { timeout: 10_000 });
  return { context, page };
}

async function driveTo(page: Page, state: PinState): Promise<void> {
  const filter = page.locator("#q");
  if (state === "initial") {
    await filter.fill("");
    await page.waitForSelector("#browse-detail .browse-detail__placeholder", { timeout: 5_000 });
    return;
  }
  if (state === "selected") {
    await filter.fill("");
    await page.locator('#browse-tree-nav [role="treeitem"]').first().click();
    await page.waitForSelector("#browse-detail .browse-breadcrumb", { timeout: 5_000 });
    // The variant tabs and metadata paint in the same synchronous render as
    // the breadcrumb, but the source panel lands asynchronously — none of the
    // pinned selectors live in it, so no extra wait is needed.
    return;
  }
  // no-match
  await filter.fill("zzz-no-such-component-zzz");
  await page.waitForSelector("#browse-tree-nav .browse-tree__no-match", { timeout: 5_000 });
}

// ── The pins ────────────────────────────────────────────────────────────────

describe.skipIf(!chromiumAvailable).each(["light", "dark"] as const)(
  "#247 — Browse computed-style contrast pins (%s mode)",
  (scheme) => {
    let context: BrowserContext;
    let page: Page;
    const ledger: string[] = [];

    beforeAll(async () => {
      ({ context, page } = await bootBrowse(scheme));
    }, 60_000);

    afterAll(async () => {
      if (ledger.length) {
        console.info(`\n=== #247 Browse contrast ledger — ${scheme.toUpperCase()} ===`);
        for (const line of ledger) console.info(line);
      }
      await context?.close();
    });

    it(`resolves the expected scheme (${scheme})`, async () => {
      // Guards against a silently-ignored colorScheme: without this, a broken
      // dark leg would just re-measure light mode and pass twice.
      const bodyBg = await readPair(page, "body");
      const luminance = relativeLuminance(bodyBg.bg);
      if (scheme === "dark") expect(luminance).toBeLessThan(0.2);
      else expect(luminance).toBeGreaterThan(0.5);
    });

    for (const pin of PINS) {
      it(`${pin.label} ${pin.target === null ? "[recorded, ungated]" : `≥ ${pin.target}:1`}`, async () => {
        await driveTo(page, pin.state);

        if (pin.hover) await page.locator(pin.selector).first().hover();

        let restored = false;
        let disabledReading: Reading | undefined;
        if (pin.forceEnabled) {
          // Capture the pre-toggle palette so the toggle can be *proved* to
          // have changed something, rather than assumed to have worked.
          disabledReading = await readPair(page, pin.selector);
          // Belt-and-braces on the reducedMotion context option: if a future
          // CSS change drops the `prefers-reduced-motion: reduce` block, the
          // 120ms background-color transition comes back and every reading
          // after a state change silently samples the previous colour.
          const durations = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) throw new Error(`selector matched nothing: ${sel}`);
            return getComputedStyle(el).transitionDuration;
          }, pin.selector);
          expect(
            /^(0s)(,\s*0s)*$/.test(durations),
            `${pin.label}: expected transitions to be disabled before reading a ` +
              `post-state-change colour, but transition-duration is "${durations}". ` +
              `Readings taken mid-interpolation pin the WRONG colour pair and pass.`,
          ).toBe(true);

          restored = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLButtonElement | null;
            if (!el) throw new Error(`forceEnabled selector matched nothing: ${sel}`);
            if (!el.disabled && el.getAttribute("aria-disabled") !== "true") return false;
            el.disabled = false;
            el.removeAttribute("aria-disabled");
            return true;
          }, pin.selector);
          expect(
            restored,
            `${pin.label}: expected the Refine button to ship disabled in the standalone ` +
              `tier so the enabled palette could be forced. It was already enabled, which ` +
              `means this pin is measuring an unknown state — re-check viewer-browse.js.`,
          ).toBe(true);
        }

        let reading: Reading;
        try {
          reading = await readPair(page, pin.selector);
        } finally {
          if (restored) {
            await page.evaluate((sel: string) => {
              const el = document.querySelector(sel) as HTMLButtonElement | null;
              if (el) {
                el.disabled = true;
                el.setAttribute("aria-disabled", "true");
              }
            }, pin.selector);
          }
        }

        const ratio = contrastRatio(reading.fg, reading.bg);

        if (disabledReading) {
          // The bug this catches: `.btn-clay` is disabled twice over in
          // viewer.css (`:disabled` AND `[aria-disabled="true"]`). Clearing
          // only one leaves the disabled palette applied, and the pin passes
          // while measuring entirely the wrong colour pair.
          expect(
            `${reading.fg.join(",")}|${reading.bg.join(",")}`,
            `${pin.label}: forcing the control enabled did not change its resolved colours ` +
              `(still fg ${reading.fgCss} on bg ${reading.bgCss}). Some other disabled ` +
              `selector is still matching, so this pin is measuring the DISABLED palette ` +
              `and silently passing.`,
          ).not.toBe(`${disabledReading.fg.join(",")}|${disabledReading.bg.join(",")}`);
        }

        const verdict = pin.target === null ? "·" : ratio >= pin.target ? "✓" : "✗";
        ledger.push(
          `${ratio.toFixed(2).padStart(6)}:1  ${verdict}  ${pin.label}\n` +
            `            fg ${reading.fgCss} → rgb(${reading.fg.join(", ")})\n` +
            `            bg ${reading.bgCss} → rgb(${reading.bg.join(", ")})`,
        );

        // A pair that resolved to identical fg/bg means the cascade broke, not
        // that contrast is "1.0" — surface that as its own failure.
        expect(
          reading.fg.join(",") === reading.bg.join(","),
          `${pin.label} resolved to identical foreground and background ` +
            `(rgb(${reading.fg.join(", ")})) — the cascade for this selector is broken.`,
        ).toBe(false);

        if (pin.target !== null) {
          expect(
            ratio,
            `${pin.label} in ${scheme} mode: ${ratio.toFixed(2)}:1 ` +
              `(fg ${reading.fgCss}, bg ${reading.bgCss}) is below the ${pin.target}:1 floor. ` +
              `If a token was renamed or the cascade changed, fix the token — do not relax this pin.`,
          ).toBeGreaterThanOrEqual(pin.target);
        } else {
          expect(pin.note, `ungated pin "${pin.label}" must document why`).toBeTruthy();
        }
      }, 30_000);
    }
  },
);
