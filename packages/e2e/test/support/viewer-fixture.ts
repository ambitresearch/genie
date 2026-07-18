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
type ViewerAsset = "index.html" | "viewer.js" | "viewer.css";

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

  for (const { group, name, viewport } of components) {
    const dir = join(kitDir, "components", group, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.html`), previewHtml(group, name, viewport), "utf8");
  }

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

/** Copy the viewer shell (index.html/viewer.js/viewer.css) into `dest`. */
async function copyViewerShell(dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const asset of ["index.html", "viewer.js", "viewer.css"] as ViewerAsset[]) {
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
