/**
 * Viewer E2E fixture (M4-10 / DRO-272) — one 12-component UI kit, rendered
 * three ways.
 *
 * The M4 acceptance gate (RFC G-5, AGENTS.md hard rule 5) is that the SAME kit
 * artefacts render byte-identical cards across three delivery vehicles:
 *
 *   (a) `file://<root>/index.html`   — a raw file open, no server
 *   (b) `http://127.0.0.1:<port>`    — the Vite dev server (`@ambitresearch/genie-viewer`)
 *   (c) `ui://genie/grid`            — the embedded MCP-Apps resource, rendered
 *                                      headless from `buildGridDocument`
 *
 * This module builds the fixture kit ONCE on disk, compiles it through the real
 * M3-03 `compileManifest`, and exposes helpers to stand up each vehicle. The
 * single compiled manifest is the shared source of truth: every vehicle derives
 * its cards from it, so the E2E test proves the three RENDER paths agree, not
 * that three hand-authored copies happen to match.
 *
 * ── Why a generated kit, not the checked-in `packages/viewer/test/fixtures` ──
 * `compileManifest` WRITES `.genie/manifest.json` into the kit root (it is a
 * recompile-from-disk function). Pointing it at a committed fixture mutates that
 * fixture on every run. So this module scaffolds a throwaway kit under `tmpdir()`
 * and compiles THAT — the repo tree is never touched.
 *
 * ── The card identity used for the G-5 assertion ────────────────────────────
 * A card's cross-vehicle identity is its rendered `(group, name, viewport)`
 * triple — NOT its `path`. Two vehicles deliberately rewrite the path:
 *   - the embedded `ui://` tier rewrites each preview `path` to a `data:` URL
 *     (grid-resource.ts `rewriteCardPaths`, AC4), and
 *   - the compiler derives `name` from the FILE name (`<Name>.html` → `<Name>`),
 *     not from the marker's `name="…"` attribute.
 * So `path` is per-vehicle transport and `name` follows the filename. The triple
 * that MUST be invariant across vehicles is what the viewer paints into each
 * card's chrome: the group section it lives under, its heading, and its viewport
 * pill. That is what {@link readCardIdentities} reads back from a live page.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";

import type { Browser, Page } from "playwright";

import { compileManifest, type Manifest } from "../../../server/src/manifest/index.js";
import { buildGridDocument } from "../../../server/src/ui/grid-resource.js";

/**
 * The `@ambitresearch/genie-viewer` shipped shell (`static/index.html` + `viewer.js` +
 * `viewer.css`) — the real artefacts a scaffolded kit carries at its root
 * (DRO-764) and the exact bytes all three vehicles boot into. Resolved off the
 * viewer package so this fixture tracks whatever the viewer actually ships.
 */
const VIEWER_STATIC_DIR = resolve(
  dirname(createRequire(import.meta.url).resolve("@ambitresearch/genie-viewer/package.json")),
  "static",
);

/** A viewer static asset name (the three files that make up the shell). */
type ViewerAsset = "index.html" | "viewer-browse.js" | "viewer.js" | "viewer.css";

/**
 * The 12-component fixture kit (AC3). Three groups, four components each, a mix
 * of `WxH` and named viewports so the grid exercises both the sized-iframe and
 * default-height code paths. Names are DISTINCT within the kit so a dropped or
 * duplicated card is detectable; the file on disk is `<Name>/<Name>.html`, the
 * layout `compileManifest`'s `deriveName` expects.
 */
export interface ViewerFixtureComponent {
  group: string;
  name: string;
  viewport: string;
  /**
   * Optional full preview bytes, replacing the generic {@link previewHtml} body.
   * Additive and defaulted, so every existing caller keeps the same fixture; the
   * G-5 token check ({@link tokenCardHtml}) uses it to scaffold a card whose
   * rendered appearance actually depends on the kit's design tokens.
   */
  html?: string;
}

