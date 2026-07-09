/**
 * M4-10 (DRO-272) — viewer end-to-end test: Playwright vs Vite vs `ui://`.
 *
 * The M4 acceptance gate. Exercises the THREE delivery vehicles for one kit's
 * artefacts and asserts they render the same cards (RFC G-5, AGENTS.md hard
 * rule 5 — "byte-identical across file:// / localhost / ui://"):
 *
 *   (a) `file://<root>/index.html`  — a raw file open (inline-manifest transport)
 *   (b) `http://127.0.0.1:<port>`   — the real `@genie/viewer` Vite dev server
 *   (c) `ui://genie/grid`           — the embedded MCP-Apps document, built by
 *                                     the server's own `buildGridDocument` and
 *                                     rendered headless
 *
 * All three derive their cards from ONE `compileManifest` run over one on-disk
 * fixture kit (see `support/viewer-fixture.ts`), so this proves the three RENDER
 * paths agree — not that three hand-authored manifests happen to match.
 *
 * ── AC coverage (this milestone) ─────────────────────────────────────────────
 *   AC1 — this file, `packages/e2e/test/m4-viewer.test.ts`.               ✅
 *   AC2 — Playwright Chromium (headless in CI; `--headed` locally).       ✅
 *   AC3 — a 12-component fixture kit; 12 cards visible in all 3 vehicles. ✅
 *   AC4 — the same canonical card identity across vehicles. The issue     ✅
 *         sketch says `data-path`, but the shipped viewer.js emits no
 *         `data-path`, the compiler derives `name` from the FILENAME, and
 *         the ui:// tier rewrites each `path` to a `data:` URL — so `path`
 *         is per-vehicle transport, NOT the invariant. The real G-5
 *         invariant is the rendered `(group, name, viewport)` triple the
 *         viewer paints into each card; this suite asserts THAT is identical
 *         across all three. (Deviation documented in the PR / issue.)
 *   AC7 — screenshots of all three vehicles, written to reports/m4-viewer/. ✅
 *   AC8 — the whole suite runs well under 90 s (a soft budget is asserted). ✅
 *
 * ── Deferred to a tracked follow-up (dependencies not yet merged) ────────────
 *   AC5 — HMR per-card refresh via postMessage: DRO-266 (M4-04) is still
 *         `in_progress` (not merged to main). The postMessage bridge it adds
 *         does not exist in viewer.js yet, so an HMR assertion here would test
 *         nothing. Tracked as a follow-up to layer in once DRO-266 lands.
 *   AC6-CSP — the embedded tier's `default-src 'none'` + iframe `sandbox`
 *         ENFORCEMENT check depends on DRO-269 (M4-07, dispatched as DRO-796),
 *         also unmerged. AC6's core — "vehicle (c) renders the same DOM" — IS
 *         covered here (the ui:// vehicle is a first-class part of the identity
 *         assertion); only the CSP-header enforcement assertion is deferred.
 *
 * The dispatch (DRO-797) explicitly authorises this split: "land the grid +
 * byte-identity coverage first and note the HMR/CSP cases as a tracked
 * follow-up rather than blocking the whole suite."
 *
 * ── Sandboxed-workspace note (same as a11y.test.ts) ──────────────────────────
 * Chromium needs a lib closure + fonts this authoring sandbox provides via
 * `LD_LIBRARY_PATH=/tmp/apt-scratch/localroot/usr/lib/x86_64-linux-gnu` +
 * `FONTCONFIG_FILE=/tmp/fonts.conf` (DRO-717). CI (`ubuntu-latest`) apt-gets the
 * real closure via `playwright install --with-deps` and needs neither. When no
 * Chromium launches, the suite SKIPS (never fails) — `pnpm test` on a browser-
 * less machine stays green; CI's dedicated `viewer-e2e` job sets
 * `GENIE_REQUIRE_VIEWER_E2E=1` so a broken install there fails loudly instead.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildFileVehicle,
  buildUiGridDocument,
  createViewerFixture,
  expectedIdentities,
  FIXTURE_COMPONENTS,
  identityKey,
  isChromiumAvailable,
  launchBrowser,
  readCardIdentities,
  startUiVehicle,
  startViteVehicle,
  type CardIdentity,
  type ViewerFixture,
} from "./support/viewer-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, "../../../reports/m4-viewer");

// ── Chromium-absent skip (same contract as a11y.test.ts) ────────────────────
const chromiumAvailable = await isChromiumAvailable();
if (!chromiumAvailable) {
  console.info(
    "[m4-viewer] no launchable Chromium — skipping the viewer E2E gate " +
      "(run `npx playwright install --with-deps chromium` to run it locally; " +
      "CI's dedicated viewer-e2e job runs it for real).",
  );
}
if (!chromiumAvailable && process.env.GENIE_REQUIRE_VIEWER_E2E === "1") {
  throw new Error(
    "GENIE_REQUIRE_VIEWER_E2E=1 but Chromium failed to launch — the CI viewer-e2e " +
      "job must have a working browser; this suite is not allowed to silently skip there.",
  );
}

const EXPECTED_CARD_COUNT = FIXTURE_COMPONENTS.length; // 12 (AC3)

describe.skipIf(!chromiumAvailable)("M4-10 viewer E2E — three vehicles (DRO-272)", () => {
  let fixture: ViewerFixture;
  let browser: Browser;
  let expected: CardIdentity[];
  const suiteStart = performanceNow();

  beforeAll(async () => {
    fixture = await createViewerFixture();
    browser = await launchBrowser();
    expected = expectedIdentities(fixture.manifest);
    await mkdir(REPORT_DIR, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await fixture?.cleanup();
  });

  // ── Sanity: the shared manifest itself carries the 12 expected cards ───────
  it("the fixture kit compiles to a 12-component manifest (AC3 precondition)", () => {
    expect(fixture.manifest.components).toHaveLength(EXPECTED_CARD_COUNT);
    expect(expected).toHaveLength(EXPECTED_CARD_COUNT);
    // Every fixture component's (group, name, viewport) is present exactly once.
    const expectedFromFixture = FIXTURE_COMPONENTS.map((c) => identityKey(c)).sort();
    expect(expected.map(identityKey)).toEqual(expectedFromFixture);
  });

  // ── Vehicle (a): file:// ───────────────────────────────────────────────────
  it("vehicle (a) file:// — renders all 12 cards with the canonical identities", async () => {
    const { url } = await buildFileVehicle(fixture);
    const page = await browser.newPage();
    try {
      await gotoAndWaitForGrid(page, url);
      const ids = await readCardIdentities(page);
      expect(ids).toHaveLength(EXPECTED_CARD_COUNT);
      expect(ids).toEqual(expected);
      await screenshot(page, "vehicle-a-file.png");
    } finally {
      await page.close();
    }
  }, 30_000);

  // ── Vehicle (b): localhost (real Vite dev server) ──────────────────────────
  it("vehicle (b) localhost — the real Vite dev server renders all 12 cards", async () => {
    const vite = await startViteVehicle(fixture.kitDir);
    const page = await browser.newPage();
    try {
      await gotoAndWaitForGrid(page, vite.url);
      const ids = await readCardIdentities(page);
      expect(ids).toHaveLength(EXPECTED_CARD_COUNT);
      expect(ids).toEqual(expected);
      await screenshot(page, "vehicle-b-localhost.png");
    } finally {
      await page.close();
      await vite.close();
    }
  }, 30_000);

  // ── Vehicle (c): ui://genie/grid (embedded MCP-Apps document) ──────────────
  it("vehicle (c) ui:// — the embedded grid document renders all 12 cards", async () => {
    const ui = await startUiVehicle(fixture);
    const page = await browser.newPage();
    try {
      await gotoAndWaitForGrid(page, ui.url);
      const ids = await readCardIdentities(page);
      expect(ids).toHaveLength(EXPECTED_CARD_COUNT);
      expect(ids).toEqual(expected);
      await screenshot(page, "vehicle-c-ui.png");
    } finally {
      await page.close();
      await ui.close();
    }
  }, 30_000);

  // ── The embedded doc carries its manifest INLINE (AC2 transport check) ─────
  it("vehicle (c) ui:// — the document inlines the manifest (no fetch transport)", async () => {
    const html = await buildUiGridDocument(fixture);
    // The embedded tier's CSP is connect-src 'none': the manifest must travel
    // inside the document as the id="manifest" JSON island, never fetched.
    expect(html).toContain('id="manifest"');
    expect(html).toContain('type="application/json"');
    // And the shell keeps its relative sibling-asset refs (grid-resource AC3).
    expect(html).toContain('src="./viewer.js"');
  });

  // ── The M4 gate: all three vehicles agree, card-for-card ───────────────────
  it("AC4 (G-5) — the three vehicles render byte-identical card identities", async () => {
    const fileVehicle = await buildFileVehicle(fixture);
    const vite = await startViteVehicle(fixture.kitDir);
    const ui = await startUiVehicle(fixture);

    const page = await browser.newPage();
    try {
      await gotoAndWaitForGrid(page, fileVehicle.url);
      const fileIds = await readCardIdentities(page);

      await gotoAndWaitForGrid(page, vite.url);
      const localhostIds = await readCardIdentities(page);

      await gotoAndWaitForGrid(page, ui.url);
      const uiIds = await readCardIdentities(page);

      // All three equal each other AND the shared manifest — the G-5 assertion.
      expect(fileIds).toEqual(expected);
      expect(localhostIds).toEqual(expected);
      expect(uiIds).toEqual(expected);
      // Cross-vehicle equality stated directly (not just transitively via
      // `expected`) so a failure names which pair diverged.
      expect(localhostIds).toEqual(fileIds);
      expect(uiIds).toEqual(fileIds);
    } finally {
      await page.close();
      await vite.close();
      await ui.close();
    }
  }, 45_000);

  // ── AC8 — the whole gate stays well under the 90 s budget ──────────────────
  it("AC8 — the suite completes well under 90 s", () => {
    const elapsedMs = performanceNow() - suiteStart;
    // A generous ceiling: the real run is single-digit seconds, but CI cold
    // starts (browser launch, Vite boot) vary. 90 s is the AC's hard limit;
    // asserting 80 s leaves headroom while still catching a runaway regression.
    expect(elapsedMs).toBeLessThan(80_000);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Navigate and wait for the grid to paint at least one card (attached DOM). */
async function gotoAndWaitForGrid(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector(".ds-card", { state: "attached", timeout: 10_000 });
}

/** Write a full-page screenshot into the report dir (AC7). */
async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(REPORT_DIR, name), fullPage: true });
}

/**
 * `performance.now()` without importing `node:perf_hooks` at module scope in a
 * way that trips the workflow's Date.now ban — this is a normal test file, so a
 * direct `performance.now()` is fine; wrapped only to keep the call site tidy.
 */
function performanceNow(): number {
  return performance.now();
}
