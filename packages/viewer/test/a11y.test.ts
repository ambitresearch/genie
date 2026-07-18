/**
 * M4-09 (DRO-271) — viewer chrome accessibility audit, real Chromium + axe-core.
 *
 * Scope (per the issue body): "Audit the viewer chrome (the grid wrapper, not
 * the per-card iframes) for WCAG 2.2 AA conformance with axe-core. Component
 * authors own their own preview accessibility; the viewer must not block it."
 * Every `analyze()` call below therefore `.exclude(["iframe"])`s the per-card
 * previews — a hostile or merely-inaccessible component preview must never
 * fail THIS suite; only the grid/header/search chrome is in scope.
 *
 * ── Why a real browser, not jsdom (unlike grid-renderer.test.ts) ───────────
 * `grid-renderer.test.ts` and `static-index.test.ts` unit-test the DOM shape
 * and CSS text `viewer.js`/`viewer.css` produce — fast, but jsdom does not
 * compute layout, contrast, or real focus order. axe-core's contrast checks
 * in particular need genuine rendered pixels (computed `background-color`
 * through `color-mix`/`@layer`/CSS custom properties), which is exactly why
 * the issue names axe-core + AC6 asks for *computed* colours "not a JPEG".
 * So this suite launches real headless Chromium (via `playwright`, already a
 * devDependency for `@axe-core/playwright`) and serves the ACTUAL
 * `packages/viewer/static/*` files over a plain `node:http` server — no Vite,
 * no jsdom, no mocks. `viewer.js` is a classic script (DRO-749): this suite
 * loads it exactly the way a real page does, `<script src="./viewer.js">`,
 * with zero test-hook seam involved.
 *
 * ── Environment note (sandboxed workspace) ──────────────────────────────────
 * This sandbox has no system libglib/libnss/fontconfig install for Chromium
 * to link against, and `pnpm approve-builds` cannot run `apt-get` here. A
 * prior agent (DRO-717) pre-provisioned a private lib root + font cache
 * exactly for this: `LD_LIBRARY_PATH=/tmp/apt-scratch/localroot/usr/lib/
 * x86_64-linux-gnu` (153 .so files, verified to include libglib-2.0,
 * libnss3, libnspr4 etc.) and `FONTCONFIG_FILE=/tmp/fonts.conf` (Liberation
 * TTFs + a writable `/tmp/fontcache`). CI (GitHub Actions `ubuntu-latest`)
 * has a real Chromium dependency closure out of the box and needs neither
 * variable — harmless no-ops there. Local dev on a normal desktop likewise
 * needs neither. This is a sandbox-only workaround, not a new deploy
 * requirement.
 *
 * AC coverage map:
 *   - AC1 — this file; `pnpm --filter @ambitresearch/genie-viewer test:a11y` (package.json
 *           script below) runs it.
 *   - AC2 — zero critical/serious violations, scanned twice (light + dark).
 *   - AC3 — keyboard walk: Tab → search, Tab → card 1 (article, tabindex=0),
 *           Tab → card 2; Enter on a focused card navigates (mirrors the
 *           grid-renderer unit test, but through REAL Tab/Enter key events).
 *   - AC4 — `#q` has an accessible name (aria-label).
 *   - AC5 — every `<iframe>` has a non-empty `title`.
 *   - AC6 — axe-core `color-contrast` (part of the wcag2aa/wcag22aa tag sets
 *           this suite scans with) plus an explicit computed-style spot
 *           check on the two DRO-743-fixed dark-mode tokens.
 *   - AC7 — the same scan + keyboard walk repeated with
 *           `emulateMedia({ colorScheme: "dark" })`.
 *
 * ── AC2's "justification doc per case" — the one allowed `incomplete` ──────
 * axe-core's `color-contrast` check has a THIRD bucket beyond
 * violations/passes: `incomplete` — results it cannot auto-grade and defers
 * to a human. `.wordmark__spark` (the brand glyph, `aria-hidden="true"`)
 * always lands there, in every scheme, regardless of its actual computed
 * color: axe's contrast checker gives up on a `nonBmp` (non-Basic-Multilingual-
 * Plane) glyph because it cannot rasterize a symbol character's shape the way
 * it rasterizes a real word to measure anti-aliased edge pixels — see
 * `node_modules/axe-core`'s `_isIconLigature`/`hasUnicode` (`nonBmp: true`)
 * checks. This is NOT a signal the color is wrong: it is independently
 * verified elsewhere (`static-index.test.ts`'s "identity rule" case computes
 * the real ratio — 4.62:1 light / 5.27:1 dark, both ≥ 4.5:1 AA — using
 * `--color-accent-2`, the design system's own "text-safe clay" per
 * design.md §14's clay-text rule). `assertNoBlockingViolations` below fails
 * on ANY `incomplete` result other than this one exact, pre-approved case —
 * a future incomplete finding on a NEW element must get its own review, not
 * silently ride through under this one's allowance.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFile, mkdtemp, rm, mkdir, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(HERE, "../static");
const FIXTURE_KIT_DIR = resolve(HERE, "fixtures/kit");

// ── Chromium-absent skip (mirrors packages/e2e's isDockerAvailable pattern) ─
// A real browser binary is a genuinely heavier dependency than the rest of
// this repo's fast, no-external-deps unit suite — `pnpm test` (this file's
// default include path via the root vitest.config.ts) must stay green on a
// machine that has never run `npx playwright install`. So this file probes
// once, at collection time, whether Chromium actually launches, and skips the
// whole suite (never fails it) when it does not. CI runs it for real via a
// DEDICATED job (ci.yml `viewer-a11y`) that installs the browser first and
// sets `GENIE_REQUIRE_A11Y_BROWSER=1`, so a misconfigured CI leg fails loudly
// instead of silently skipping — the same "vacuous-skip must fail somewhere"
// contract `GENIE_REQUIRE_DOCKER`/`GENIE_REQUIRE_LLM` already establish for
// the Gitea and M2 legs.
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
    "[a11y] no launchable Chromium detected — skipping the axe-core viewer audit " +
      "(run `npx playwright install --with-deps chromium` to run it locally; " +
      "CI's dedicated viewer-a11y job runs it for real).",
  );
}

if (!chromiumAvailable && process.env.GENIE_REQUIRE_A11Y_BROWSER === "1") {
  throw new Error(
    "GENIE_REQUIRE_A11Y_BROWSER=1 but Chromium failed to launch — the CI viewer-a11y " +
      "job must have a working browser; this is not a suite that is allowed to " +
      "silently skip on that leg.",
  );
}

// ── Tiny static file server ─────────────────────────────────────────────────
// No Vite involved (that's M4-02/M4-10's vehicle, not this one) — this suite
// only needs to serve plain files byte-for-byte, exactly like the `file://`
// tier conceptually does but over http:// so `fetch("./manifest.json")`
// (viewer.js's non-inline path) behaves like a real browser session rather
// than tripping the file:// CORS restriction a *module* script would hit
// (moot here — viewer.js is a classic script either way, DRO-749).

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveDir(root: string): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        let relPath = decodeURIComponent(url.pathname);
        if (relPath === "/") relPath = "/index.html";
        const filePath = join(root, relPath);
        // Minimal traversal guard — this only ever serves fixed fixture
        // content in-process, but there is no reason to skip the check.
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const body = await readFile(filePath);
        res.writeHead(200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    })();
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolvePort(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

// ── Test kit root: the real static/ viewer shell + the M4-02 fixture kit ───
// The viewer's OWN static/{index.html,viewer.js,viewer.css} is the thing
// under audit; the fixture kit (already used by grid-renderer.test.ts /
// static-index.test.ts) supplies a realistic two-group manifest + two real
// preview.html iframes so AC3/AC5's "per card" assertions have more than one
// card to walk.
async function buildAuditRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-viewer-a11y-"));
  // Copy the real shipped shell verbatim — this is the artefact under audit.
  await cp(join(STATIC_DIR, "index.html"), join(dir, "index.html"));
  await cp(join(STATIC_DIR, "viewer.js"), join(dir, "viewer.js"));
  await cp(join(STATIC_DIR, "viewer.css"), join(dir, "viewer.css"));
  // Copy the fixture kit's manifest + component previews alongside it, so
  // `fetch("./.genie/manifest.json")` and each card's iframe `src` resolve.
  await mkdir(join(dir, ".genie"), { recursive: true });
  await cp(join(FIXTURE_KIT_DIR, ".genie/manifest.json"), join(dir, ".genie/manifest.json"));
  await cp(join(FIXTURE_KIT_DIR, "components"), join(dir, "components"), { recursive: true });
  await cp(join(FIXTURE_KIT_DIR, "tokens"), join(dir, "tokens"), { recursive: true });
  return dir;
}

async function buildEmptyRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-viewer-a11y-empty-"));
  await cp(join(STATIC_DIR, "index.html"), join(dir, "index.html"));
  await cp(join(STATIC_DIR, "viewer.js"), join(dir, "viewer.js"));
  await cp(join(STATIC_DIR, "viewer.css"), join(dir, "viewer.css"));
  await mkdir(join(dir, ".genie"), { recursive: true });
  await writeFile(
    join(dir, ".genie/manifest.json"),
    JSON.stringify({
      version: 1,
      name: "empty",
      generatedAt: "2026-07-01T00:00:00.000Z",
      groups: [],
      components: [],
    }),
  );
  return dir;
}

// ── Suite-wide browser (one Chromium instance, fresh context per test) ─────
// Guarded the same way as the describe blocks below: when Chromium can't
// launch, every describe.skipIf(!chromiumAvailable) block is skipped, so
// nothing ever calls newPage() — but this hook is a file-level beforeAll
// (outside any describe), which vitest always runs regardless of sibling
// skips. Without this guard it would re-attempt the same failing launch and
// throw, defeating the whole point of the skip above.

let browser: Browser | undefined;

beforeAll(async () => {
  if (!chromiumAvailable) return;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

/** A fresh, isolated page + context, closed by the caller when done. */
async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
  if (!browser)
    throw new Error(
      "newPage() called without a launched browser — this should be unreachable when chromiumAvailable is false, since every describe block is skipIf-guarded.",
    );
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/**
 * Pre-approved `results.incomplete` findings — axe-core could not auto-grade
 * these, but each has an explicit, documented reason (see the file header's
 * "AC2's justification doc per case" section) they are not a real
 * regression. Keyed by rule id -> selector list, so a NEW incomplete finding
 * on a different element (or a different rule on the same element) still
 * fails loudly rather than silently inheriting this allowance.
 */
