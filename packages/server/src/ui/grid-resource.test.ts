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
 * importing Vite, or reading `@ambitresearch/genie-viewer` off disk — mirroring how
 * `preview.test.ts` fakes the viewer booter.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { Manifest, ManifestCard } from "../manifest/index.js";
import type { CardAssetBroker, CardAssetKit } from "./card-asset-broker.js";
import {
  GRID_RESOURCE_URI,
  GRID_RESOURCE_MIME,
  MANIFEST_ELEMENT_ID,
  TOOL_RESULT_SHELL_META,
  VIEWER_JS_URI,
  VIEWER_CSS_URI,
  buildCspMeta,
  buildGridDocument,
  collectInlineCspHashes,
  cspMetaTag,
  escapeJsonForScript,
  filterManifest,
  inlineManifest,
  normalizePreviewsBaseUrl,
  gridResourceMeta,
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

function fakeCardAssetBroker(port = 5188): {
  broker: CardAssetBroker;
  registrations: Array<{ kitId: string; root: string }>;
} {
  const registrations: Array<{ kitId: string; root: string }> = [];
  const kits = new Map<string, CardAssetKit>();
  const origin = `http://127.0.0.1:${port}`;
  const frameOrigins = Object.freeze([origin]);
  const broker: CardAssetBroker = {
    address: "127.0.0.1",
    port,
    async registerKit(kitId, root) {
      registrations.push({ kitId, root });
      const existing = kits.get(kitId);
      if (existing !== undefined) return existing;
      const registered: CardAssetKit = {
        kitId,
        token: `token-${kitId}`,
        routePrefix: `/k/token-${kitId}`,
        hostname: "127.0.0.1",
        authority: `127.0.0.1:${port}`,
        origin,
        urlFor: (path) =>
          `${origin}/k/token-${kitId}/${path
            .replace(/^\//, "")
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/")}`,
      };
      kits.set(kitId, registered);
      return registered;
    },
    getKit: (kitId) => kits.get(kitId),
    frameOrigins: () => frameOrigins,
    close: async () => {},
  };
  return { broker, registrations };
}

function gridUri(params: Record<string, string>): string {
  const uri = new URL(GRID_RESOURCE_URI);
  for (const [key, value] of Object.entries(params)) uri.searchParams.set(key, value);
  return uri.toString();
}

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

// ─── buildCspMeta (AC5 allow-list) + M4-07 hardening (AC1/AC3) ───────────────

describe("buildCspMeta (AC5)", () => {
  it("connect-src is 'none' — the manifest is inlined, nothing to fetch", () => {
    const csp = buildCspMeta(undefined);
    expect(csp.connectDomains).toEqual([]);
    expect(csp.metaPolicy).toContain("connect-src 'none'");
    expect(csp.metaPolicy).toContain("default-src 'none'");
  });

  it("frameDomains is the previews origin when configured", () => {
    const csp = buildCspMeta("https://previews.example.com");
    expect(csp.frameDomains).toEqual(["https://previews.example.com"]);
    expect(csp.metaPolicy).toContain("frame-src https://previews.example.com");
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
    expect(csp.resourceDomains).toEqual([]);
  });

  it("does NOT throw on a malformed previews base URL — degrades to data: (server startup safe)", () => {
    // A malformed GENIE_PREVIEWS_BASE_URL must not crash registerGridResource
    // (which calls buildCspMeta eagerly). It degrades to the solo-dev frame src.
    expect(() => buildCspMeta("not a url")).not.toThrow();
    expect(buildCspMeta("not a url").frameDomains).toEqual(["data:"]);
    expect(buildCspMeta("previews.example.com").frameDomains).toEqual(["data:"]); // no scheme
  });

  // ── M4-07 (DRO-269) hardening ────────────────────────────────────────────
  //
  // AC3 forbids `unsafe-inline` and `unsafe-eval` anywhere. AC1 requires the
  // hardened directive set while allowing only exact hashes for trusted inline
  // viewer/card assets.

  it("AC3 — script-src has no unsafe-inline and no unsafe-eval", () => {
    for (const url of [undefined, "https://previews.example.com"]) {
      const csp = buildCspMeta(url);
      expect(csp.metaPolicy).not.toContain("'unsafe-inline'");
      expect(csp.metaPolicy).not.toContain("'unsafe-eval'");
    }
  });

  it("AC3 — style-src has no unsafe-inline", () => {
    const csp = buildCspMeta("https://previews.example.com");
    const styleSrc = /style-src [^;]*/.exec(csp.metaPolicy)?.[0] ?? "";
    expect(styleSrc).toContain("style-src");
    expect(styleSrc).not.toContain("'unsafe-inline'");
  });

  it("AC1/AC2 — allows only exact hashes for trusted inline script and style blocks", () => {
    const hashes = collectInlineCspHashes(
      "<!doctype html><style>body{color:red}</style><script>window.x=1</script>",
    );
    const csp = buildCspMeta(undefined, hashes);

    expect(hashes.scriptHashes).toHaveLength(1);
    expect(hashes.styleHashes).toHaveLength(1);
    expect(hashes.scriptHashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(hashes.styleHashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(csp.metaPolicy).toContain(hashes.scriptHashes[0]!);
    expect(csp.metaPolicy).toContain(hashes.styleHashes[0]!);
  });

  it("AC1 — uses 'none' for script/style when no trusted inline blocks exist", () => {
    const csp = buildCspMeta(undefined);
    expect(csp.metaPolicy).toContain("script-src 'none'");
    expect(csp.metaPolicy).toContain("style-src 'none'");
  });

  it("AC1 — adds base-uri 'none', form-action 'none', object-src 'none' (deny form/object/embed)", () => {
    const csp = buildCspMeta(undefined);
    expect(csp.metaPolicy).toContain("base-uri 'none'");
    expect(csp.metaPolicy).toContain("form-action 'none'");
    expect(csp.metaPolicy).toContain("object-src 'none'");
  });

  it("AC1 — img-src permits data: + https: (card thumbnails)", () => {
    const csp = buildCspMeta(undefined);
    expect(csp.metaPolicy).toContain("img-src");
    const imgSrc = /img-src [^;]*/.exec(csp.metaPolicy)?.[0] ?? "";
    expect(imgSrc).toContain("data:");
    expect(imgSrc).toContain("https:");
  });

  it("does not advertise a raw header policy or frame-ancestors", () => {
    const csp = buildCspMeta(undefined);
    expect(csp).not.toHaveProperty("policy");
    expect(csp.metaPolicy).not.toContain("frame-ancestors");
  });

  it("publishes canonical MCP Apps CSP plus the OpenAI snake-case compatibility mirror", () => {
    expect(gridResourceMeta("https://previews.example.com")).toEqual({
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: ["https://previews.example.com"],
        },
      },
      "openai/widgetCSP": {
        connect_domains: [],
        resource_domains: [],
        frame_domains: ["https://previews.example.com"],
      },
    });
  });
});

// ─── cspMetaTag (M4-07) ──────────────────────────────────────────────────────

describe("cspMetaTag (AC1 — CSP enforced via injected meta)", () => {
  it("emits a valid <meta http-equiv=Content-Security-Policy content=…> tag", () => {
    const tag = cspMetaTag(buildCspMeta(undefined));
    expect(tag.startsWith("<meta ")).toBe(true);
    expect(tag).toContain('http-equiv="Content-Security-Policy"');
    expect(tag).toContain("content=");
    expect(tag).toContain("default-src 'none'");
  });

  it("uses the hash-based metaPolicy and omits frame-ancestors", () => {
    const csp = buildCspMeta(undefined);
    const tag = cspMetaTag(csp);
    expect(tag).not.toContain("frame-ancestors");
    // And it carries no unsafe-inline/eval (AC3).
    expect(tag).not.toContain("unsafe-inline");
    expect(tag).not.toContain("unsafe-eval");
  });

  it("HTML-escapes the policy string safely for an attribute value", () => {
    // The policy string is server-authored (no user input), so escaping is
    // defence-in-depth — but a stray `"` in a future directive must not break
    // the attribute. Verify the attribute delimiter itself is escaped.
    const csp = { ...buildCspMeta(undefined), metaPolicy: `default-src 'none'; x "y` };
    const tag = cspMetaTag(csp);
    // The tag opens with a `"` and closes with a `"`; the interior `"y` must
    // have been escaped so the attribute value doesn't terminate early.
    expect(tag).toMatch(/content="[^"]*&quot;y[^"]*"/);
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

  it("inlines viewer.js/viewer.css and hash-allows their exact bytes", async () => {
    const html = await buildGridDocument(
      { ...baseDeps, compile: okCompiler(manifest()) },
      { kitId: "acme-abc123" },
    );
    expect(html).not.toContain('href="./viewer.css"');
    expect(html).not.toContain('src="./viewer.js"');
    expect(html).toContain("<style>/* viewer.css bytes */</style>");
    expect(html).toContain("<script>/* viewer.js bytes */</script>");

    const hashes = collectInlineCspHashes(
      "<style>/* viewer.css bytes */</style><script>/* viewer.js bytes */</script>",
    );
    for (const hash of [...hashes.scriptHashes, ...hashes.styleHashes]) {
      expect(html).toContain(hash);
    }
  });

  it("hash-allows legitimate inline script/style bytes in data-backed previews", async () => {
    const preview =
      "<!doctype html><style>body{display:grid}</style>" +
      "<script>document.body.dataset.ready='true'</script><body>card</body>";
    const html = await buildGridDocument(
      {
        ...baseDeps,
        previewsBaseUrl: undefined,
        readPreviewBytes: bytesPreviewReader(Buffer.from(preview, "utf8")),
        compile: okCompiler(manifest()),
      },
      { kitId: "acme-abc123" },
    );
    const hashes = collectInlineCspHashes(preview);
    for (const hash of [...hashes.scriptHashes, ...hashes.styleHashes]) {
      expect(html).toContain(hash);
    }
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

  // ── M4-07 (DRO-269) — CSP enforcement via injected meta tag ─────────────

  it("AC1 — injects a Content-Security-Policy meta tag into the assembled document", async () => {
    const html = await buildGridDocument(
      { ...baseDeps, compile: okCompiler(manifest()) },
      { kitId: "acme-abc123" },
    );
    // The meta MUST be present and placed inside <head> (so a hostile inline
    // script later in the doc is already governed by the policy when parsed).
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    const headOpen = html.indexOf("<head");
    const headClose = html.indexOf("</head>");
    const metaAt = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(headOpen).toBeGreaterThanOrEqual(0);
    expect(headClose).toBeGreaterThan(headOpen);
    expect(metaAt).toBeGreaterThan(headOpen);
    expect(metaAt).toBeLessThan(headClose);
  });

  it("AC3 — the enforced CSP has no unsafe-inline / unsafe-eval", async () => {
    const html = await buildGridDocument(
      { ...baseDeps, compile: okCompiler(manifest()) },
      { kitId: "acme-abc123" },
    );
    // Read just the meta's content=... attribute so we're not accidentally
    // matching viewer.js/manifest bytes that mention the keywords.
    const attr = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(attr).not.toContain("unsafe-inline");
    expect(attr).not.toContain("unsafe-eval");
    expect(attr).toContain("default-src 'none'");
    expect(attr).toContain("connect-src 'none'");
    expect(attr).toContain("object-src 'none'");
    expect(attr).toContain("base-uri 'none'");
  });

  it("AC1 — the fallback shell ALSO carries the enforced CSP meta", async () => {
    const badReader: AssetReader = async () => {
      throw new Error("viewer package not installed");
    };
    const html = await buildGridDocument(
      { ...baseDeps, readAsset: badReader, compile: okCompiler(manifest()) },
      { kitId: "acme-abc123" },
    );
    // A viewer-asset failure must NOT downgrade the security posture — the
    // dependency-free fallback shell must be as locked down as the real one.
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    const attr = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(attr).not.toContain("unsafe-inline");
    expect(attr).toContain("default-src 'none'");
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
    const resourceUri = new URL(GRID_RESOURCE_URI);
    expect(`${resourceUri.protocol}//${resourceUri.host}${resourceUri.pathname}`).toBe(
      "ui://genie/grid",
    );
    expect(resourceUri.searchParams.get("v")).toBe("2");
    expect(resourceUri.searchParams.get("instance")).toMatch(/^[a-f0-9]{32}$/);
    const grid = resources.find((r) => r.uri === GRID_RESOURCE_URI);
    expect(grid).toBeDefined();
    expect(grid?.mimeType).toBe(GRID_RESOURCE_MIME);
    expect(GRID_RESOURCE_MIME).toBe("text/html;profile=mcp-app");
    expect(grid?._meta).toEqual({
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: ["https://previews.example.com"],
        },
      },
      "openai/widgetCSP": {
        connect_domains: [],
        resource_domains: [],
        frame_domains: ["https://previews.example.com"],
      },
    });
  });

  it("reads the bare ui://genie/grid URI", async () => {
    const { client } = await connectedClient(okCompiler(manifest()));
    const res = await client.readResource({ uri: GRID_RESOURCE_URI });
    expect(res.contents[0]?.mimeType).toBe(GRID_RESOURCE_MIME);
    expect(String(res.contents[0]?.text)).toContain(`id="${MANIFEST_ELEMENT_ID}"`);
    expect(String(res.contents[0]?.text)).toContain(`name="${TOOL_RESULT_SHELL_META}"`);
    expect(res.contents[0]?._meta).toEqual({
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: ["https://previews.example.com"],
        },
      },
      "openai/widgetCSP": {
        connect_domains: [],
        resource_domains: [],
        frame_domains: ["https://previews.example.com"],
      },
    });
  });

  it("reads the query-bearing URI preview emits (?kitId=…&group=…) via the catch-all", async () => {
    const full = manifest([
      card({ name: "Button", group: "Actions" }),
      card({ name: "Card", group: "Surfaces", path: "components/surfaces/Card/preview.html" }),
    ]);
    const { client } = await connectedClient(okCompiler(full));
    const uri = gridUri({ kitId: "acme-abc123", group: "Actions" });
    const res = await client.readResource({ uri });
    expect(res.contents[0]?.uri).toBe(uri);
    const text = String(res.contents[0]?.text);
    expect(text).toContain("Button");
    // group=Actions filtered Card out before inlining.
    expect(text).not.toContain('"name":"Card"');
  });

  it("reads a kitId-only query URI (componentName/group omitted)", async () => {
    const { client } = await connectedClient(okCompiler(manifest()));
    const res = await client.readResource({ uri: gridUri({ kitId: "acme-abc123" }) });
    expect(String(res.contents[0]?.text)).toContain(`id="${MANIFEST_ELEMENT_ID}"`);
  });

  it("starts the broker for the bare shell without scanning kits and advertises its stable origin", async () => {
    const kitsRoot = await mkdtemp(join(tmpdir(), "genie-grid-no-scan-"));
    try {
      await Promise.all([mkdir(join(kitsRoot, "alpha-kit")), mkdir(join(kitsRoot, "zeta-kit"))]);
      const { broker, registrations } = fakeCardAssetBroker();
      let brokerReads = 0;
      const server = new McpServer({ name: "t", version: "0" });
      registerGridResource(server, {
        kitsRoot,
        compile: okCompiler(manifest()),
        readAsset: fakeAssetReader(),
        readPreviewBytes: nullPreviewReader,
        previewsBaseUrl: "",
        getCardAssetBroker: async () => {
          brokerReads += 1;
          return broker;
        },
      });
      const client = new Client({ name: "c", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);

      const listed = (await client.listResources()).resources.find(
        (resource) => resource.uri === GRID_RESOURCE_URI,
      );
      expect(brokerReads).toBe(0);
      expect(listed?._meta).toMatchObject({
        ui: { csp: { frameDomains: [] } },
        "openai/widgetCSP": { frame_domains: [] },
      });

      const res = await client.readResource({ uri: GRID_RESOURCE_URI });
      const origin = "http://127.0.0.1:5188";
      expect(brokerReads).toBe(1);
      expect(registrations).toEqual([]);
      expect(res.contents[0]?._meta).toMatchObject({
        ui: { csp: { frameDomains: [origin] } },
        "openai/widgetCSP": { frame_domains: [origin] },
      });
      const text = String(res.contents[0]?.text);
      expect(text).toContain(`frame-src ${origin}`);
      expect(text).not.toContain("localhost:*");
      expect(text).not.toContain("127.0.0.1:*");
    } finally {
      await rm(kitsRoot, { recursive: true, force: true });
    }
  });

  it("registers a requested local kit and rewrites its embedded cards to the broker origin", async () => {
    const kitsRoot = await mkdtemp(join(tmpdir(), "genie-grid-requested-kit-"));
    try {
      await mkdir(join(kitsRoot, "acme-abc123"));
      const { broker, registrations } = fakeCardAssetBroker(5199);
      const server = new McpServer({ name: "t", version: "0" });
      registerGridResource(server, {
        kitsRoot,
        compile: okCompiler(manifest()),
        readAsset: fakeAssetReader(),
        readPreviewBytes: nullPreviewReader,
        previewsBaseUrl: "",
        getCardAssetBroker: async () => broker,
      });
      const client = new Client({ name: "c", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);

      const res = await client.readResource({
        uri: gridUri({ kitId: "acme-abc123", componentName: "Button" }),
      });
      const origin = "http://127.0.0.1:5199";
      expect(registrations).toEqual([
        { kitId: "acme-abc123", root: join(kitsRoot, "acme-abc123") },
      ]);
      expect(String(res.contents[0]?.text)).toContain(
        `${origin}/k/token-acme-abc123/components/actions/Button/preview.html`,
      );
      expect(res.contents[0]?._meta).toMatchObject({
        ui: { csp: { frameDomains: [origin] } },
        "openai/widgetCSP": { frame_domains: [origin] },
      });
    } finally {
      await rm(kitsRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the requested kit root is a symlink rejected by the broker", async () => {
    const kitsRoot = await mkdtemp(join(tmpdir(), "genie-grid-linked-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "genie-grid-outside-root-"));
    const secret = "<p>OUTSIDE_SECRET</p>";
    try {
      const previewPath = join(outsideRoot, "components", "actions", "Button");
      await mkdir(previewPath, { recursive: true });
      await writeFile(join(previewPath, "preview.html"), secret);
      await symlink(outsideRoot, join(kitsRoot, "acme-abc123"));

      const { broker, registrations } = fakeCardAssetBroker(5199);
      let compileCalls = 0;
      const server = new McpServer({ name: "t", version: "0" });
      registerGridResource(server, {
        kitsRoot,
        compile: async () => {
          compileCalls += 1;
          return manifest();
        },
        readAsset: fakeAssetReader(),
        previewsBaseUrl: "",
        getCardAssetBroker: async () => broker,
      });
      const client = new Client({ name: "c", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);

      const res = await client.readResource({ uri: gridUri({ kitId: "acme-abc123" }) });
      const html = String(res.contents[0]?.text);
      expect(registrations).toEqual([]);
      expect(compileCalls).toBe(0);
      expect(html).toContain('"components":[]');
      expect(html).not.toContain(secret);
      expect(html).not.toContain(Buffer.from(secret).toString("base64"));
      expect(res.contents[0]?._meta).toMatchObject({
        ui: { csp: { frameDomains: ["http://127.0.0.1:5199"] } },
        "openai/widgetCSP": { frame_domains: ["http://127.0.0.1:5199"] },
      });
    } finally {
      await Promise.all([
        rm(kitsRoot, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("keeps configured remote previews authoritative and never starts the local broker", async () => {
    const { broker } = fakeCardAssetBroker();
    let brokerReads = 0;
    const server = new McpServer({ name: "t", version: "0" });
    registerGridResource(server, {
      kitsRoot: "/kits",
      compile: okCompiler(manifest()),
      readAsset: fakeAssetReader(),
      readPreviewBytes: nullPreviewReader,
      previewsBaseUrl: "https://previews.example.com",
      getCardAssetBroker: async () => {
        brokerReads += 1;
        return broker;
      },
    });
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const res = await client.readResource({ uri: gridUri({ kitId: "acme-abc123" }) });
    expect(brokerReads).toBe(0);
    expect(String(res.contents[0]?.text)).toContain(
      "https://previews.example.com/acme-abc123/components/actions/Button/preview.html",
    );
    expect(res.contents[0]?._meta).toMatchObject({
      ui: { csp: { frameDomains: ["https://previews.example.com"] } },
      "openai/widgetCSP": { frame_domains: ["https://previews.example.com"] },
    });
  });

  it("keeps sibling viewer.js / viewer.css resources available for compatibility", async () => {
    const { client } = await connectedClient(okCompiler(manifest()));
    const js = await client.readResource({ uri: VIEWER_JS_URI });
    const css = await client.readResource({ uri: VIEWER_CSS_URI });
    expect(js.contents[0]?.mimeType).toBe("text/javascript");
    expect(String(js.contents[0]?.text)).toContain("viewer.js");
    expect(css.contents[0]?.mimeType).toBe("text/css");
  });
});
