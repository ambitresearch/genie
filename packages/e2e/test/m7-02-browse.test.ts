/**
 * M7-02 follow-up (#247) — Browse workbench END-TO-END coverage.
 *
 * ## Why this file exists
 *
 * The Browse workbench (#234 / PR #248) shipped with ~1550 lines of jsdom unit
 * coverage in `packages/viewer/test/browse-workbench.test.ts`. jsdom proves the
 * render functions emit the right DOM for a given manifest object — it cannot
 * prove any of the things that only exist once a real server, a real browser and
 * a real MCP host are in the loop:
 *
 *   - jsdom never boots the viewer. It calls `initBrowse` directly with a
 *     hand-built manifest, so `?route=browse` → `[data-route-view]` → the real
 *     `fetch('.genie/manifest.json')` boot path is untested end to end.
 *   - jsdom has no `initHmr` poll loop, so "a component vanished from the kit
 *     WHILE the user had it open" is only ever simulated by calling `update()`
 *     by hand — never by actually deleting the file and recompiling.
 *   - jsdom stubs `hostBridge.callTool`. The source panel's
 *     `mcp__genie__read_file` round trip has therefore never crossed a real
 *     postMessage bridge to a real MCP host talking to the real shipped server.
 *
 * This suite closes those three gaps against real infrastructure.
 *
 * ## AC coverage (#247, item 1)
 *
 *   AC1 — tree navigation against a REAL booted server (vehicle b, Vite):
 *         groups + items paint from the fetched manifest, click/keyboard select,
 *         detail panel + preview iframe follow, the roving tabindex holds, the
 *         filter narrows and clears, and a selection survives a full reload via
 *         its URL params.                                → tests 2-6
 *   AC2 — an HMR-triggered component removal MID-SESSION: delete the open
 *         component's file, recompile, and let the real 2 s `initHmr` poll drive
 *         it — the row disappears AND the detail panel flips to its "no longer
 *         available" state with focus parked somewhere live.
 *                                                        → test 7
 *   AC3 — a REAL MCP-host round trip for the source panel: the embedded
 *         `ui://genie/grid` resource inside an iframe, parented by a page that
 *         speaks the MCP-Apps host protocol and proxies `tools/call` to a
 *         genuine `createServer()` over a genuine `Client`/`InMemoryTransport`.
 *         The `<pre>` must hold the ACTUAL bytes on disk.  → tests 8-9
 *
 * ## Why a separate file from `m4-viewer.test.ts`
 *
 * `m4-viewer.test.ts` closes with an AC8 assertion that the WHOLE suite ran in
 * under 90 s. Folding three more browser-driving legs (one of which deliberately
 * waits out a 2 s poll loop) into that file would make an unrelated timing gate
 * flaky. They run as a separate CI step for the same reason.
 *
 * ── History ──
 * - #247 (this file) — created; deferred out of #234 / PR #248's scope.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Frame, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileManifest } from "../../server/src/manifest/index.js";
import {
  FIXTURE_COMPONENTS,
  FIXTURE_KIT_ID,
  createViewerFixture,
  isChromiumAvailable,
  launchBrowser,
  startMcpHostVehicle,
  startViteVehicle,
  type McpHostVehicle,
  type ViewerFixture,
} from "./support/viewer-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, "../../../reports/m7-02-browse");

// ── Chromium-absent skip (same contract as m4-viewer.test.ts) ────────────────
const chromiumAvailable = await isChromiumAvailable();
if (!chromiumAvailable) {
  console.info(
    "[m7-02-browse] no launchable Chromium — skipping the Browse E2E gate " +
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

/**
 * This package's tsconfig is deliberately DOM-free (`lib: ["ES2022"]`,
 * `types: ["node"]`) because the tests themselves run in Node — only the
 * callbacks handed to `page.evaluate` execute in the browser. Rather than pull
 * the whole DOM lib into a Node-only test package, browser globals are reached
 * through a structurally-typed `globalThis` cast, matching the house pattern in
 * `m4-viewer.test.ts`. The type is erased at compile time, so the cast costs
 * nothing at runtime and the callback still serialises cleanly to the page.
 */
