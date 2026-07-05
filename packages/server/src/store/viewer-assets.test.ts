/**
 * Tests for `loadViewerAssets` (DRO-764) — the shared read-half of the
 * create_kit viewer-scaffolding fix.
 */
import { describe, expect, it } from "vitest";

import { loadViewerAssets } from "./viewer-assets.js";

describe("loadViewerAssets", () => {
  it("loads all three viewer static files, byte-identical to packages/viewer/static", async () => {
    const assets = await loadViewerAssets();

    expect(assets.map((a) => a.path)).toEqual(["index.html", "viewer.js", "viewer.css"]);
    for (const asset of assets) {
      expect(Buffer.isBuffer(asset.content)).toBe(true);
      expect(asset.content.length).toBeGreaterThan(0);
    }
  });

  it("index.html content matches the real static file's bytes exactly", async () => {
    const assets = await loadViewerAssets();
    const indexAsset = assets.find((a) => a.path === "index.html");
    expect(indexAsset).toBeDefined();
    expect(indexAsset?.content.toString("utf-8")).toContain('<main id="grid"');
  });

  it("viewer.js is loaded as a classic script's source (DRO-749 contract) — no ESM export/import", async () => {
    const assets = await loadViewerAssets();
    const jsAsset = assets.find((a) => a.path === "viewer.js");
    const text = jsAsset?.content.toString("utf-8") ?? "";
    expect(text).not.toMatch(/^export /m);
  });

  it("viewer.css is non-empty CSS text", async () => {
    const assets = await loadViewerAssets();
    const cssAsset = assets.find((a) => a.path === "viewer.css");
    expect(cssAsset?.content.toString("utf-8")).toContain("{");
  });
});
