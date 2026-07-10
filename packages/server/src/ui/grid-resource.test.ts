/**
 * Tests for the `ui://genie/grid` MCP-Apps resource (M4-06 / DRO-268).
 *
 * Two layers:
 *   1. Pure-unit tests of each exported helper (filter, rewrite, inline,
 *      escape, CSP, kit-dir guard, document assembly) — no MCP transport.
 *   2. An end-to-end route through a real `McpServer` + in-memory `Client`,
 *      asserting `resources/read` returns the inlined HTML for both the bare
 *      URI and the query-bearing URI `preview` actually emits.
 *
 * Every collaborator (manifest compiler, asset reader, preview reader) is
 * injected, so the suite drives all branches WITHOUT compiling a real kit,
 * importing Vite, or reading `@genie/viewer` off disk — mirroring how
 * `preview.test.ts` fakes the viewer booter.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { Manifest, ManifestCard } from "../manifest/index.js";
import {
  GRID_RESOURCE_URI,
  GRID_RESOURCE_MIME,
  MANIFEST_ELEMENT_ID,
  VIEWER_JS_URI,
  VIEWER_CSS_URI,
  buildCspMeta,
  buildGridDocument,
  escapeJsonForScript,
  filterManifest,
  inlineManifest,
  normalizePreviewsBaseUrl,
  registerGridResource,
  resolveKitDir,
  rewriteCardPaths,
  type AssetReader,
  type ManifestCompiler,
  type PreviewReader,
} from "./grid-resource.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function card(overrides: Partial<ManifestCard> = {}): ManifestCard {
  return {
    name: "Button",
    group: "Actions",
    path: "components/actions/Button/preview.html",
    viewport: "400x200",
    hash: "sha256-abc",
    lastModified: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(components: ManifestCard[] = [card()]): Manifest {
  const groups = [...new Set(components.map((c) => c.group))];
  return { version: 1, name: "demo", generatedAt: "2026-07-05T00:00:00.000Z", groups, components };
}

/** A shell that looks like the real viewer index.html (has a </head>). */
const FAKE_INDEX =
  '<!doctype html><html class="genie-standalone"><head><meta charset="utf-8" />' +
  '<link rel="stylesheet" href="./viewer.css" /></head>' +
  '<body><main id="grid"></main><script src="./viewer.js"></script></body></html>';

function fakeAssetReader(index = FAKE_INDEX): AssetReader {
  return async (name) => {
    if (name === "index.html") return index;
    if (name === "viewer.js") return "/* viewer.js bytes */";
    return "/* viewer.css bytes */";
  };
}

const okCompiler =
  (m: Manifest): ManifestCompiler =>
  async () =>
    m;
const nullPreviewReader: PreviewReader = async () => null;
const bytesPreviewReader =
  (bytes: Buffer): PreviewReader =>
  async () =>
    bytes;

// ─── resolveKitDir (path-traversal guard) ────────────────────────────────────

describe("resolveKitDir", () => {
  it("joins a valid kitId under the kits root", () => {
    expect(resolveKitDir("/kits", "acme-abc123")).toBe("/kits/acme-abc123");
  });

  it("returns null for an undefined kitId", () => {
    expect(resolveKitDir("/kits", undefined)).toBeNull();
  });

  it("returns null for a traversal / malformed kitId (never escapes the root)", () => {
    expect(resolveKitDir("/kits", "../../etc")).toBeNull();
    expect(resolveKitDir("/kits", "a")).toBeNull(); // too short for KIT_ID_PATTERN
    expect(resolveKitDir("/kits", "UPPER")).toBeNull();
  });
});

// ─── filterManifest (AC2 componentName/group narrowing) ──────────────────────

describe("filterManifest", () => {
  const full = manifest([
    card({ name: "Button", group: "Actions" }),
    card({ name: "Link", group: "Actions", path: "components/actions/Link/preview.html" }),
    card({ name: "Card", group: "Surfaces", path: "components/surfaces/Card/preview.html" }),
  ]);

  it("returns the manifest unchanged when no filter is given", () => {
    expect(filterManifest(full, {})).toBe(full);
  });

  it("filters by group and recomputes groups", () => {
    const out = filterManifest(full, { group: "Actions" });
    expect(out.components.map((c) => c.name)).toEqual(["Button", "Link"]);
    expect(out.groups).toEqual(["Actions"]);
  });

  it("filters by componentName", () => {
    const out = filterManifest(full, { componentName: "Card" });
    expect(out.components.map((c) => c.name)).toEqual(["Card"]);
    expect(out.groups).toEqual(["Surfaces"]);
  });

  it("a filter matching nothing yields an empty-but-valid manifest", () => {
    const out = filterManifest(full, { group: "Nope" });
    expect(out.components).toEqual([]);
    expect(out.groups).toEqual([]);
  });
});