interface BrowserGlobals {
  document: {
    activeElement: {
      id?: string;
      isConnected?: boolean;
      textContent?: string | null;
      getAttribute(name: string): string | null;
    } | null;
  };
  __genieHostLog?: string[];
}

/** The fixture's groups, and how many components each holds (4 apiece). */
const EXPECTED_GROUPS = ["actions", "forms", "surfaces"] as const;
const EXPECTED_COMPONENT_COUNT = FIXTURE_COMPONENTS.length; // 12

/**
 * `noUncheckedIndexedAccess` is on, so an index/`find` lookup is
 * `Component | undefined`. Fail loudly at module load with a diagnostic naming
 * the fixture rather than sprinkling `!` and letting a fixture edit surface
 * later as an opaque "cannot read property of undefined" mid-test.
 */
function requireFixtureComponent(
  label: string,
  predicate: (candidate: (typeof FIXTURE_COMPONENTS)[number]) => boolean,
): (typeof FIXTURE_COMPONENTS)[number] {
  const component = FIXTURE_COMPONENTS.find(predicate);
  if (!component) {
    throw new Error(
      `m7-02-browse: no fixture component satisfies "${label}". FIXTURE_COMPONENTS ` +
        `in packages/e2e/test/support/viewer-fixture.ts has changed shape — update this suite.`,
    );
  }
  return component;
}

/** The component every single-target assertion drives (stable, first in the tree). */
const TARGET = requireFixtureComponent("first fixture component", () => true);
/**
 * A component whose name is not a substring of any other fixture component.
 * The filter matches on substring, so `TARGET` ("Button") legitimately keeps
 * "IconButton" and "SplitButton" too — derive an unambiguous one rather than
 * hard-coding a name that a later fixture edit could quietly make ambiguous.
 */
const UNIQUE_TARGET = requireFixtureComponent(
  "a name that is not a substring of any other component",
  (candidate) =>
    !FIXTURE_COMPONENTS.some(
      (other) => other.name !== candidate.name && other.name.includes(candidate.name),
    ),
);