export const FIXTURE_COMPONENTS: ReadonlyArray<ViewerFixtureComponent> = [
  { group: "actions", name: "Button", viewport: "480x240" },
  { group: "actions", name: "IconButton", viewport: "240x240" },
  { group: "actions", name: "SplitButton", viewport: "480x240" },
  { group: "actions", name: "Fab", viewport: "160x160" },
  { group: "forms", name: "TextField", viewport: "480x160" },
  { group: "forms", name: "Select", viewport: "480x200" },
  { group: "forms", name: "Checkbox", viewport: "320x120" },
  { group: "forms", name: "DatePicker", viewport: "desktop" },
  { group: "surfaces", name: "Card", viewport: "480x320" },
  { group: "surfaces", name: "Panel", viewport: "640x400" },
  { group: "surfaces", name: "Sheet", viewport: "desktop" },
  { group: "surfaces", name: "Banner", viewport: "800x160" },
];

/** The kitId the fixture is scaffolded under (must satisfy KIT_ID_PATTERN). */
export const FIXTURE_KIT_ID = "acme-kit";

// ── Design tokens: the G-5 cross-vehicle resolution check ───────────────────

/** Kit-relative path of the fixture's token source — the `tokens/` convention
 * `viewer.js`'s `TOKENS_DIR_PREFIX` and every scaffolded kit already use. */
export const FIXTURE_TOKENS_PATH = "tokens/colors.css";

/** The custom property the token check asserts on, and its authored value. */
export const FIXTURE_TOKEN_NAME = "--clay";
export const FIXTURE_TOKEN_VALUE = "#c87c5e";
/** {@link FIXTURE_TOKEN_VALUE} as Chromium reports it from `getComputedStyle`. */
export const FIXTURE_TOKEN_RGB = "rgb(200, 124, 94)";

/** The `:root` block every token-consuming card inlines verbatim. */
const FIXTURE_TOKEN_BLOCK = `:root{${FIXTURE_TOKEN_NAME}:${FIXTURE_TOKEN_VALUE}}`;

/** The kit's on-disk token stylesheet — what a real kit keeps under `tokens/`. */
const FIXTURE_TOKENS_CSS = `/* Fixture kit design tokens. */\n${FIXTURE_TOKEN_BLOCK}\n`;

/**
 * A card whose rendered appearance DEPENDS on a design token, authored the only
 * way that survives all three vehicles: the token block is **inlined**, never
 * `<link>`-ed.
 *
 * There is no href that works everywhere, which is the whole point of this
 * fixture — measured in a real browser against each transport:
 *
 * | reference form                    | file:// | Vite root | ui:// `data:` | ui:// broker |
 * | --------------------------------- | ------- | --------- | ------------- | ------------ |
 * | `href="/tokens/colors.css"`       | ✗       | ✓         | ✗             | ✗            |
 * | `href="../../../tokens/…"`        | ✓       | ✓         | ✗             | ✓            |
 * | inlined `<style>` (this)          | ✓       | ✓         | ✓             | ✓            |
 *
 * A root-absolute href resolves against the FILESYSTEM root under `file://`
 * (`file:///tokens/colors.css`), so the stylesheet silently 404s and every
 * `var(--clay)` falls back to its initial value — a card that still reports the
 * right `(group, name, viewport)` identity while rendering as an empty box.
 * The solo-dev `ui://` tier is harsher still: cards travel as
 * `data:text/html;base64,…` iframes (`grid-resource.ts`'s `rewriteCardPaths`),
 * and a `data:` document has an opaque origin and no base URL, so NO relative
 * subresource resolves at all.
 *
 * This is the same rule `llm/prompts/generate-component.system.md` states for
 * generated cards ("Inline the CSS in a `<style>` block", "Honor the kit's
 * tokens … as literal CSS values in the preview, since it cannot import the
 * kit's stylesheet") — encoded here as something a test can actually fail on.
 */
