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
 *   AC4 — canonical card identity and kit-relative `data-path` agree across ✅
 *         all vehicles. The ui:// tier keeps its data/absolute transport URL
 *         in `path` and preserves the compiler path separately as sourcePath.
 *   AC7 — screenshots of all three vehicles, written to reports/m4-viewer/. ✅
 *   AC8 — the whole suite runs well under 90 s (a soft budget is asserted). ✅
 *
 *   AC5 — HMR is covered through the real Vite server (50-card save → one
 *         iframe load under 100ms) and the assembled ui:// resource (trusted
 *         postMessage installs fresh bytes by stable sourcePath).             ✅
 *
 *   AC6 — vehicle (c) renders the same DOM (covered by the AC4 cross-vehicle
 *         identity assertion) AND the embedded tier's hardened CSP is present
 *         and enforced: `default-src 'none'` + no `unsafe-inline`/`unsafe-eval`,
 *         every card iframe sandboxed to `allow-scripts` only, and a probe
 *         `<script>` injected into a manifest value never executes.          ✅
 *
 * DRO-813 (this follow-up) closed out AC5/AC6 once DRO-266 (M4-04) and
 * DRO-269 (M4-07) merged to `main` — both were deferred at M4-10 (DRO-272)
 * merge time because their dependencies weren't there yet. See history below.
 *
 * ── History ───────────────────────────────────────────────────────────────
 *   DRO-272 (M4-10, PR #176) — landed AC1-4, AC7-8 and the AC5 real-Vite-HMR
 *     + ui:// postMessage assertions (AC5 was already fully covered here);
 *     deferred only the AC6-CSP-enforcement half pending DRO-269, since M4-07
 *     hadn't merged yet and there was no hardened policy to assert against.
 *   DRO-813 — DRO-269 merged; corrected this header's stale "AC5 deferred"
 *     language (AC5 needed no new test code) and added the AC6-CSP
 *     enforcement assertions (hardened meta shape, sandboxed iframes, and a
 *     real unhashed-live-script probe proving the browser actually enforces
 *     the policy) here.
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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileManifest } from "../../server/src/manifest/index.js";
import { buildGridDocument } from "../../server/src/ui/grid-resource.js";
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
  readViewerAsset,
  serveDir,
  startUiVehicle,
  startViteVehicle,
  type CardIdentity,
  type ViewerFixture,
  type ViewerFixtureComponent,
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

  it("vehicle (c) ui:// — preserves legitimate inline card styles and scripts", async () => {
    const ui = await startUiVehicle(fixture);
    const page = await browser.newPage();
    try {
      await gotoAndWaitForGrid(page, ui.url);
      const frame = page.locator("iframe").first().contentFrame();
      await expect
        .poll(() => frame.locator("body").getAttribute("data-preview-ready"))
        .toBe("true");
      await expect
        .poll(() =>
          frame
            .locator("body")
            .evaluate((body) => body.ownerDocument.defaultView?.getComputedStyle(body).display),
        )
        .toBe("grid");
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
    // One raw MCP Apps resource must boot without browser-relative siblings.
    expect(html).toContain("<script>");
    expect(html).toContain("<style>");
  });

  // ── AC6 (CSP half, DRO-813) — the hardened M4-07 policy is really present ──
  it("vehicle (c) ui:// — carries the hardened CSP meta (default-src 'none', no unsafe-inline)", async () => {
    const html = await buildUiGridDocument(fixture);
    const metaMatch = html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/,
    );
    expect(metaMatch).not.toBeNull();
    const policy = metaMatch![1]!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    // The CSP meta must be the first thing inside <head> so it governs every
    // subsequent element (manifest island, inlined viewer.js/css, cards).
    const headIndex = html.indexOf("<head>");
    const metaIndex = html.indexOf(metaMatch![0]);
    expect(metaIndex).toBeGreaterThan(headIndex);
    expect(html.slice(headIndex + "<head>".length, metaIndex).trim()).toBe("");
  });

  it("vehicle (c) ui:// — every card iframe is sandboxed to allow-scripts only", async () => {
    const ui = await startUiVehicle(fixture);
    const page = await browser.newPage();
    try {
      await gotoAndWaitForGrid(page, ui.url);
      const sandboxValues = await page
        .locator("iframe[data-path]")
        .evaluateAll((frames) => frames.map((frame) => frame.getAttribute("sandbox")));
      expect(sandboxValues.length).toBeGreaterThan(0);
      for (const value of sandboxValues) {
        expect(value).toBe("allow-scripts");
      }
    } finally {
      await page.close();
      await ui.close();
    }
  }, 30_000);

  it("vehicle (c) ui:// — the CSP blocks a probe <script> injected into a manifest value", async () => {
    // Two distinct probes, because they exercise two distinct defenses:
    //
    //  1. A hostile component name written into the manifest. The manifest
    //     serializer escapes '<' and viewer.js writes the name through
    //     textContent (never innerHTML), so this NEVER reaches the DOM as
    //     live markup regardless of CSP — it's a serialization/DOM-API
    //     defense, not a CSP one. Kept as a belt-and-suspenders assertion.
    //  2. An UNHASHED, LIVE <script> tag spliced directly into the assembled
    //     document's <body> — bypassing the manifest/textContent path
    //     entirely — to prove the shipped `default-src 'none'` (no
    //     'unsafe-inline', no script-src allowance for arbitrary inline
    //     script) is what actually stops it from running in a real browser.
    //     A real CSP violation must fire and the probe's side effect must
    //     never land; this is the assertion Copilot's review (PR #182)
    //     flagged as missing.
    const probeName = '<script>window.__genieProbeFired=1</script>';
    const probeFixture = await createViewerFixture([
      { group: "actions", name: "Button", viewport: "320x180" },
    ]);
    try {
      // Recompile with a hostile name injected straight into the manifest
      // object (bypassing the on-disk marker, which would reject '<' via the
      // filename contract) to simulate a manifest value carrying markup.
      probeFixture.manifest.components[0]!.name = probeName;
      const html = await buildGridDocument(
        {
          kitsRoot: probeFixture.kitsRoot,
          compile: async () => probeFixture.manifest,
          readAsset: (name) => readViewerAsset(name),
          readPreviewBytes: async (kitDir, relPath) => {
            try {
              return await readFile(join(kitDir, relPath));
            } catch {
              return null;
            }
          },
          previewsBaseUrl: undefined,
        },
        { kitId: probeFixture.kitId },
      );

      // The policy still forbids unhashed inline script/unsafe-inline.
      const metaMatch = html.match(
        /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/,
      );
      expect(metaMatch).not.toBeNull();
      expect(metaMatch![1]).not.toContain("'unsafe-inline'");

      // Splice an UNHASHED live <script> straight into <body> — the actual
      // enforcement probe. If a future regression ever weakened the policy
      // (e.g. added 'unsafe-inline' or a permissive script-src), this script
      // WOULD execute and this assertion would catch it; today it must be
      // blocked by the browser's CSP engine, not by escaping or textContent.
      const bodyClose = html.lastIndexOf("</body>");
      expect(bodyClose).toBeGreaterThan(-1);
      const livewireProbe =
        '<script>window.__genieLiveProbeFired=1</script>';
      const htmlWithLiveProbe =
        html.slice(0, bodyClose) + livewireProbe + html.slice(bodyClose);

      const root = await mkdtemp(join(probeFixture.kitsRoot, "csp-probe-"));
      await writeFile(join(root, "index.html"), htmlWithLiveProbe, "utf8");
      const { server, url } = await serveDir(root);
      const page = await browser.newPage();
      const cspViolations: string[] = [];
      page.on("console", (msg) => {
        if (msg.text().toLowerCase().includes("content security policy")) {
          cspViolations.push(msg.text());
        }
      });
      let dialogFired = false;
      page.on("dialog", (dialog) => {
        dialogFired = true;
        void dialog.dismiss();
      });
      try {
        await gotoAndWaitForGrid(page, url);
        // The manifest-value probe never executes: no dialog, no global
        // side-channel write.
        expect(dialogFired).toBe(false);
        const probeRan = await page.evaluate(
          () => (globalThis as Record<string, unknown>).__genieProbeFired,
        );
        expect(probeRan).toBeUndefined();
        // The literal probe text must never appear as live DOM markup (only,
        // if at all, as inert text via textContent).
        const cardHtml = await page.locator(".ds-card").first().evaluate((el) => el.innerHTML);
        expect(cardHtml).not.toContain("<script>window.__genieProbeFired");

        // The REAL enforcement assertion: the unhashed live <script> spliced
        // into <body> must be blocked by the document's CSP — the browser
        // must report a real CSP violation, and its side effect must never
        // land, even though it is syntactically a live, executable script
        // (not escaped, not routed through textContent).
        expect(cspViolations.length).toBeGreaterThan(0);
        const liveProbeRan = await page.evaluate(
          () => (globalThis as Record<string, unknown>).__genieLiveProbeFired,
        );
        expect(liveProbeRan).toBeUndefined();
      } finally {
        await page.close();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    } finally {
      await probeFixture.cleanup();
    }
  }, 30_000);

  it("vehicle (c) ui:// — refreshes a data-backed card by stable source path with fresh bytes", async () => {
    const ui = await startUiVehicle(fixture);
    const page = await browser.newPage();
    try {
      await gotoAndWaitForGrid(page, ui.url);
      const sourcePath = fixture.manifest.components[0]!.path;
      const iframe = page.locator(`iframe[data-path="${sourcePath}"]`);
      const initialSrc = await iframe.getAttribute("src");
      expect(initialSrc).toMatch(/^data:text\/html;base64,/);

      const freshSrc =
        "data:text/html;base64," +
        Buffer.from("<!doctype html><body>embedded refresh v2</body>", "utf8").toString("base64");
      await page.evaluate(
        ({ path, src }) => {
          const browserWindow = globalThis as unknown as {
            location: { origin: string };
            postMessage: (message: unknown, targetOrigin: string) => void;
          };
          browserWindow.postMessage({ type: "refresh", path, src }, browserWindow.location.origin);
        },
        { path: sourcePath, src: freshSrc },
      );

      await expect.poll(() => iframe.getAttribute("src")).toBe(freshSrc);
      await expect
        .poll(() => iframe.contentFrame().locator("body").textContent())
        .toContain("embedded refresh v2");
    } finally {
      await page.close();
      await ui.close();
    }
  });

  it("AC3 — one save reloads exactly one of 50 cards through iframe load in under 100ms", async () => {
    const components: ViewerFixtureComponent[] = Array.from({ length: 50 }, (_, index) => ({
      group: "bench",
      name: `Card${String(index).padStart(2, "0")}`,
      viewport: "320x180",
    }));
    const bench = await createViewerFixture(components);
    const vite = await startViteVehicle(bench.kitDir);
    const page = await browser.newPage();
    const targetPath = "components/bench/Card00/Card00.html";
    const loads = new Map<string, number>();
    let timingStarted = false;
    let resolveTargetLoad: ((endedAt: number) => void) | undefined;
    const targetLoad = new Promise<number>((resolveLoad) => {
      resolveTargetLoad = resolveLoad;
    });

    try {
      await gotoAndWaitForGrid(page, vite.url);
      await expect.poll(() => page.locator("iframe").count()).toBe(50);

      await page.exposeFunction("__genieRecordCardLoad", (path: string) => {
        const count = (loads.get(path) ?? 0) + 1;
        loads.set(path, count);
        if (timingStarted && path === targetPath && count === 1) {
          resolveTargetLoad?.(performance.now());
        }
      });
      await page.locator("iframe[data-path]").evaluateAll((frames) => {
        const browserGlobal = globalThis as unknown as {
          __genieRecordCardLoad?: (path: string) => Promise<void>;
        };
        for (const frame of frames) {
          const iframe = frame;
          iframe.addEventListener("load", () => {
            void browserGlobal.__genieRecordCardLoad?.(iframe.getAttribute("data-path") ?? "");
          });
          iframe.setAttribute("loading", "eager");
          iframe.setAttribute("src", iframe.getAttribute("src") ?? "");
        }
      });
      await expect.poll(() => loads.size).toBe(50);

      let previousTotal = -1;
      let stableSamples = 0;
      for (let sample = 0; sample < 20 && stableSamples < 5; sample++) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        const total = [...loads.values()].reduce((sum, count) => sum + count, 0);
        stableSamples = total === previousTotal ? stableSamples + 1 : 0;
        previousTotal = total;
      }
      expect(stableSamples).toBeGreaterThanOrEqual(5);
      loads.clear();

      const servedTarget = await fetch(new URL(targetPath, vite.url)).then((response) =>
        response.text(),
      );
      expect(servedTarget).not.toContain("/@vite/client");

      timingStarted = true;
      const startedAt = performance.now();
      await writeFile(
        join(bench.kitDir, targetPath),
        '<!-- @genie group="bench" viewport="320x180" name="Card00" -->\n' +
          "<!doctype html><body>Card00 revision 2</body>\n",
        "utf8",
      );
      const endedAt = await Promise.race([
        targetLoad,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("target iframe did not reload")), 5000),
        ),
      ]);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));

      expect(endedAt - startedAt).toBeLessThan(100);
      expect(loads.get(targetPath)).toBe(1);
      expect(
        [...loads.entries()]
          .filter(([path]) => path !== targetPath)
          .reduce((sum, [, count]) => sum + count, 0),
      ).toBe(0);
    } finally {
      await page.close();
      await vite.close();
      await bench.cleanup();
    }
  }, 30_000);

  it("preview manifest recompilation removes a deleted card from an already-open grid", async () => {
    const structural = await createViewerFixture([
      { group: "actions", name: "Button", viewport: "320x180" },
      { group: "surfaces", name: "Card", viewport: "320x180" },
    ]);
    const vite = await startViteVehicle(structural.kitDir);
    const page = await browser.newPage();
    const deletedPath = "components/surfaces/Card/Card.html";

    try {
      await gotoAndWaitForGrid(page, vite.url);
      await expect.poll(() => page.locator("iframe").count()).toBe(2);

      await rm(join(structural.kitDir, deletedPath));
      await compileManifest(structural.kitDir);

      await expect.poll(() => page.locator("iframe").count(), { timeout: 5_000 }).toBe(1);
      expect(await page.locator(`iframe[data-path="${deletedPath}"]`).count()).toBe(0);
    } finally {
      await page.close();
      await vite.close();
      await structural.cleanup();
    }
  }, 30_000);

  // ── The M4 gate: all three vehicles agree, card-for-card ───────────────────
  it("AC4 (G-5) — the three vehicles render byte-identical card identities", async () => {
    const fileVehicle = await buildFileVehicle(fixture);
    const vite = await startViteVehicle(fixture.kitDir);
    const ui = await startUiVehicle(fixture);

    const page = await browser.newPage();
    try {
      await gotoAndWaitForGrid(page, fileVehicle.url);
      const fileIds = await readCardIdentities(page);
      const filePaths = await readCardPaths(page);

      await gotoAndWaitForGrid(page, vite.url);
      const localhostIds = await readCardIdentities(page);
      const localhostPaths = await readCardPaths(page);

      await gotoAndWaitForGrid(page, ui.url);
      const uiIds = await readCardIdentities(page);
      const uiPaths = await readCardPaths(page);

      // All three equal each other AND the shared manifest — the G-5 assertion.
      expect(fileIds).toEqual(expected);
      expect(localhostIds).toEqual(expected);
      expect(uiIds).toEqual(expected);
      // Cross-vehicle equality stated directly (not just transitively via
      // `expected`) so a failure names which pair diverged.
      expect(localhostIds).toEqual(fileIds);
      expect(uiIds).toEqual(fileIds);
      const expectedPaths = fixture.manifest.components.map((component) => component.path).sort();
      expect(filePaths).toEqual(expectedPaths);
      expect(localhostPaths).toEqual(expectedPaths);
      expect(uiPaths).toEqual(expectedPaths);
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

/** Read the stable kit-relative path used by HMR, never the transport URL. */
async function readCardPaths(page: Page): Promise<string[]> {
  return page
    .locator("iframe[data-path]")
    .evaluateAll((frames) => frames.map((frame) => frame.getAttribute("data-path") ?? "").sort());
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