describe.skipIf(!chromiumAvailable)("M7-02 Browse workbench E2E (#247)", () => {
  let fixture: ViewerFixture;
  let browser: Browser;

  beforeAll(async () => {
    fixture = await createViewerFixture();
    browser = await launchBrowser();
    await mkdir(REPORT_DIR, { recursive: true });
  }, 60_000);

  // Vitest's DEFAULT hook budget is 10s, which is not enough for this teardown
  // on a loaded machine: closing Chromium and rm -rf'ing the fixture kit are
  // both I/O bound, and a hook timeout here fails the whole FILE even when
  // every test passed. Observed exactly that at load average ~258. The sibling
  // suites (m4-viewer, a11y) leave this hook unqualified and inherit the 10s
  // default; that is a latent flake in them, not a deliberate choice.
  afterAll(async () => {
    await browser?.close();
    await fixture?.cleanup();
  }, 30_000);

  // ── A precondition the rest of the suite leans on ─────────────────────────

  it("the fixture manifest names the on-disk kit (the id Browse hands to read_file)", () => {
    // Both boot tiers pass `kitId: manifest.name` into `initBrowse`, and the
    // source panel forwards THAT to `mcp__genie__read_file`. If the compiler
    // ever stopped deriving `name` from the kit directory, AC3's round trip
    // would fail deep inside the store as an opaque NotFound — so pin it here,
    // where the failure names the actual cause.
    expect(fixture.manifest.name).toBe(FIXTURE_KIT_ID);
    expect(fixture.manifest.components).toHaveLength(EXPECTED_COMPONENT_COUNT);
  });

  // ── AC1 — tree navigation against a real booted server ────────────────────

  it("AC1 — ?route=browse boots the workbench and paints every group and component", async () => {
    const vite = await startViteVehicle(fixture.kitDir);
    const page = await browser.newPage();
    try {
      const view = await gotoBrowse(page, vite.url);

      // The tree is built from the FETCHED manifest, nothing inlined. The ARIA
      // tree lives on the controller-built inner node, not the static <nav>.
      expect(await view.locator('[role="treeitem"]').count()).toBe(EXPECTED_COMPONENT_COUNT);
      expect(await view.locator("#browse-tree-nav").getAttribute("role")).toBe("tree");

      const groupLabels = await view
        .locator(".browse-tree__group-label")
        .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));
      // Rendered as "<group> · <count>"; four components per group in the fixture.
      expect(groupLabels.sort()).toEqual(EXPECTED_GROUPS.map((group) => `${group} · 4`));

      // Browse must actually be the visible route — `[data-route-view]` toggling
      // is the only thing standing between it and the classic card grid.
      expect(await view.locator('[data-route-view="browse"]').isVisible()).toBe(true);
      expect(await view.locator('[data-route-view="generate"]').isVisible()).toBe(false);

      await screenshot(page, "ac1-tree.png");
    } finally {
      await page.close();
      await vite.close();
    }
  }, 30_000);

  it("AC1 — clicking a tree item renders its detail panel, metadata and live preview", async () => {
    const vite = await startViteVehicle(fixture.kitDir);
    const page = await browser.newPage();
    try {
      const view = await gotoBrowse(page, vite.url);
      await selectComponent(view, TARGET.name);

      // The breadcrumb is "<kit> / <group> / <name>" — proof the detail panel is
      // driven by the manifest entry, not by the clicked label alone.
      const breadcrumb = await view.locator(".browse-breadcrumb").textContent();
      expect(breadcrumb).toContain(TARGET.group);
      expect(breadcrumb).toContain(TARGET.name);

      // Metadata rows come from the compiled manifest (viewport, hash, ...).
      const metadata = await view.locator(".browse-metadata").textContent();
      expect(metadata).toContain(TARGET.group);
      expect(metadata).toContain(TARGET.viewport);

      // The preview iframe really loads: the stage label only drops "Loading…"
      // on the iframe's own `load` event.
      await expect
        .poll(() => view.locator(".preview-stage .stage-label").textContent(), {
          timeout: 15_000,
        })
        .toBe("Preview · Default");

      // ...and the framed document is the real component preview.
      await expect
        .poll(
          () =>
            page
              .frameLocator(".preview-stage iframe")
              .locator(`[data-component="${TARGET.name}"]`)
              .count(),
          { timeout: 15_000 },
        )
        .toBe(1);

      await screenshot(page, "ac1-detail.png");
    } finally {
      await page.close();
      await vite.close();
    }
  }, 30_000);

  it("AC1 — keyboard navigation moves the roving tabindex and opens a component", async () => {
    const vite = await startViteVehicle(fixture.kitDir);
    const page = await browser.newPage();
    try {
      const view = await gotoBrowse(page, vite.url);
      // Exactly one focusable tree item at rest — the roving-tabindex contract.
      expect(await view.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);

      const names = await treeItemNames(view);
      expect(names.length).toBe(EXPECTED_COMPONENT_COUNT);
      const firstRow = names[0] ?? "";
      const secondRow = names[1] ?? "";
      const lastRow = names[names.length - 1] ?? "";
      // End/Home are only meaningful if the extremes are distinct rows.
      expect(new Set([firstRow, secondRow, lastRow]).size).toBe(3);

      await view.locator('[role="treeitem"]').first().focus();

      // Drive every key `viewer-browse.js` binds, not just ArrowDown: ArrowUp,
      // Home and End were otherwise exercised only under jsdom, so a real-
      // browser regression in any of the three (e.g. a missed preventDefault
      // letting the pane scroll instead of moving focus) would go unseen here.
      const traversal: Array<{ key: string; expected: string }> = [
        { key: "ArrowDown", expected: secondRow },
        { key: "ArrowUp", expected: firstRow },
        { key: "End", expected: lastRow },
        { key: "Home", expected: firstRow },
      ];
      for (const step of traversal) {
        await page.keyboard.press(step.key);
        await expect
          .poll(() => activeRowText(view), {
            message: `${step.key} should focus "${step.expected}"`,
          })
          .toContain(step.expected);
        // The roving contract must hold after *every* move, not just the last.
        expect(await view.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
      }

      // Land back on row 2 and open it, so Enter is asserted against a row
      // reached by keyboard rather than the initial default.
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => activeRowText(view)).toContain(secondRow);

      await page.keyboard.press("Enter");
      await expect
        .poll(() => view.locator(".browse-breadcrumb").textContent())
        .toContain(secondRow);
      expect(await view.locator('[role="treeitem"][aria-selected="true"]').textContent()).toContain(
        secondRow,
      );
    } finally {
      await page.close();
      await vite.close();
    }
  }, 30_000);

  it("AC1 — the filter narrows the tree, reports no matches, and clears back to full", async () => {
    const vite = await startViteVehicle(fixture.kitDir);
    const page = await browser.newPage();
    try {
      const view = await gotoBrowse(page, vite.url);

      // A substring match keeps every name containing it — "Button" alone would
      // legitimately keep three rows, so narrow with an unambiguous name and
      // pin the substring behaviour separately.
      await view.locator("#q").fill(TARGET.name);
      await expect
        .poll(() => view.locator('[role="treeitem"]').count())
        .toBe(FIXTURE_COMPONENTS.filter((c) => c.name.includes(TARGET.name)).length);

      await view.locator("#q").fill(UNIQUE_TARGET.name);
      await expect.poll(() => view.locator('[role="treeitem"]').count()).toBe(1);
      expect(await view.locator('[role="treeitem"]').textContent()).toContain(UNIQUE_TARGET.name);

      await view.locator("#q").fill("definitely-not-a-component");
      // Rendered twice by design (PR #248 review): once inside the tree and once
      // in the compact nav, because CSS hides the tree entirely below 720px and
      // the Clear action must stay reachable there.
      await expect.poll(() => view.locator(".browse-tree__no-match").count()).toBe(2);
      expect(await view.locator('[role="treeitem"]').count()).toBe(0);

      // The empty state's own escape hatch restores the full tree AND focus.
      await view.locator("#browse-tree-nav [data-clear-filter]").click();
      await expect
        .poll(() => view.locator('[role="treeitem"]').count())
        .toBe(EXPECTED_COMPONENT_COUNT);
      expect(
        await view.evaluate(() => {
          const browserGlobals = globalThis as unknown as BrowserGlobals;
          return browserGlobals.document.activeElement?.id ?? "";
        }),
      ).toBe("q");
      expect(await view.locator("#q").inputValue()).toBe("");
    } finally {
      await page.close();
      await vite.close();
    }
  }, 30_000);

  it("AC1 — a selection round-trips through the URL and survives a full reload", async () => {
    const vite = await startViteVehicle(fixture.kitDir);
    const page = await browser.newPage();
    try {
      const view = await gotoBrowse(page, vite.url);
      await selectComponent(view, TARGET.name);

      // The controller writes the selection into the query string...
      await expect
        .poll(() => new URL(page.url()).searchParams.get("componentName"))
        .toBe(TARGET.name);
      const params = new URL(page.url()).searchParams;
      expect(params.get("group")).toBe(TARGET.group);
      expect(params.get("kitId")).toBe(FIXTURE_KIT_ID);

      // ...and reads it back on a COLD boot — a real reload, not a re-render.
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
      await expect
        .poll(() => page.locator('[role="treeitem"][aria-selected="true"]').textContent(), {
          timeout: 15_000,
        })
        .toContain(TARGET.name);
      expect(await page.locator(".browse-breadcrumb").textContent()).toContain(TARGET.name);
    } finally {
      await page.close();
      await vite.close();
    }
  }, 30_000);

  // ── AC2 — HMR-triggered removal, mid-session ──────────────────────────────

  it("AC2 — deleting the OPEN component mid-session removes it and flips the detail panel", async () => {
    // A dedicated 2-component fixture: deleting out of the shared kit would
    // leave every later test running against a mutated manifest.
    const structural = await createViewerFixture([
      { group: "actions", name: "Button", viewport: "320x180" },
      { group: "surfaces", name: "Card", viewport: "320x180" },
    ]);
    const vite = await startViteVehicle(structural.kitDir);
    const page = await browser.newPage();

    // Capture the genie HMR socket's frames. This has to be attached BEFORE
    // navigation to catch the handshake. See the transport assertion below for
    // why an outcome-only check is not enough.
    const hmrFrames: string[] = [];
    page.on("websocket", (ws) => {
      if (!ws.url().includes("__genie_hmr")) return;
      ws.on("framereceived", (frame) => hmrFrames.push(String(frame.payload)));
    });

    try {
      const view = await gotoBrowse(page, vite.url);
      await expect.poll(() => view.locator('[role="treeitem"]').count()).toBe(2);

      // Open the component we're about to delete — this is the mid-session case.
      await selectComponent(view, "Card");
      expect(await view.locator(".browse-breadcrumb").textContent()).toContain("Card");

      await rm(join(structural.kitDir, "components", "surfaces", "Card", "Card.html"));
      await compileManifest(structural.kitDir);

      // No manual `update()` — the real `initHmr` has to notice on its own.
      await expect
        .poll(() => view.locator('[role="treeitem"]').count(), { timeout: 20_000 })
        .toBe(1);
      expect(await treeItemNames(view)).toEqual(["Button"]);

      // Pin the TRANSPORT, not just the outcome. `initHmr` has two paths: the
      // `/__genie_hmr` WebSocket push and a 2 s manifest poll fallback. The
      // assertions above are satisfied by *either*, so on their own they would
      // stay green even with the socket completely broken — the poll would
      // quietly cover for it and the regression would ship. Requiring the
      // `manifest.changed` broadcast (the frame that drives
      // `fetchManifestUpdate()`) is what makes this a real socket test, and it
      // discriminates without depending on timing.
      await expect
        .poll(
          () =>
            hmrFrames.filter((raw) => {
              try {
                return (JSON.parse(raw) as { event?: string }).event === "manifest.changed";
              } catch {
                return false;
              }
            }).length,
          {
            timeout: 10_000,
            message: `no manifest.changed frame on /__genie_hmr; frames seen: ${JSON.stringify(hmrFrames)}`,
          },
        )
        .toBeGreaterThan(0);

      // A full page reload would ALSO drop the row — but it would drop the
      // selection with it and leave the placeholder. The removed-state panel is
      // what proves this was an in-place, mid-session re-projection.
      await expect
        .poll(() => view.locator(".browse-detail__removed").count(), { timeout: 20_000 })
        .toBe(1);
      const removed = view.locator(".browse-detail__removed");
      expect(await removed.textContent()).toContain("Card is no longer available in this UI kit.");
      expect(await removed.getAttribute("role")).toBe("status");

      // Focus must land on something still alive, never on the removed node.
      const focused = await view.evaluate(() => {
        const browserGlobals = globalThis as unknown as BrowserGlobals;
        const active = browserGlobals.document.activeElement;
        return {
          id: active?.id ?? "",
          role: active?.getAttribute("role") ?? "",
          connected: active?.isConnected ?? false,
        };
      });
      expect(focused.connected).toBe(true);
      expect(focused.id === "q" || focused.role === "treeitem").toBe(true);

      await screenshot(page, "ac2-removed.png");
    } finally {
      await page.close();
      await vite.close();
      await structural.cleanup();
    }
  }, 60_000);

  // ── AC3 — a real MCP-host round trip for the source panel ─────────────────

  it("AC3 — the source panel renders the ACTUAL on-disk bytes via a real mcp__genie__read_file", async () => {
    const host = await startMcpHostVehicle(fixture);
    const page = await browser.newPage();
    try {
      const view = await gotoEmbeddedBrowse(page, host);
      await selectComponent(view, TARGET.name);

      const source = view.locator('[data-browse-source-panel="true"] pre.code-box');
      await expect.poll(() => source.count(), { timeout: 20_000 }).toBe(1);

      // The strongest assertion available: byte-for-byte equality with the file
      // the store actually read. Fixture components are ~400 chars, well under
      // the panel's 20 000-char truncation threshold, so nothing is elided.
      const onDisk = await readFile(
        join(fixture.kitDir, "components", TARGET.group, TARGET.name, `${TARGET.name}.html`),
        "utf8",
      );
      expect(await source.textContent()).toBe(onDisk);

      // ...and it genuinely travelled the bridge rather than being synthesised.
      const log = await hostLog(page);
      expect(log).toContain("tools/call:mcp__genie__read_file");
      expect(log).toContain("tool-result:mcp__genie__read_file");

      await screenshot(page, "ac3-source.png");
    } finally {
      await page.close();
      await host.close();
    }
  }, 60_000);

  it("AC3 — the completed host handshake is what enables Refine in the embedded tier", async () => {
    const host = await startMcpHostVehicle(fixture);
    const page = await browser.newPage();
    try {
      const view = await gotoEmbeddedBrowse(page, host);
      await selectComponent(view, TARGET.name);

      // `initMcpApp` only calls `setHostBridge(bridge)` after the host answers
      // `ui/initialize` WITH `hostCapabilities.serverTools`, so an enabled Refine
      // button is proof the real handshake completed — and the explain copy the
      // standalone tier shows instead must be absent.
      const refine = view.locator("button.btn-clay[data-refine-action]");
      await expect.poll(() => refine.count(), { timeout: 20_000 }).toBe(1);
      await expect.poll(() => refine.isEnabled(), { timeout: 20_000 }).toBe(true);
      expect(await view.locator(".browse-refine-explain").count()).toBe(0);

      const log = await hostLog(page);
      expect(log).toContain("ui/initialize");
      expect(log).toContain("notification:ui/notifications/initialized");
    } finally {
      await page.close();
      await host.close();
    }
  }, 60_000);
});