// ─── rewriteCardPaths (AC4) ──────────────────────────────────────────────────

describe("rewriteCardPaths (AC4)", () => {
  it("rewrites to an absolute https:// previews-host URL when configured", async () => {
    const out = await rewriteCardPaths(manifest([card()]), {
      kitId: "acme-abc123",
      kitDir: "/kits/acme-abc123",
      previewsBaseUrl: "https://previews.example.com",
      readPreviewBytes: nullPreviewReader,
    });
    expect(out.components[0]?.path).toBe(
      "https://previews.example.com/acme-abc123/components/actions/Button/preview.html",
    );
    expect(out.components[0]?.sourcePath).toBe("components/actions/Button/preview.html");
  });

  it("honours a previews base URL that already has a trailing slash", async () => {
    const out = await rewriteCardPaths(manifest([card()]), {
      kitId: "k",
      kitDir: "/kits/k",
      previewsBaseUrl: "https://previews.example.com/",
      readPreviewBytes: nullPreviewReader,
    });
    expect(out.components[0]?.path).toContain("https://previews.example.com/k/");
  });

  it("falls back to a data:text/html;base64 URL in solo dev (no previews host)", async () => {
    const bytes = Buffer.from("<html>hi</html>", "utf8");
    const out = await rewriteCardPaths(manifest([card()]), {
      kitId: "k",
      kitDir: "/kits/k",
      previewsBaseUrl: undefined,
      readPreviewBytes: bytesPreviewReader(bytes),
    });
    expect(out.components[0]?.path).toBe(`data:text/html;base64,${bytes.toString("base64")}`);
    expect(out.components[0]?.sourcePath).toBe("components/actions/Button/preview.html");
  });

  it("keeps the relative path when preview bytes cannot be read (graceful)", async () => {
    const out = await rewriteCardPaths(manifest([card()]), {
      kitId: "k",
      kitDir: "/kits/k",
      previewsBaseUrl: undefined,
      readPreviewBytes: nullPreviewReader,
    });
    expect(out.components[0]?.path).toBe("components/actions/Button/preview.html");
    expect(out.components[0]?.sourcePath).toBe("components/actions/Button/preview.html");
  });

  it("degrades to the solo-dev data: URL when previewsBaseUrl is malformed (never throws)", async () => {
    // A bare host (no scheme) is not a valid absolute URL — the old code did
    // `new URL(cardPath, "previews.example.com")` which THROWS. It must instead
    // fall through to the data: transport, keeping resources/read answerable.
    const bytes = Buffer.from("<html>hi</html>", "utf8");
    const out = await rewriteCardPaths(manifest([card()]), {
      kitId: "k",
      kitDir: "/kits/k",
      previewsBaseUrl: "not a url",
      readPreviewBytes: bytesPreviewReader(bytes),
    });
    expect(out.components[0]?.path).toBe(`data:text/html;base64,${bytes.toString("base64")}`);
  });
});

// ─── normalizePreviewsBaseUrl (reviewer robustness fix) ──────────────────────

describe("normalizePreviewsBaseUrl", () => {
  it("returns a trailing-slash URL for a valid https base", () => {
    const u = normalizePreviewsBaseUrl("https://previews.example.com");
    expect(u?.href).toBe("https://previews.example.com/");
  });

  it("preserves an existing path and forces a trailing slash", () => {
    const u = normalizePreviewsBaseUrl("https://cdn.example.com/p");
    expect(u?.href).toBe("https://cdn.example.com/p/");
  });

  it("accepts http as well as https", () => {
    expect(normalizePreviewsBaseUrl("http://localhost:8080")?.origin).toBe("http://localhost:8080");
  });

  it("returns undefined for undefined / empty / malformed / non-http input", () => {
    expect(normalizePreviewsBaseUrl(undefined)).toBeUndefined();
    expect(normalizePreviewsBaseUrl("")).toBeUndefined();
    expect(normalizePreviewsBaseUrl("not a url")).toBeUndefined();
    expect(normalizePreviewsBaseUrl("previews.example.com")).toBeUndefined(); // no scheme
    expect(normalizePreviewsBaseUrl("ftp://x/y")).toBeUndefined(); // wrong scheme
    expect(normalizePreviewsBaseUrl("javascript:alert(1)")).toBeUndefined();
  });
});

// ─── escapeJsonForScript + inlineManifest (AC2, XSS-safe) ────────────────────

