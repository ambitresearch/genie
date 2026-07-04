/**
 * Lazy-Playwright renderer for the M3-04 (DRO-260) `validate` full-scan facet.
 *
 * Renders a component preview's raw HTML in headless Chromium and reports two
 * things per render: the rendered content's bounding-box height (AC4's "thin"
 * check) and a decoded RGBA screenshot buffer (AC5's perceptual-hash input,
 * via `validate/phash.ts`). One {@link Renderer} instance owns ONE browser
 * process reused across every file in a scan — launching a fresh browser per
 * file would blow AC7's < 5 s / 50-component budget on launch overhead alone.
 *
 * ── Playwright is an OPTIONAL peer dependency, same precedent as `refine.ts` ──
 * `refine.ts`'s AC7 region-crop already established this pattern for genie:
 * Playwright is not in `dependencies` (a real browser download is too heavy to
 * force on every install), so it is resolved via a runtime, non-literal
 * `import()` that degrades to `null` (never throws) when the package isn't
 * installed. `createDefaultRenderer` here follows the exact same contract —
 * `packages/server/package.json` DOES declare it this time (M3-04's own issue
 * asks for it: "Reuse Playwright instance from M2-04's region cropper"), but
 * the caller (`full-scan.ts`) still must not assume it is always resolvable
 * (a stripped install, an offline `npm ci --omit=optional`-style environment,
 * or a sandboxed CI runner missing the OS-level shared libraries Chromium
 * itself needs — independent of whether the npm package is present).
 *
 * ── Bare-fragment previews render in quirks mode — measure children, not body ──
 * A genie `<Name>.html` preview is a bare fragment: `<!-- @genie … -->`
 * followed directly by markup, with NO `<!DOCTYPE html>`/`<html>`/`<body>`
 * wrapper (confirmed against `validate/marker.test.ts`'s own fixtures and
 * `refine.test.ts`'s component fixtures). Loaded via `page.setContent`, that
 * makes the page quirks-mode, where `document.body` stretches to fill the
 * viewport regardless of content (`document.body.scrollHeight` reports the
 * VIEWPORT height, not the content's real extent — verified empirically).
 * `measureContentHeight` instead unions the bounding boxes of `body`'s direct
 * children (skipping any zero-area element, e.g. a `display:none` node) —
 * this reports the actual rendered content extent independent of quirks-mode
 * body stretching, and needs no synthetic doctype/wrapper injection that
 * could itself perturb the very layout AC4 is trying to measure.
 */

/** One render's measurements: content height (AC4) + a decoded screenshot for
 * perceptual hashing (AC5). */
export interface RenderedCard {
  /** Union bounding-box height, in CSS px, of `document.body`'s direct
   * children — the rendered content's real vertical extent. */
  contentHeight: number;
  /** Decoded RGBA screenshot, ready for `validate/phash.ts`'s `computePHash`. */
  image: { data: Uint8Array; width: number; height: number };
}

/**
 * The render seam `full-scan.ts` depends on (DI, same pattern as `refine.ts`'s
 * `RegionCropper`) — tests inject a stub so no browser is ever launched in the
 * unit suite; production gets {@link createDefaultRenderer}'s real Playwright
 * instance.
 */
export interface Renderer {
  /** Render `html` at `viewport` and return its measurements. */
  render(html: string, viewport: { width: number; height: number }): Promise<RenderedCard>;
  /** Shut down the underlying browser. Idempotent-safe to call once per scan. */
  close(): Promise<void>;
}

// ── Minimal structural Playwright surface ─────────────────────────────────────
//
// Declared locally (mirrors `tools/refine.ts`'s own `PwPage`/`PwBrowser`/
// `PwChromium` structural types) rather than depending on `@playwright/test`'s
// types package: each consumer only needs the handful of methods it actually
// calls, and a structural (not nominal) type means the real `playwright`
// package's richer objects satisfy it without any adapter code.

interface PwPage {
  setContent(html: string, options?: { waitUntil?: string }): Promise<void>;
  // `unknown` result — `full-scan.ts` never calls this directly, only
  // `measureContentHeight` below (with a string script whose return type is
  // known by construction), so a generic passthrough is honest.
  evaluate(script: string): Promise<unknown>;
  screenshot(options?: { type?: string }): Promise<Buffer>;
  close(): Promise<void>;
}
interface PwBrowser {
  newPage(options?: { viewport?: { width: number; height: number } }): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(options?: { args?: string[] }): Promise<PwBrowser>;
}
interface PlaywrightModule {
  chromium: PwChromium;
}

/** Load Playwright at runtime, or `null` if it is not installed / its OS-level
 * dependencies are missing. The non-literal specifier keeps `tsc` from trying
 * to resolve types for it at build time (mirrors `refine.ts`'s
 * `importPlaywright`, kept as a separate copy here rather than a shared
 * export — the two call sites have no other coupling, and duplicating one
 * seven-line try/catch is cheaper than introducing a cross-tool dependency
 * for it). */
async function importPlaywright(): Promise<PlaywrightModule | null> {
  const specifier = "playwright";
  try {
    return (await import(specifier)) as PlaywrightModule;
  } catch {
    return null;
  }
}

/**
 * The script `measureContentHeight` evaluates in-page (AC4). Returns the union
 * bounding-box height of `document.body`'s direct children, skipping any
 * zero-area element (`display:none`, a collapsed empty node, …) — see the
 * module doc for why this measures real content instead of quirks-mode body
 * stretch. A `<Name>.html` with literally no rendered content (a marker line
 * with nothing after it) correctly yields `0`.
 */
const MEASURE_CONTENT_HEIGHT_SCRIPT = `(() => {
  const children = Array.from(document.body.children);
  if (children.length === 0) return 0;
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of children) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!isFinite(top)) return 0;
  return bottom - top;
})()`;

/**
 * Create the default (production) {@link Renderer}: one headless Chromium
 * instance (via lazy Playwright), reused across every `render()` call until
 * `close()`. Returns `null` when Playwright cannot be loaded — the caller
 * (`full-scan.ts`) degrades AC4/AC5 gracefully rather than failing the whole
 * `validate` call over an environment gap (same posture as `refine.ts`'s AC7
 * region crop).
 */
export async function createDefaultRenderer(): Promise<Renderer | null> {
  const pw = await importPlaywright();
  if (!pw) return null;

  let browser: PwBrowser;
  try {
    // `--no-sandbox` so this runs in restricted CI/container environments —
    // the same flag `refine.ts`'s `defaultRegionCropper` launches with.
    browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
  } catch {
    // A Chromium binary that fails to LAUNCH (missing OS-level shared
    // libraries, no downloaded browser, …) is the same "can't render" signal
    // as Playwright not being installed at all — degrade the same way rather
    // than letting a launch failure crash the whole `validate` call.
    return null;
  }

  return {
    async render(html, viewport): Promise<RenderedCard> {
      const page = await browser.newPage({ viewport });
      try {
        // `load`, not `networkidle`: an embedded-CSP preview
        // (`default-src 'none'`) has no network to go idle on — see
        // `refine.ts`'s identical reasoning for its own `setContent` call.
        await page.setContent(html, { waitUntil: "load" });
        const contentHeight = (await page.evaluate(MEASURE_CONTENT_HEIGHT_SCRIPT)) as number;
        const buffer = await page.screenshot({ type: "png" });
        const { PNG } = await import("pngjs");
        const png = PNG.sync.read(buffer);
        return {
          contentHeight,
          image: { data: new Uint8Array(png.data), width: png.width, height: png.height },
        };
      } finally {
        await page.close();
      }
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}