export function tokenCardHtml(component: ViewerFixtureComponent): string {
  const { group, name, viewport } = component;
  return (
    `<!-- @genie group="${group}" viewport="${viewport}" name="${name}" -->\n` +
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" />` +
    `<style>${FIXTURE_TOKEN_BLOCK}` +
    `body{margin:0;display:grid;place-items:center;height:100vh;font-family:system-ui}` +
    `#swatch{background:var(${FIXTURE_TOKEN_NAME});color:#fff;` +
    `border:0;padding:12px 24px;border-radius:8px;font-size:16px}</style>` +
    `</head><body><button id="swatch" data-component="${name}">${name}</button>` +
    `<script>document.body.dataset.previewReady="true"</script></body></html>\n`
  );
}

/** The one-component kit the cross-vehicle token check renders. */
export const TOKEN_FIXTURE_COMPONENT: ViewerFixtureComponent = {
  group: "actions",
  name: "TokenSwatch",
  viewport: "480x240",
  html: tokenCardHtml({ group: "actions", name: "TokenSwatch", viewport: "480x240" }),
};

/** One card's cross-vehicle identity — the G-5 invariant (see module header). */
export interface CardIdentity {
  group: string;
  name: string;
  viewport: string;
}

/** A fully scaffolded + compiled fixture kit, plus its shared manifest. */
export interface ViewerFixture {
  /** The kits root (parent of the kit dir) — what `buildGridDocument` wants. */
  kitsRoot: string;
  /** The kit id under {@link kitsRoot}. */
  kitId: string;
  /** The scaffolded kit directory (`<kitsRoot>/<kitId>`). */
  kitDir: string;
  /** The manifest compiled from the kit — the single source of truth. */
  manifest: Manifest;
  /** Removes the whole throwaway tree. */
  cleanup: () => Promise<void>;
}

/** The preview HTML for one fixture component (a valid `@genie` marker first). */
function previewHtml(group: string, name: string, viewport: string): string {
  // The marker line MUST match validate/marker.ts's MARKER_REGEX (group first);
  // the body is a trivial, self-contained document (no external assets) so a
  // card renders identically under file:// (no server to resolve `/tokens/...`).
  //
  // Self-containment is the reason these cards render everywhere — but because
  // nothing here depends on a design token, a card whose stylesheet silently
  // failed to load would still satisfy every identity assertion in this suite.
  // {@link tokenCardHtml} is the component that closes that gap.
  return (
    `<!-- @genie group="${group}" viewport="${viewport}" name="${name}" -->\n` +
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" />` +
    `<style>body{margin:0;font-family:system-ui;display:grid;place-items:center;height:100vh}</style>` +
    `</head><body><div data-component="${name}">${name}</div>` +
    `<script>document.body.dataset.previewReady="true"</script></body></html>\n`
  );
}

/**
 * Scaffold the 12-component kit under a throwaway tmpdir, drop the viewer shell
 * at its root (as a real synced kit carries), and compile the manifest via the
 * real M3-03 compiler. The returned {@link ViewerFixture.manifest} is the one
 * every vehicle renders from.
 */