// ── helpers ──────────────────────────────────────────────────────────────────
//
// Every Browse assertion is written against a `Frame` rather than a `Page`: the
// standalone tiers put the workbench in the top-level document, the embedded
// tier puts it inside the host page's `#app` iframe, and `Frame` is the one
// handle that reads the same in both. `page` stays for the things that are
// genuinely page-level (keyboard, reload, screenshots, the host's own log).

/** Navigate to the standalone/localhost Browse route; resolves once the tree paints. */
async function gotoBrowse(page: Page, base: string): Promise<Frame> {
  const url = new URL(base);
  url.searchParams.set("route", "browse");
  await page.goto(url.toString(), { waitUntil: "load" });
  await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
  return page.mainFrame();
}

/** Navigate to the MCP host page; resolves once the EMBEDDED resource's tree paints. */
async function gotoEmbeddedBrowse(page: Page, host: McpHostVehicle): Promise<Frame> {
  await page.goto(host.url, { waitUntil: "load" });
  const handle = await page.waitForSelector("#app", { timeout: 15_000 });
  const frame = await handle.contentFrame();
  if (!frame) throw new Error("the MCP host page's #app iframe exposed no content frame");
  await frame.waitForSelector('[role="treeitem"]', { timeout: 20_000 });
  return frame;
}

