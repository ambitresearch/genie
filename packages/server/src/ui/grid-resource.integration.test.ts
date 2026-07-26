/**
 * M4-06 (DRO-268) — cross-package integration: the REAL `@ambitresearch/genie-viewer` static
 * assets rendered through the REAL server assembly path.
 *
 * `grid-resource.test.ts` drives every branch with FAKE assets (fast, isolated).
 * This file closes the seam those fakes can hide: it reads the ACTUAL
 * `packages/viewer/static/{index.html,viewer.js}` off disk, assembles the
 * embedded document via the real `inlineManifest`, then BOOTS the real
 * `viewer.js` inside a jsdom window — with `fetch` wired to THROW — and asserts
 * the grid renders purely from the inlined manifest.
 *
 * This is the end-to-end proof of the two halves fitting (AGENTS.md §4, "test
 * against the live service"): the server inlines `<script id="manifest">` AND
 * the shipped viewer reads it with ZERO network calls (the embedded tier's CSP
 * is `connect-src 'none'`). If the manifest DOM id ever drifts between the two
 * packages, or the viewer regresses to fetch-only, THIS test goes red where the
 * unit fakes would stay green.
 *
 * jsdom is driven programmatically (fresh `JSDOM` per test) — the same pattern
 * as `framework/react-preview-host.test.ts`; the repo's default vitest env is
 * `node`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM, VirtualConsole } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

import type { Manifest, ManifestCard } from "../manifest/index.js";
import {
  MANIFEST_ELEMENT_ID,
  buildGridDocument,
  collectInlineCspHashes,
  inlineManifest,
  inlineViewerAssets,
} from "./grid-resource.js";

// The real shipped viewer static dir — one level under packages/server → ../../viewer/static.
const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_STATIC = resolve(HERE, "..", "..", "..", "viewer", "static");

let realIndexHtml: string;
let realViewerBrowseJs: string;
let realViewerJs: string;
let realViewerCss: string;

beforeAll(() => {
  realIndexHtml = readFileSync(resolve(VIEWER_STATIC, "index.html"), "utf8");
  realViewerBrowseJs = readFileSync(resolve(VIEWER_STATIC, "viewer-browse.js"), "utf8");
  realViewerJs = readFileSync(resolve(VIEWER_STATIC, "viewer.js"), "utf8");
  realViewerCss = readFileSync(resolve(VIEWER_STATIC, "viewer.css"), "utf8");
});

function card(overrides: Partial<ManifestCard> = {}): ManifestCard {
  return {
    name: "Primary",
    group: "Actions",
    // A data: URL is what the embedded tier's AC4 rewrite produces in solo dev.
    path: "data:text/html;base64,PGgxPmE8L2gxPg==",
    viewport: "480x240",
    hash: "sha256-x",
    lastModified: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(components: ManifestCard[]): Manifest {
  const groups = [...new Set(components.map((c) => c.group))];
  return { version: 1, name: "live", generatedAt: "2026-07-05T00:00:00.000Z", groups, components };
}

function assemble(m: Manifest): string {
  return inlineManifest(
    inlineViewerAssets(
      realIndexHtml,
      [
        { name: "viewer-browse.js", source: realViewerBrowseJs },
        { name: "viewer.js", source: realViewerJs },
      ],
      realViewerCss,
    ).html,
    m,
  );
}

/**
 * Boot the REAL viewer scripts against `doc` in a fresh jsdom window whose
 * `fetch` THROWS — proving the embedded tier issues zero network requests.
 * Returns the booted document for assertions.
 *
 * Both classic scripts are evaluated in `index.html`'s document order
 * (browse BEFORE core, #253), because that is what a browser does with the
 * assembled document `assemble()` produced. The degraded core-only case —
 * `viewer-browse.js` missing at runtime — is pinned separately by the viewer
 * package's `grid-renderer.test.ts` "cross-script seam" suite.
 */