export async function createViewerFixture(
  components: ReadonlyArray<ViewerFixtureComponent> = FIXTURE_COMPONENTS,
): Promise<ViewerFixture> {
  const kitsRoot = await mkdtemp(join(tmpdir(), "genie-m4-e2e-"));
  const kitId = FIXTURE_KIT_ID;
  const kitDir = join(kitsRoot, kitId);

  for (const component of components) {
    const { group, name, viewport, html } = component;
    const dir = join(kitDir, "components", group, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.html`), html ?? previewHtml(group, name, viewport), "utf8");
  }

  // A real kit keeps its design tokens under `tokens/` (viewer.js's
  // TOKENS_DIR_PREFIX). Written so the fixture mirrors that layout — but NOT
  // linked by any card: `tokenCardHtml` inlines the same values, because no
  // href resolves across all three vehicles (see its table). Its presence is
  // what makes the G-5 check meaningful: a card that reached for this file
  // instead of inlining it would still render here on `file://`/Vite and go
  // blank under the solo-dev `data:` transport.
  await mkdir(join(kitDir, dirname(FIXTURE_TOKENS_PATH)), { recursive: true });
  await writeFile(join(kitDir, FIXTURE_TOKENS_PATH), FIXTURE_TOKENS_CSS, "utf8");

  // A scaffolded kit (DRO-764) has the viewer shell as its root index.html.
  await copyViewerShell(kitDir);

  const { manifest } = await compileManifest(kitDir);

  return {
    kitsRoot,
    kitId,
    kitDir,
    manifest,
    cleanup: () => rm(kitsRoot, { recursive: true, force: true }),
  };
}

/** Copy the viewer shell (index.html/viewer-browse.js/viewer.js/viewer.css) into `dest`. */
async function copyViewerShell(dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const asset of [
    "index.html",
    "viewer-browse.js",
    "viewer.js",
    "viewer.css",
  ] as ViewerAsset[]) {
    await cp(join(VIEWER_STATIC_DIR, asset), join(dest, asset));
  }
}

/** Read one viewer static asset's text (for `buildGridDocument`'s readAsset). */
export function readViewerAsset(name: ViewerAsset): Promise<string> {
  return readFile(join(VIEWER_STATIC_DIR, name), "utf8");
}

/**
 * The manifest's expected card identities as a stable, sorted key list — the
 * yardstick every vehicle is compared against.
 */
export function expectedIdentities(manifest: Manifest): CardIdentity[] {
  return manifest.components
    .map((c) => ({ group: c.group, name: c.name, viewport: c.viewport }))
    .sort(compareIdentity);
}

/** Total-order comparator so two identity lists compare deterministically. */
export function compareIdentity(a: CardIdentity, b: CardIdentity): number {
  return (
    a.group.localeCompare(b.group) ||
    a.name.localeCompare(b.name) ||
    a.viewport.localeCompare(b.viewport)
  );
}

/** Stable string key for an identity (for Set/array equality). */
export function identityKey(c: CardIdentity): string {
  return `${c.group} ${c.name} ${c.viewport}`;
}

/**
 * Read every rendered card's `(group, name, viewport)` triple off a live page,
 * sorted. This is the SINGLE cross-vehicle observation the G-5 assertion rests
 * on: it reads exactly what the viewer painted — the group section (`data-group`
 * on the enclosing `.ds-group`), the card heading (`.ds-card__name`), and the
 * viewport pill (`.ds-card__viewport`) — never anything transport-specific.
 */
export async function readCardIdentities(page: Page): Promise<CardIdentity[]> {
  const raw = await page.locator(".ds-card").evaluateAll((cards) =>
    cards.map((card) => ({
      group: card.closest(".ds-group")?.getAttribute("data-group") ?? "",
      name: card.querySelector(".ds-card__name")?.textContent ?? "",
      viewport: card.querySelector(".ds-card__viewport")?.textContent ?? "",
    })),
  );
  return raw.sort(compareIdentity);
}

/**
 * Make the card grid a RENDERED subtree, so its lazy preview iframes are
 * eligible to load. Required before anything reads a card's rendered state; a
 * no-op for anything that only reads the viewer's chrome.
 *
 * The shipped shell (`static/index.html`) ships `#grid` with a `hidden`
 * attribute inside the likewise-`hidden` `[data-route-view="browse"]` section,
 * and `viewer.js` keeps it that way: Browse "re-projects the grid into the
 * workbench on every update" (see `initBrowse`), so `#grid` is a HIDDEN MIRROR
 * of the visible `#browse-workbench` on every route, not just `generate`. This
 * clears exactly the two `hidden` attributes `initBrowse`'s own fallback path
 * clears when the workbench is unavailable — a real shell state, not a
 * test-only DOM edit.
 *
 * ── Why this cannot be skipped, measured per transport ──────────────────────
 * `createCard` marks every preview iframe `loading="lazy"`, and a lazy frame in
 * a `display:none` subtree never becomes viewport-eligible, so it never loads.
 * Chromium only applies lazy-loading to NETWORK-fetched frames, which splits
 * the three vehicles apart:
 *
 * | card transport            | loads while `#grid` is hidden? |
 * | ------------------------- | ------------------------------ |
 * | `file://` preview         | ✓ (lazy-loading does not apply) |
 * | `data:` preview (`ui://`) | ✓ (lazy-loading does not apply) |
 * | `http://` preview (Vite)  | ✗ — frame URL stays `""`        |
 *
 * That asymmetry is a trap for exactly this suite: a rendered-state assertion
 * that forgets to reveal the grid still PASSES on `file://` and `ui://` — while
 * measuring a frame that only loaded because its transport ignores the
 * viewer's own laziness — and fails on Vite alone, which reads as "Vite is
 * broken" rather than "the grid was never shown."
 */
export async function revealCardGrid(page: Page): Promise<void> {
  // Reached through `body.ownerDocument` rather than the `document` global:
  // this package's tsconfig carries no DOM lib, so an evaluate body may only
  // use types reachable from its element argument — the same route
  // `readCardIdentities` and `readTokenState` already take.
  await page.locator("body").evaluate((body) => {
    const doc = body.ownerDocument;
    doc.querySelector("[data-route-view='browse']")?.removeAttribute("hidden");
    doc.getElementById("grid")?.removeAttribute("hidden");
  });
}

// ── Vehicle (b): the real Vite dev server ───────────────────────────────────

/** A booted Vite viewer for the fixture kit; `close()` tears it down. */
export interface ViteVehicle {
  url: string;
  close: () => Promise<void>;
}

/**
 * Boot the real `@ambitresearch/genie-viewer` Vite dev server against the fixture kit
 * (vehicle b). Uses the viewer's own `createViewerConfig` so this exercises the
 * shipped multi-page config, not a bespoke one. Port 0 → an ephemeral free port
 * (no clash with a dev instance or a parallel test worker).
 */
export async function startViteVehicle(kitDir: string): Promise<ViteVehicle> {
  // Import Vite + the viewer source lazily (heavy, and only vehicle b needs
  // them). The source-relative import keeps clean-tree typecheck independent
  // of dist/index.d.ts, which does not exist until the separate build job runs.
  const { createServer } = await import("vite");
  const { createViewerConfig } = await import("../../../viewer/src/index.js");
  const server = await createServer({
    ...createViewerConfig({ root: kitDir, port: 0 }),
    clearScreen: false,
    logLevel: "silent",
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) {
    await server.close();
    throw new Error("Vite dev server bound no local URL");
  }
  return { url, close: () => server.close() };
}

// ── Vehicle (a): file:// via the inlined-manifest transport ─────────────────

/**
 * Assemble a self-contained `file://` root for the fixture kit and return its
 * `index.html` path as a `file://` URL (vehicle a).
 *
 * A real browser's `fetch()` CANNOT read a `file://` URL (Chromium: "URL scheme
 * 'file' is not supported") — verified empirically for DRO-272 — so `viewer.js`'s
 * network manifest path is unavailable under a raw file open. The viewer already
 * handles this: its inline-manifest transport (`readInlineManifest`, the same
 * one the `ui://` tier uses) reads the manifest from a `<script
 * type="application/json" id="manifest">` island in the document, issuing zero
 * `fetch`. So the `file://` vehicle inlines the SHARED manifest exactly as
 * `grid-resource.ts` does for `ui://`, then opens the file. This is the only
 * transport that actually renders cards under a real `file://` navigation, and
 * it keeps `viewer.js` byte-identical across all three vehicles (RFC G-5).
 */
export async function buildFileVehicle(fixture: ViewerFixture): Promise<{ url: string }> {
  const root = await mkdtemp(join(fixture.kitsRoot, "file-vehicle-"));

  const indexHtml = await readViewerAsset("index.html");
  await writeFile(join(root, "index.html"), inlineManifest(indexHtml, fixture.manifest), "utf8");
  await cp(join(VIEWER_STATIC_DIR, "viewer-browse.js"), join(root, "viewer-browse.js"));
  await cp(join(VIEWER_STATIC_DIR, "viewer.js"), join(root, "viewer.js"));
  await cp(join(VIEWER_STATIC_DIR, "viewer.css"), join(root, "viewer.css"));
  // Copy the component previews so each card's iframe src resolves relative to
  // the file:// root (their content is out of scope for the identity check, but
  // a resolvable src keeps the console clean).
  await cp(join(fixture.kitDir, "components"), join(root, "components"), { recursive: true });

  return { url: `file://${join(root, "index.html")}` };
}

/**
 * Inline a manifest into the viewer shell as the `id="manifest"` JSON island,
 * escaped so a hostile string can't break out of the `<script>` — the SAME
 * transform `grid-resource.ts` applies. Kept as a local copy (rather than
 * importing the server's non-exported `inlineManifest`) so the `file://` vehicle
 * is self-describing; the escape set matches `escapeJsonForScript`.
 */
function inlineManifest(indexHtml: string, manifest: Manifest): string {
  const json = JSON.stringify(manifest)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const tag = `<script type="application/json" id="manifest">${json}</script>`;
  const headClose = indexHtml.indexOf("</head>");
  return headClose === -1
    ? tag + indexHtml
    : indexHtml.slice(0, headClose) + tag + indexHtml.slice(headClose);
}

// ── Vehicle (c): the embedded ui://genie/grid document ──────────────────────

/**
 * Build the embedded `ui://genie/grid` HTML for the fixture kit (vehicle c) via
 * the REAL server-side `buildGridDocument` — the exact function the MCP-Apps
 * `resources/read` handler calls. The returned HTML inlines the manifest and
 * rewrites each card's path to a `data:` URL (solo-dev transport, no previews
 * host configured). Returned as raw HTML so a test can assert on the bytes
 * (e.g. the inline manifest island); {@link startUiVehicle} renders it live.
 */
export function buildUiGridDocument(fixture: ViewerFixture): Promise<string> {
  return buildGridDocument(
    {
      kitsRoot: fixture.kitsRoot,
      compile: async (dir) => (await compileManifest(dir)).manifest,
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
    { kitId: fixture.kitId },
  );
}

/** A served embedded-grid document; `close()` tears the server down. */
export interface UiVehicle {
  url: string;
  close: () => Promise<void>;
}

/**
 * Stand up vehicle (c) as a live page from the one self-contained HTML resource
 * a compliant MCP Apps host receives. No sibling files are copied: if the
 * document still depended on `./viewer.js` or `./viewer.css`, this vehicle would
 * fail instead of masking the broken resource contract with a fake HTTP origin.
 */
export async function startUiVehicle(fixture: ViewerFixture): Promise<UiVehicle> {
  const html = await buildUiGridDocument(fixture);
  const root = await mkdtemp(join(fixture.kitsRoot, "ui-vehicle-"));
  await writeFile(join(root, "index.html"), html, "utf8");
  const { server, url } = await serveDir(root);
  return { url, close: () => closeServer(server) };
}

// ── Vehicle (d): the embedded resource under a REAL MCP host (M7-02, #247) ──

/**
 * A booted embedded-tier host: the `ui://genie/grid` resource inside an iframe,
 * parented by a page that speaks the MCP-Apps host half of the protocol and
 * proxies every `tools/call` to a real `@ambitresearch/genie` MCP server over a
 * real MCP `Client`.
 */
export interface McpHostVehicle {
  /** The PARENT host page's URL — what a test navigates to. */
  url: string;
  /** The embedded resource's URL (the iframe `src`), for direct comparison. */
  resourceUrl: string;
  /** Tears down the http server, the MCP client and the MCP server. */
  close: () => Promise<void>;
}

/** Options for {@link startMcpHostVehicle}. */
export interface McpHostVehicleOptions {
  /** Route the embedded resource boots into (default `"browse"`). */
  route?: string;
}

/**
 * The parent host page (M7-02, #247).
 *
 * `createStandaloneSourceBridge` means the localhost/`file://` tiers satisfy the
 * source panel with a plain same-origin `fetch` — no host, no bridge, no
 * `tools/call`. So the ONLY tier where `mcp__genie__read_file` actually travels
 * the MCP-Apps postMessage bridge is the embedded one, and the only way to
 * exercise that end to end is to BE the host. This page is that host:
 *
 *   1. it answers `ui/initialize` inside the viewer's 3 s `initializeTimer`,
 *      advertising `hostCapabilities.serverTools` — the specific flag
 *      `initMcpApp` gates `onReady`/`createHostBridge` on (viewer.js: a
 *      handshake-only reply takes the `onUnavailable` path instead);
 *   2. it proxies `tools/call` to `POST ./__mcp/call`, which the Node side
 *      forwards to a genuine MCP `Client` → `InMemoryTransport` → the shipped
 *      `createServer()`'s registered `mcp__genie__read_file` →
 *      `LocalFsKitStore.readFile` → the actual bytes on disk; and
 *   3. it replies with the tool result VERBATIM, so `structuredContent` reaches
 *      `createHostBridge`'s resolver in its real shape rather than a
 *      hand-rolled approximation of it.
 *
 * `__genieHostLog` records the protocol traffic in order so a test can assert
 * the round trip HAPPENED, not merely that some source text appeared (which a
 * cached or fabricated value would also satisfy).
 */
const MCP_HOST_PAGE = (resourceSrc: string): string =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>genie E2E MCP host</title>
<style>html,body{margin:0;height:100%}iframe{border:0;display:block;width:100%;height:100%}</style>
</head><body>
<iframe id="app" title="genie embedded viewer" src="${resourceSrc}"></iframe>
<script>
(function () {
  var frame = document.getElementById("app");
  window.__genieHostLog = [];
  function post(message) {
    if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
  }
  window.addEventListener("message", function (event) {
    if (!event.data || typeof event.data !== "object") return;
    if (event.source !== frame.contentWindow) return;
    var msg = event.data;
    if (msg.jsonrpc !== "2.0") return;
    if (msg.id === undefined || msg.id === null) {
      window.__genieHostLog.push("notification:" + msg.method);
      return;
    }
    var label = msg.method;
    if (msg.params && typeof msg.params.name === "string") label += ":" + msg.params.name;
    window.__genieHostLog.push(label);
    if (msg.method === "ui/initialize") {
      post({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
          hostCapabilities: { serverTools: { listChanged: false } },
          hostInfo: { name: "genie-e2e-host", version: "1.0.0" }
        }
      });
      return;
    }
    if (msg.method === "ping") {
      post({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (msg.method === "tools/call") {
      fetch("./__mcp/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg.params || {})
      })
        .then(function (response) { return response.json(); })
        .then(function (payload) {
          if (payload && payload.error) {
            window.__genieHostLog.push("tool-error:" + (msg.params && msg.params.name));
            post({ jsonrpc: "2.0", id: msg.id, error: payload.error });
            return;
          }
          window.__genieHostLog.push("tool-result:" + (msg.params && msg.params.name));
          post({ jsonrpc: "2.0", id: msg.id, result: payload.result });
        })
        .catch(function (err) {
          post({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err) } });
        });
      return;
    }
    post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  });
})();
</script>
</body></html>
`;

/**
 * Boot vehicle (d): the embedded grid resource under a real MCP host.
 *
 * The MCP server is the SHIPPED `createServer()` — not a bespoke `McpServer`
 * with one tool bolted on — so this also pins that `mcp__genie__read_file` is
 * still registered under exactly that name on the real server. Both roots are
 * pinned inside the fixture's throwaway tree so nothing touches `process.cwd()`
 * (`createServer` otherwise defaults `projectsRoot` to `<cwd>/.genie/projects`).
 */
export async function startMcpHostVehicle(
  fixture: ViewerFixture,
  options: McpHostVehicleOptions = {},
): Promise<McpHostVehicle> {
  const route = options.route ?? "browse";
  const [{ createServer: createGenieServer }, { Client }, { InMemoryTransport }] =
    await Promise.all([
      import("../../../server/src/server.js"),
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);

  const mcpServer = createGenieServer({
    kitsRoot: fixture.kitsRoot,
    projectsRoot: join(fixture.kitsRoot, ".genie-projects"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "genie-e2e-host", version: "1.0.0" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

  const resourceHtml = await buildUiGridDocument(fixture);
  const resourcePath = `/resource.html?route=${encodeURIComponent(route)}`;
  const hostHtml = MCP_HOST_PAGE(`.${resourcePath}`);

  const server = createHttpServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method === "POST" && pathname === "/__mcp/call") {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        try {
          const params = JSON.parse(raw) as { name?: string; arguments?: Record<string, unknown> };
          if (typeof params.name !== "string") throw new Error("tools/call needs a tool name");
          const result = await client.callTool({
            name: params.name,
            arguments: params.arguments ?? {},
          });
          res.writeHead(200, { "content-type": MIME[".json"] });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          // Surface the failure to the iframe as a JSON-RPC error rather than a
          // dead socket, so the viewer renders its real read-failure copy.
          //
          // The detail is logged rather than returned. Echoing a caught exception
          // into an HTTP response body is the shape CodeQL flags as information
          // exposure, and it buys nothing here: the viewer only needs to *see* an
          // error to render its failure copy, and never reads the message. stderr
          // is also the more useful destination, since it lands in the vitest
          // output beside the failing assertion instead of inside an iframe.
          console.error("[genie-e2e] MCP host tools/call failed:", err);
          res.writeHead(200, { "content-type": MIME[".json"] });
          res.end(JSON.stringify({ error: { code: -32603, message: "Internal error" } }));
        }
        return;
      }
      const body = pathname === "/resource.html" ? resourceHtml : hostHtml;
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(body);
    })();
  });
  const port = await new Promise<number>((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolvePort(addr.port);
    });
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    url: `${base}/`,
    resourceUrl: `${base}${resourcePath}`,
    close: async () => {
      await closeServer(server);
      await client.close();
      await mcpServer.close();
    },
  };
}

// ── A tiny static file server (localhost sanity / screenshots) ──────────────
//
// Not a delivery vehicle itself (vehicle b IS Vite) — used only where a test
// wants plain byte-for-byte HTTP serving of an assembled root without Vite's
// module-graph rewriting (e.g. serving the file:// root over http for a
// screenshot the report can embed). Mirrors packages/viewer/test/a11y.test.ts's
// serveDir, kept here so both suites share the pattern.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Serve `root` over http on an ephemeral port; returns the server + base URL. */
export async function serveDir(root: string): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let rel = decodeURIComponent(url.pathname);
        if (rel === "/") rel = "/index.html";
        const filePath = join(root, rel);
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
  const port = await new Promise<number>((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolvePort(addr.port);
    });
  });
  return { server, url: `http://127.0.0.1:${port}/` };
}

/** Close a `serveDir` server. */
export function closeServer(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

// ── Shared Chromium availability probe (mirrors a11y.test.ts) ───────────────

/**
 * Probe once whether a real Chromium launches. The E2E suite skips (never
 * fails) when it can't — same contract as `packages/viewer/test/a11y.test.ts`:
 * `pnpm test` on a machine that never ran `playwright install` stays green, and
 * CI's dedicated `viewer-e2e` job sets `GENIE_REQUIRE_VIEWER_E2E=1` so a broken
 * browser install there fails loudly instead of skipping vacuously.
 */
export async function isChromiumAvailable(): Promise<boolean> {
  if (process.env.GENIE_SKIP_VIEWER_E2E === "1") return false;
  try {
    const { chromium } = await import("playwright");
    const probe = await chromium.launch();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

/** Launch a shared headless Chromium (caller closes it). */
export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  // --allow-file-access-from-files lets a file:// document load its sibling
  // viewer.js/.css classic script + stylesheet (belt-and-suspenders; a classic
  // script already loads under file://, DRO-749). It does NOT enable fetch() of
  // file:// URLs — Chromium blocks that unconditionally, which is exactly why
  // the file:// vehicle uses the inline-manifest transport.
  return chromium.launch({ args: ["--allow-file-access-from-files"] });
}
