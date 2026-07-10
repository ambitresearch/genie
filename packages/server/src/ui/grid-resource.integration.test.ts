/**
 * M4-06 (DRO-268) — cross-package integration: the REAL `@genie/viewer` static
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
import { MANIFEST_ELEMENT_ID, inlineManifest, inlineViewerAssets } from "./grid-resource.js";

// The real shipped viewer static dir — one level under packages/server → ../../viewer/static.
const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_STATIC = resolve(HERE, "..", "..", "..", "viewer", "static");

let realIndexHtml: string;
let realViewerJs: string;
let realViewerCss: string;

beforeAll(() => {
  realIndexHtml = readFileSync(resolve(VIEWER_STATIC, "index.html"), "utf8");
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
  return inlineManifest(inlineViewerAssets(realIndexHtml, realViewerJs, realViewerCss).html, m);
}

/**
 * Boot the REAL viewer.js against `doc` in a fresh jsdom window whose `fetch`
 * THROWS — proving the embedded tier issues zero network requests. Returns the
 * booted document for assertions.
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
});