/** The host page's ordered protocol log (only the MCP host vehicle records one). */
function hostLog(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const browserGlobals = globalThis as unknown as BrowserGlobals;
    return browserGlobals.__genieHostLog ?? [];
  });
}

/**
 * Click a tree item by component name and wait for its detail panel to arrive.
 * Matched on `data-component-name` rather than text so an ambiguous substring
 * ("Button" is also in "IconButton") can never select the wrong row.
 */
async function selectComponent(view: Frame, name: string): Promise<void> {
  await view.locator(`[role="treeitem"][data-component-name="${name}"]`).click();
  await view.waitForSelector(".browse-breadcrumb", { timeout: 15_000 });
}

/** Every tree item's label, in DOM order. */
function treeItemNames(view: Frame): Promise<string[]> {
  return view
    .locator('[role="treeitem"]')
    .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));
}

/**
 * Label of the currently focused tree row.
 *
 * Read off `document.activeElement` rather than `[tabindex="0"]` so it proves
 * real focus actually moved, not merely that the roving attribute was
 * reshuffled — the two can disagree if a handler updates state but never calls
 * `.focus()`, which is exactly the regression this assertion exists to catch.
 */
function activeRowText(view: Frame): Promise<string> {
  return view.evaluate(() => {
    const browserGlobals = globalThis as unknown as BrowserGlobals;
    return browserGlobals.document.activeElement?.textContent?.trim() ?? "";
  });
}

/** Full-page screenshot into the report dir (mirrors m4-viewer's artefacts). */
async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(REPORT_DIR, name), fullPage: true });
}