const APPROVED_INCOMPLETE: Record<string, string[]> = {
  "color-contrast": [".wordmark__spark"],
};

/**
 * Run an axe-core scan restricted to the WCAG 2.2 AA rule sets (AC2), always
 * excluding `<iframe>` (per-card previews are out of scope — see the file
 * header) and throw with a fully actionable message — rule id, impact, and
 * every offending node's selector/HTML — if any violation is `critical` or
 * `serious`. `minor`/`moderate` findings are intentionally allowed through
 * (the issue's own AC2 wording): they still show up in `results.violations`
 * for a human to read if this is ever run outside the pass/fail assertion.
 *
 * Also inspects `results.incomplete` — axe-core's third bucket for checks it
 * could not auto-resolve (as opposed to checks that ran and failed). Without
 * this, a real gap can hide here indefinitely: `results.violations` alone
 * would have silently missed the wordmark spark's contrast finding (see the
 * file header). Any incomplete result NOT in `APPROVED_INCOMPLETE` fails the
 * suite — new incomplete findings need their own justification, not a free
 * pass because SOME incomplete findings are pre-approved.
 */
async function assertNoBlockingViolations(page: Page, extra?: { rules?: string[] }): Promise<void> {
  let builder = new AxeBuilder({ page }).exclude(["iframe"]);
  builder = extra?.rules
    ? builder.withRules(extra.rules)
    : builder.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
  const results = await builder.analyze();

  const blocking = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  if (blocking.length > 0) {
    const detail = blocking
      .map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help}\n` +
          v.nodes.map((n) => `  - ${n.target.join(" ")}: ${n.html}`).join("\n"),
      )
      .join("\n\n");
    throw new Error(`axe-core found blocking violations:\n\n${detail}`);
  }

  const unapproved = results.incomplete.flatMap((v) => {
    const approvedSelectors = APPROVED_INCOMPLETE[v.id] ?? [];
    const offending = v.nodes.filter((n) => !approvedSelectors.includes(n.target.join(" ")));
    return offending.map((n) => ({ rule: v, node: n }));
  });
  if (unapproved.length > 0) {
    const detail = unapproved
      .map(
        ({ rule, node }) =>
          `${rule.id} (${rule.impact}): ${rule.help}\n  - ${node.target.join(" ")}: ${node.html}`,
      )
      .join("\n\n");
    throw new Error(
      `axe-core found unreviewed "incomplete" results (not in APPROVED_INCOMPLETE — ` +
        `needs its own justification, see AC2):\n\n${detail}`,
    );
  }
}

/**
 * Independently measures the wordmark spark's real WCAG contrast ratio —
 * the actual gate on AC2's "one approved incomplete" (see
 * `APPROVED_INCOMPLETE` above): axe-core structurally cannot grade this
 * element's color (a nonBmp glyph), so this is the test that actually
 * catches a future regression here, computed straight from
 * `getComputedStyle` with no axe-core involvement.
 *
 * Parses BOTH `rgb(a)(...)` and `oklch(...)` computed-style serializations
 * (each with an optional alpha channel) — this Chromium build serializes an
 * oklch()-declared custom property back as `oklch(...)` verbatim rather than
 * converting to legacy rgb() syntax (see the AC7 dark-palette-detection test
 * below for the same two-format handling), so a color-managed
 * getComputedStyle read cannot assume rgb(). Alpha specifically matters for
 * the background walk below: `.app-header`'s background is a semi-
 * transparent `color-mix()`, which serializes with a trailing `/ 0.88` (or
 * `rgba(..., 0.88)`) alpha component that must be composited, not discarded
 * (Copilot review, PR #171 — see the walk's own comment for why).
 */
async function measureSparkContrast(page: Page): Promise<number> {
  return page.evaluate(() => {
    /** [r, g, b] in 0-255 gamma-sRGB, alpha in 0-1 (1 = fully opaque). */
    function parseColor(str: string): [number, number, number, number] {
      if (str === "transparent") return [0, 0, 0, 0];
      const rgbMatch = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(str);
      if (rgbMatch) {
        const [, r, g, b, a] = rgbMatch;
        return [Number(r), Number(g), Number(b), a === undefined ? 1 : Number(a)];
      }
      // oklch(L C H [/ A]) -> OKLab -> linear sRGB -> gamma sRGB, per the CSS
      // Color 4 / Bjorn Ottosson reference matrices (same math as
      // docs/designs/design-6/contrast-check.mjs, inlined here since a
      // browser-evaluated function can't import a repo module).
      const oklchMatch =
        /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/.exec(str);
      if (!oklchMatch) throw new Error("cannot parse color: " + str);
      const [, lRaw, cRaw, hRaw, aRaw] = oklchMatch;
      const L = lRaw.endsWith("%") ? Number(lRaw.slice(0, -1)) / 100 : Number(lRaw);
      const C = Number(cRaw);
      const hRad = (Number(hRaw) * Math.PI) / 180;
      const a = C * Math.cos(hRad);
      const b = C * Math.sin(hRad);
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.291485548 * b;
      const l = l_ ** 3;
      const m = m_ ** 3;
      const s = s_ ** 3;
      const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
      const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
      const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
      const toSrgb = (c: number) => {
        const cc = Math.min(1, Math.max(0, c));
        return cc <= 0.0031308 ? 12.92 * cc : 1.055 * Math.pow(cc, 1 / 2.4) - 0.055;
      };
      const alpha =
        aRaw === undefined ? 1 : aRaw.endsWith("%") ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
      return [toSrgb(rl) * 255, toSrgb(gl) * 255, toSrgb(bl) * 255, alpha];
    }
    function relLuminance([r, g, b]: [number, number, number]): number {
      const chan = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
    }
    /**
     * Porter-Duff "over": composites a (possibly translucent) `layer` onto an
     * already fully-opaque `base`. Used below to flatten a stack of
     * translucent ancestor backgrounds into the one true painted surface
     * color, instead of only reading a single element's own backgroundColor.
     */
    function over(
      layer: [number, number, number, number],
      base: [number, number, number],
    ): [number, number, number] {
      const a = layer[3];
      return [
        layer[0] * a + base[0] * (1 - a),
        layer[1] * a + base[1] * (1 - a),
        layer[2] * a + base[2] * (1 - a),
      ];
    }
    const spark = document.querySelector(".wordmark__spark") as HTMLElement;
    const fg = parseColor(getComputedStyle(spark).color);
    // Walk up collecting every ancestor background that actually paints
    // something (alpha > 0), stopping once a FULLY opaque one is found (the
    // true bottom of the visible stack). `.app-header`'s own background is a
    // semi-transparent color-mix over the body: naively taking the first
    // non-fully-transparent background (as this test originally did) treats
    // that 88%-opacity tint as fully opaque and never looks past it to the
    // real (opaque) body underneath — harmless today only because the tint
    // happens to be the same paper color mixed with itself, so it composites
    // back to exactly that color either way. Collecting the whole translucent
    // stack and alpha-compositing it (below) keeps this correct even if a
    // future header background is a genuinely different tint (Copilot
    // review, PR #171).
    const layers: Array<[number, number, number, number]> = [];
    let bgEl: HTMLElement | null = spark;
    while (bgEl) {
      const parsed = parseColor(getComputedStyle(bgEl).backgroundColor);
      if (parsed[3] > 0) layers.push(parsed);
      if (parsed[3] >= 1) break;
      bgEl = bgEl.parentElement;
    }
    // Composite back-to-front (`layers` was collected front-to-back, i.e.
    // element-to-root, so reverse it first). Falls back to opaque white — the
    // browser's own default canvas — if the walk reached the top of the tree
    // without ever finding a fully opaque background.
    let composited: [number, number, number] = [255, 255, 255];
    for (const layer of layers.reverse()) composited = over(layer, composited);

    const l1 = relLuminance([fg[0], fg[1], fg[2]]);
    const l2 = relLuminance(composited);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  });
}

// ── AC2/AC6 — populated grid, light mode ────────────────────────────────────

describe.skipIf(!chromiumAvailable)(
  "viewer chrome — axe-core scan (populated grid, light mode)",
  () => {
    let root: string;
    let server: Server;
    let port: number;
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      root = await buildAuditRoot();
      server = serveDir(root);
      port = await listen(server);
      ({ context, page } = await newPage());
      await page.goto(`http://127.0.0.1:${port}/`);
      // Wait for the real fetch('./.genie/manifest.json') boot path to finish
      // painting cards, rather than racing axe-core against an empty grid.
      await page.waitForSelector(".ds-card", { timeout: 5_000 });
    }, 30_000);

    afterAll(async () => {
      await context.close();
      await close(server);
      await rm(root, { recursive: true, force: true });
    });

    it("AC2 — zero critical or serious violations against the viewer shell (iframes excluded)", async () => {
      await assertNoBlockingViolations(page);
    });

    it("AC6 — color-contrast rule itself reports zero violations (real rendered pixels)", async () => {
      // A narrower, single-rule scan so a future contrast regression fails with
      // an unambiguous rule id even if the AC2 tag-based scan above is ever
      // loosened.
      await assertNoBlockingViolations(page, { rules: ["color-contrast"] });
    });

    it("AC6 — wordmark spark (axe-core's one approved 'incomplete') independently measures >= 4.5:1", async () => {
      // axe-core can never auto-grade this element (see the file header's
      // "AC2's justification doc per case" — a nonBmp glyph is not
      // shape-gradable), so this test is the actual gate on its color:
      // `measureSparkContrast` computes the WCAG contrast ratio from the REAL
      // rendered `getComputedStyle` color against its real painted
      // background, independent of axe-core entirely.
      const ratio = await measureSparkContrast(page);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it("AC4 — the search input has a real accessible name", async () => {
      const name = await page
        .locator("#q")
        .evaluate((el: Element) => el.getAttribute("aria-label"));
      expect(name).toBe("Filter components by name");
    });

    it("AC5 — every rendered iframe has a non-empty title", async () => {
      const titles = await page
        .locator("iframe")
        .evaluateAll((frames: Element[]) => frames.map((f) => f.getAttribute("title")));
      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) {
        expect(title).toBeTruthy();
        expect(title?.trim()).not.toBe("");
      }
    });

    it("AC3 — Tab order is search -> card 1 -> card 2 (iframes are not stops)", async () => {
      await page.locator("#q").focus();
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("q");

      await page.keyboard.press("Tab");
      const first = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        role: document.activeElement?.getAttribute("role"),
        cls: document.activeElement?.className,
      }));
      expect(first.tag).toBe("ARTICLE");
      expect(first.role).toBe("link");
      expect(first.cls).toContain("ds-card");

      await page.keyboard.press("Tab");
      const second = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        role: document.activeElement?.getAttribute("role"),
      }));
      // The second Tab stop must be the NEXT card, never the first card's own
      // iframe (M4-09 AC3's whole point — see viewer.js's tabindex="-1" note).
      expect(second.tag).toBe("ARTICLE");
      expect(second.role).toBe("link");
    });

    it("AC3 — Enter on a focused card navigates to its preview path", async () => {
      await page.locator("#q").focus();
      await page.keyboard.press("Tab"); // -> first card
      const href = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute("data-name");
      });
      expect(href).toBeTruthy(); // sanity: we really landed on a card

      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => window.location.pathname))
        .toMatch(/preview\.html$/);
    });
  },
);