async function bootRealViewer(doc: string): Promise<Document> {
  const dom = new JSDOM(doc, {
    runScripts: "outside-only",
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  // Embedded tier: connect-src 'none' — any fetch is a contract violation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).fetch = () => {
    throw new Error("fetch called — embedded tier must not fetch under connect-src 'none'");
  };
  window.eval(realViewerBrowseJs);
  window.eval(realViewerJs);
  // Let the guarded auto-boot's promise settle.
  await new Promise((r) => setTimeout(r, 0));
  return window.document;
}

describe("M4-06 integration — real viewer assets + real assembly", () => {
  it("assembles the real index.html with an inline manifest node", () => {
    const doc = assemble(manifest([card()]));
    expect(doc).toContain(`<script type="application/json" id="${MANIFEST_ELEMENT_ID}">`);
    const parsed = new JSDOM(doc, { virtualConsole: new VirtualConsole() }).window.document;
    expect(parsed.querySelector('script[src="./viewer.js"]')).toBeNull();
    expect(parsed.querySelector('link[href="./viewer.css"]')).toBeNull();
    expect(doc).toContain("<style>");
    expect(doc).toContain("<script>");
  });

  it("the real viewer.js renders the grid from the inlined manifest with ZERO fetch", async () => {
    const doc = assemble(
      manifest([
        card({ name: "Primary", group: "Actions" }),
        card({
          name: "Card",
          group: "Surfaces",
          path: "data:text/html;base64,PGgxPmI8L2gxPg==",
          viewport: "480x320",
        }),
      ]),
    );

    const rendered = await bootRealViewer(doc);

    // Two cards → two iframes, two group sections, no error state — all from the
    // inline manifest, no network (fetch would have thrown).
    expect(rendered.querySelectorAll("iframe").length).toBe(2);
    expect(rendered.querySelectorAll("section.ds-group").length).toBe(2);
    expect(rendered.querySelector(".ds-error")).toBeNull();
    // The AC4 data: transport survived into the rendered iframe src.
    const firstSrc = rendered.querySelector("iframe")?.getAttribute("src") ?? "";
    expect(firstSrc.startsWith("data:text/html;base64,")).toBe(true);
  });

  it("renders the real viewer's empty state for an empty inlined manifest (still no fetch)", async () => {
    const doc = assemble(manifest([]));
    const rendered = await bootRealViewer(doc);
    expect(rendered.querySelector(".ds-empty")).not.toBeNull();
    expect(rendered.querySelectorAll("iframe").length).toBe(0);
    expect(rendered.querySelector(".ds-error")).toBeNull();
  });

  // ── Regression: NUL (and other HTML-parser-lossy) bytes in viewer.js ────────
  //
  // The embedded `ui://` tier's CSP allow-lists the inline <script>'s exact
  // SHA-256 hash, computed from `viewer.js`'s bytes BEFORE they are wrapped in
  // a <script> tag and (re-)parsed as HTML text. Per the HTML spec, an HTML
  // parser replaces any literal NUL (U+0000) byte in text content with U+FFFD
  // (the replacement character) — this is a browser-enforced, non-optional
  // tokenizer rule, not a bug in any one engine. If `viewer.js` (or any other
  // inlined asset) ever contains a raw NUL byte, the byte the browser actually
  // executes differs from the byte `cspSha256` hashed, the computed hash no
  // longer matches what the browser recomputes at parse time, and the CSP
  // silently blocks the ENTIRE inline script — every card fails to render
  // with no visible error (only a CSP console warning). This exact defect
  // shipped once (a NUL byte used as an ad hoc delimiter deep in the Browse
  // compact-select wiring) and was caught only by the `viewer E2E gate` full
  // browser run, not by any DOM-level unit test — hence this guard, so a
  // reviewer/CI catches it at the byte level without needing a real browser.
  it("the real viewer.js contains no NUL bytes (would desync the CSP hash from what a browser parses)", () => {
    expect(realViewerJs).not.toContain("\u0000");
    expect(realIndexHtml).not.toContain("\u0000");
    expect(realViewerCss).not.toContain("\u0000");
  });

  it("the inlined <script>/<style> bytes a browser re-parses hash to the SAME CSP allow-list value computed pre-inline", () => {
    const doc = assemble(manifest([card()]));
    const { hashes } = inlineViewerAssets(
      realIndexHtml,
      [
        { name: "viewer-browse.js", source: realViewerBrowseJs },
        { name: "viewer.js", source: realViewerJs },
      ],
      realViewerCss,
    );

    // Re-derive the hashes from what a real HTML parser sees after the fact
    // (jsdom, same as `bootRealViewer`) rather than from the pre-inline
    // strings — this is the exact seam a NUL-byte (or similar lossy-parse)
    // regression breaks: the pre-inline hash and the post-parse hash diverge.
    const parsedHashes = collectInlineCspHashes(doc);
    for (const hash of hashes.scriptHashes) {
      expect(parsedHashes.scriptHashes).toContain(hash);
    }
    for (const hash of hashes.styleHashes) {
      expect(parsedHashes.styleHashes).toContain(hash);
    }
  });

  // Copilot review (PR #248) — the two tests above only ever compare
  // `inlineViewerAssets`'s own hashes (the shipped index.html/viewer.js/
  // viewer.css inline blocks) against a fresh re-parse of THOSE bytes. They
  // never exercise the manifest data-island `<script>` that `buildGridDocument`
  // additionally hashes and allow-lists (see its `scriptHashes.add(cspSha256(
  // escapeJsonForScript(JSON.stringify(manifest))))` call) — so a regression
  // that broke JUST the manifest-island hash (e.g. hashing the wrong JSON
  // encoding, or forgetting to add it to the CSP meta at all) would pass both
  // existing tests while still shipping a document whose OWN manifest
  // `<script>` is blocked by its OWN CSP meta tag. Build the actual final
  // document end-to-end through `buildGridDocument` and assert the manifest
  // island's real (post-parse) hash is present in the emitted `script-src`.
  it("buildGridDocument's emitted script-src allow-lists the manifest data-island's own hash", async () => {
    const m = manifest([card()]);
    const html = await buildGridDocument(
      {
        kitsRoot: "/kits",
        readAsset: async (name) => {
          if (name === "index.html") return realIndexHtml;
          if (name === "viewer-browse.js") return realViewerBrowseJs;
          if (name === "viewer.js") return realViewerJs;
          return realViewerCss;
        },
        readPreviewBytes: async () => null,
        previewsBaseUrl: "https://previews.example.com",
        compile: async () => m,
      },
      { kitId: "acme-abc123" },
    );

    // Parse the FINAL document (same as a browser would) to get the manifest
    // island's actual hash, rather than trusting the pre-inline computation.
    const parsedHashes = collectInlineCspHashes(html);
    const cspMetaMatch = html.match(/content="([^"]*)"/);
    expect(cspMetaMatch).not.toBeNull();
    const cspPolicy = (cspMetaMatch as RegExpMatchArray)[1].replace(/&quot;/g, '"');
    const scriptSrcMatch = cspPolicy.match(/script-src ([^;]+)/);
    expect(scriptSrcMatch).not.toBeNull();
    const scriptSrc = (scriptSrcMatch as RegExpMatchArray)[1];

    // Every inline-script hash the parsed document actually contains
    // (viewer.js's own inline block AND the manifest data island) must be
    // allow-listed in script-src — a document that fails to allow-list its
    // own manifest island's hash would render with the grid silently blank.
    expect(parsedHashes.scriptHashes.length).toBeGreaterThan(1);
    for (const hash of parsedHashes.scriptHashes) {
      expect(scriptSrc).toContain(hash);
    }
  });
});