describe("escapeJsonForScript", () => {
  it("escapes < > & so the JSON can never break out of a <script> block", () => {
    const raw = JSON.stringify({ name: "</script><script>alert(1)</script>" });
    const esc = escapeJsonForScript(raw);
    expect(esc).not.toContain("</script>");
    expect(esc).not.toContain("<script>");
    // Still valid JSON round-trips to the same value (the escapes are inside
    // the JSON string literal, so JSON.parse restores the original text).
    expect(JSON.parse(esc)).toEqual({ name: "</script><script>alert(1)</script>" });
  });
});

describe("inlineManifest (AC2)", () => {
  it("injects a script#manifest of type application/json before </head>", () => {
    const html = inlineManifest(FAKE_INDEX, manifest());
    expect(html).toContain(`<script type="application/json" id="${MANIFEST_ELEMENT_ID}">`);
    // Placed inside <head> (before the closing tag), so it parses before viewer.js.
    expect(html.indexOf(`id="${MANIFEST_ELEMENT_ID}"`)).toBeLessThan(html.indexOf("</head>"));
  });

  it("keeps the relative asset paths intact (AC3)", () => {
    const html = inlineManifest(FAKE_INDEX, manifest());
    expect(html).toContain('href="./viewer.css"');
    expect(html).toContain('src="./viewer.js"');
  });

  it("a hostile component name cannot terminate the script element", () => {
    const evil = manifest([card({ name: "</script><img src=x onerror=alert(1)>" })]);
    const html = inlineManifest(FAKE_INDEX, evil);
    // The shell already carries one real <script src="./viewer.js">; inlining
    // adds exactly one more (the manifest). If the hostile name had broken out
    // it would introduce a THIRD raw </script>, so the count staying at 2 proves
    // the payload was neutralised.
    expect(html.match(/<\/script>/g)?.length).toBe(2);
    // And the raw hostile markup never appears un-escaped.
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});

// ─── buildCspMeta (AC5) ──────────────────────────────────────────────────────

describe("buildCspMeta (AC5)", () => {
  it("connect-src is 'none' — the manifest is inlined, nothing to fetch", () => {
    const csp = buildCspMeta(undefined);
    expect(csp.connectDomains).toEqual([]);
    expect(csp.policy).toContain("connect-src 'none'");
    expect(csp.policy).toContain("default-src 'none'");
  });

  it("frameDomains is the previews origin when configured", () => {
    const csp = buildCspMeta("https://previews.example.com");
    expect(csp.frameDomains).toEqual(["https://previews.example.com"]);
    expect(csp.policy).toContain("frame-src https://previews.example.com");
  });

  it("frameDomains falls back to data: in solo dev", () => {
    const csp = buildCspMeta(undefined);
    expect(csp.frameDomains).toEqual(["data:"]);
  });

  it("declares the three MCP-Apps allow-list keys (AC5)", () => {
    const csp = buildCspMeta("https://previews.example.com");
    expect(csp).toHaveProperty("connectDomains");
    expect(csp).toHaveProperty("resourceDomains");
    expect(csp).toHaveProperty("frameDomains");
  });

  it("does NOT throw on a malformed previews base URL — degrades to data: (server startup safe)", () => {
    // A malformed GENIE_PREVIEWS_BASE_URL must not crash registerGridResource
    // (which calls buildCspMeta eagerly). It degrades to the solo-dev frame src.
    expect(() => buildCspMeta("not a url")).not.toThrow();
    expect(buildCspMeta("not a url").frameDomains).toEqual(["data:"]);
    expect(buildCspMeta("previews.example.com").frameDomains).toEqual(["data:"]); // no scheme
  });
});

// ─── buildGridDocument (assembly + degradation) ──────────────────────────────

describe("buildGridDocument", () => {
  const baseDeps = {
    kitsRoot: "/kits",
    readAsset: fakeAssetReader(),
    readPreviewBytes: nullPreviewReader,
    previewsBaseUrl: "https://previews.example.com",
  };

  it("compiles + inlines the manifest for a valid kitId (AC2)", async () => {
    const html = await buildGridDocument(
      { ...baseDeps, compile: okCompiler(manifest()) },
      { kitId: "acme-abc123" },
    );
    expect(html).toContain(`id="${MANIFEST_ELEMENT_ID}"`);
    expect(html).toContain("Button"); // the card name made it into the inline JSON
    expect(html).toContain("previews.example.com"); // AC4 rewrite applied
  });

  it("inlines an EMPTY manifest for an absent/invalid kitId (no error)", async () => {
    const html = await buildGridDocument(
      { ...baseDeps, compile: okCompiler(manifest()) },
      { kitId: "../../etc" },
    );
    expect(html).toContain(`id="${MANIFEST_ELEMENT_ID}"`);
    expect(html).toContain('"components":[]');
  });

  it("degrades to an empty grid when the compiler throws (uncompiled kit)", async () => {
    const throwingCompiler: ManifestCompiler = async () => {
      throw new Error("no manifest");
    };
    const html = await buildGridDocument(
      { ...baseDeps, compile: throwingCompiler },
      { kitId: "acme-abc123" },
    );
    expect(html).toContain('"components":[]');
  });

  it("applies the componentName filter before inlining", async () => {
    const full = manifest([
      card({ name: "Button" }),
      card({ name: "Link", path: "components/actions/Link/preview.html" }),
    ]);
    const html = await buildGridDocument(
      { ...baseDeps, compile: okCompiler(full) },
      { kitId: "acme-abc123", componentName: "Link" },
    );
    expect(html).toContain("Link");
    expect(html).not.toContain('"name":"Button"');
  });

  it("falls back to a minimal shell when the viewer assets are unreadable", async () => {
    const badReader: AssetReader = async () => {
      throw new Error("viewer package not installed");
    };
    const html = await buildGridDocument(
      { ...baseDeps, readAsset: badReader, compile: okCompiler(manifest()) },
      { kitId: "acme-abc123" },
    );
    // Still valid HTML with an inline manifest, just no viewer chrome.
    expect(html).toContain(`id="${MANIFEST_ELEMENT_ID}"`);
    expect(html.toLowerCase()).toContain('<main id="grid">');
  });
});

// ─── End-to-end: registration + resources/read routing (AC1/AC3) ─────────────

describe("registerGridResource — MCP route (AC1/AC3)", () => {
  async function connectedClient(compile: ManifestCompiler) {
    const server = new McpServer({ name: "t", version: "0" });
    registerGridResource(server, {
      kitsRoot: "/kits",
      compile,
      readAsset: fakeAssetReader(),
      readPreviewBytes: nullPreviewReader,
      previewsBaseUrl: "https://previews.example.com",
    });
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { server, client };
  }

  it("lists the bare grid resource with the spec MIME (AC1)", async () => {
    const { client } = await connectedClient(okCompiler(manifest()));
    const { resources } = await client.listResources();
    const grid = resources.find((r) => r.uri === GRID_RESOURCE_URI);
    expect(grid).toBeDefined();
    expect(grid?.mimeType).toBe(GRID_RESOURCE_MIME);
    expect(GRID_RESOURCE_MIME).toBe("text/html;profile=mcp-app");
  });

  it("reads the bare ui://genie/grid URI", async () => {
    const { client } = await connectedClient(okCompiler(manifest()));
    const res = await client.readResource({ uri: GRID_RESOURCE_URI });
    expect(res.contents[0]?.mimeType).toBe(GRID_RESOURCE_MIME);
    expect(String(res.contents[0]?.text)).toContain(`id="${MANIFEST_ELEMENT_ID}"`);
  });

  it("reads the query-bearing URI preview emits (?kitId=…&group=…) via the catch-all", async () => {
    const full = manifest([
      card({ name: "Button", group: "Actions" }),
      card({ name: "Card", group: "Surfaces", path: "components/surfaces/Card/preview.html" }),
    ]);
    const { client } = await connectedClient(okCompiler(full));
    const res = await client.readResource({
      uri: `${GRID_RESOURCE_URI}?kitId=acme-abc123&group=Actions`,
    });
    const text = String(res.contents[0]?.text);
    expect(text).toContain("Button");
    // group=Actions filtered Card out before inlining.
    expect(text).not.toContain('"name":"Card"');
  });

  it("reads a kitId-only query URI (componentName/group omitted)", async () => {
    const { client } = await connectedClient(okCompiler(manifest()));
    const res = await client.readResource({ uri: `${GRID_RESOURCE_URI}?kitId=acme-abc123` });
    expect(String(res.contents[0]?.text)).toContain(`id="${MANIFEST_ELEMENT_ID}"`);
  });

  it("serves the sibling viewer.js / viewer.css assets (AC3)", async () => {
    const { client } = await connectedClient(okCompiler(manifest()));
    const js = await client.readResource({ uri: VIEWER_JS_URI });
    const css = await client.readResource({ uri: VIEWER_CSS_URI });
    expect(js.contents[0]?.mimeType).toBe("text/javascript");
    expect(String(js.contents[0]?.text)).toContain("viewer.js");
    expect(css.contents[0]?.mimeType).toBe("text/css");
  });
});