// ── AC2/AC6 — populated grid, dark mode (AC7 coverage) ──────────────────────

describe.skipIf(!chromiumAvailable)(
  "viewer chrome — axe-core scan (populated grid, dark mode / AC7)",
  () => {
    let root: string;
    let server: Server;
    let port: number;
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      root = await buildAuditRoot();
      server = serveDir(root);
      port = await listen(server);
      ({ context, page } = await newPage());
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector(".ds-card", { timeout: 5_000 });
    }, 30_000);

    afterAll(async () => {
      await context.close();
      await close(server);
      await rm(root, { recursive: true, force: true });
    });

    it("AC7 — the OS-dark palette is actually applied (color-scheme picked up the emulated preference)", async () => {
      // Sanity check that emulateMedia really flipped the page before trusting
      // a clean axe-core run as meaningful: read the computed --color-paper via
      // the *body* background, which should be the dark (~19% L) tone, not the
      // light (~98% L) one.
      //
      // Chromium's getComputedStyle serialization of an oklch()-declared color
      // is version-dependent: older/some builds resolve to `rgb(...)`, but the
      // Chromium this suite launches returns the color functional notation
      // verbatim — `oklch(0.19 0.006 60)` (note: 0-1 range, not `19%`) — since
      // browsers are not required to convert a CSS Color 4 function to legacy
      // rgb() syntax just because the computed-style getter is called. Handle
      // both serializations rather than assume either one.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      const oklchMatch = /oklch\(\s*([\d.]+%?)/.exec(bg);
      if (oklchMatch) {
        const raw = oklchMatch[1] as string;
        // L is either "0.19" (0-1 range) or "19%" (percentage range) depending
        // on serialization; normalize both to a 0-1 lightness before asserting.
        const lightness = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
        expect(lightness).toBeLessThan(0.3);
        return;
      }

      const rgbMatch = /rgb\((\d+), (\d+), (\d+)\)/.exec(bg);
      expect(rgbMatch, `expected an oklch(...) or rgb(...) background, got ${bg}`).not.toBeNull();
      const [, r, g, b] = rgbMatch as RegExpExecArray;
      expect(Number(r)).toBeLessThan(80);
      expect(Number(g)).toBeLessThan(80);
      expect(Number(b)).toBeLessThan(80);
    });

    it("AC2/AC7 — zero critical or serious violations in dark mode (iframes excluded)", async () => {
      await assertNoBlockingViolations(page);
    });

    it("AC6/AC7 (DRO-743) — dark-mode color-contrast rule reports zero violations", async () => {
      // The specific regression DRO-743 fixed (ink-3 3.80:1, clay-text 3.78:1,
      // both < 4.5:1 body-text AA) would surface here as a `color-contrast`
      // violation if it had regressed — this is the axe-core-level guard the
      // DRO-743 issue itself said M4-09 should provide.
      await assertNoBlockingViolations(page, { rules: ["color-contrast"] });
    });

    it("AC6/AC7 — wordmark spark independently measures >= 4.5:1 in dark mode too", async () => {
      // Same rationale as the light-mode case above: axe-core can't grade
      // this element at all, so this is the actual regression gate. Also
      // covers the SECOND latent DRO-743-shaped bug this issue's audit
      // found: `--color-accent-2` (the token this glyph now uses) had a
      // dark-mode override in `docs/designs/design-6/tokens.css` (DRO-743)
      // but NOT in this file's own separate token copy — ported alongside
      // the wordmark-spark fix (see viewer.css's dark-mode comment). Without
      // that port, this specific test would catch it: dark mode would
      // silently fall back to the light value (56% lightness -> 3.78:1,
      // below AA) exactly like the original DRO-743 gap.
      const ratio = await measureSparkContrast(page);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it("AC3 — Tab order still holds in dark mode (search -> card -> card)", async () => {
      await page.locator("#q").focus();
      await page.keyboard.press("Tab");
      const role = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      expect(role).toBe("link");
    });
  },
);

// ── AC6 — empty-state contrast (a real rendered surface with no cards) ─────

describe.skipIf(!chromiumAvailable)("viewer chrome — axe-core scan (empty manifest)", () => {
  let root: string;
  let server: Server;
  let port: number;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    root = await buildEmptyRoot();
    server = serveDir(root);
    port = await listen(server);
    ({ context, page } = await newPage());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector(".ds-empty", { timeout: 5_000 });
  }, 30_000);

  afterAll(async () => {
    await context.close();
    await close(server);
    await rm(root, { recursive: true, force: true });
  });

  it("AC2/AC6 — the empty state itself has zero critical/serious violations", async () => {
    // No cards/iframes exist in this fixture; assertNoBlockingViolations's
    // `.exclude(["iframe"])` is simply a no-op selector match here.
    await assertNoBlockingViolations(page);
  });
});
