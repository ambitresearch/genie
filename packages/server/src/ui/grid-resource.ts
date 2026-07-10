/**
 * MCP-Apps resource: `ui://genie/grid` (M4-06 / DRO-268).
 *
 * Registers the embedded preview surface a `ui://`-capable harness (Claude,
 * VS Code ≥Jan 2026, ChatGPT, Cursor, …) renders inside its own sandboxed
 * iframe. The `preview` tool (M4-05 / DRO-267) only emits the *pointer*
 * (`_meta.ui.resourceUri: "ui://genie/grid?kitId=…"`); THIS module answers the
 * subsequent `resources/read` for that URI.
 *
 * ── Contract (this issue's AC1–AC6; RFC §6.5) ────────────────────────────────
 *   AC1  register `ui://genie/grid`, MIME `text/html;profile=mcp-app`.
 *   AC2  handler resolves `?kitId=…`, compiles the manifest (M3-03), inlines it
 *        as `<script type="application/json" id="manifest">…</script>` — the
 *        sandboxed iframe needs NO fetch (its CSP is `connect-src 'none'`).
 *   AC3  the HTML keeps RELATIVE `./viewer.js` / `./viewer.css`, served as
 *        sibling `ui://genie/viewer.js` / `ui://genie/viewer.css` resources.
 *   AC4  each card's iframe `src` is rewritten to an absolute `https://` URL on
 *        a separate-origin previews host, or (solo dev) a `data:` inline URL.
 *   AC5  the CSP allow-list (`connectDomains` / `resourceDomains` /
 *        `frameDomains`, plus a concrete `policy` string) is declared in the
 *        resource `_meta`.
 *   (AC6 — `_meta["openai/outputTemplate"]` on the *tool* result — lives on the
 *   `preview` tool in `../tools/preview.ts`, not here.)
 *
 * ── Deviation from the issue's Implementation Notes (flagged for review) ──────
 * The notes say "Use `@modelcontextprotocol/ext-apps/server`". That package is
 * NOT installed in this repo (only `@modelcontextprotocol/sdk@^1.29`), so this
 * module registers through the SDK's own `server.registerResource`. The
 * MCP-Apps CSP shape ext-apps would carry is reproduced verbatim in `_meta`
 * (see {@link buildCspMeta}), so an ext-apps adoption later is a lift-and-shift,
 * not a rewrite.
 *
 * ── AC3-vs-RFC note ──────────────────────────────────────────────────────────
 * The RFC §6.5 sketch inlines viewer.js/.css into ONE document. This issue's
 * AC3 instead mandates RELATIVE asset paths loaded as sibling resources, and
 * AC5 mandates the MCP-Apps domain allow-list — i.e. the app loads its own
 * sub-resources from `resourceDomains`. We follow the ACs (the binding contract
 * for this issue); the manifest is still inlined (AC2), so `connect-src 'none'`
 * holds and the iframe issues zero `fetch()`.
 *
 * ── Byte-identical cards (RFC G-5) ───────────────────────────────────────────
 * Only the card *transport* differs per vehicle: `file://`/localhost fetch the
 * manifest and use relative preview paths; the embedded `ui://` tier inlines
 * the manifest and rewrites each preview path to an absolute/`data:` URL (AC4).
 * The preview HTML bytes themselves are untouched — the card renders identically
 * in all three vehicles.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { compileManifest, type Manifest, type ManifestCard } from "../manifest/index.js";
import { KIT_ID_PATTERN } from "../tools/get_kit.js";

// ─── Public constants (AC1) ──────────────────────────────────────────────────

/** The embedded preview resource URI (bare; `preview` appends `?kitId=…`). */
export const GRID_RESOURCE_URI = "ui://genie/grid";

/** The spec-mandated MCP-Apps MIME (stable spec 2026-01-26; RFC §6.5). */
export const GRID_RESOURCE_MIME = "text/html;profile=mcp-app";

/** The DOM id `viewer.js` reads the inlined manifest from (must match it). */
export const MANIFEST_ELEMENT_ID = "manifest";

/** Sibling asset URIs the relative `./viewer.js` / `./viewer.css` resolve to. */
export const VIEWER_JS_URI = "ui://genie/viewer.js";
export const VIEWER_CSS_URI = "ui://genie/viewer.css";

/** The `ui://` origin the app's own sub-resources are served from (AC5). */
export const RESOURCE_ORIGIN = "ui://genie";

// ─── Injectable seams (keep the server core free of a hard viewer/fs edge) ────

/** Compiles the on-disk kit at `kitDir` to a manifest (default: M3-03). */
export type ManifestCompiler = (kitDir: string) => Promise<Manifest>;

/** The three static assets the embedded shell is assembled from. */
export type ViewerAssetName = "index.html" | "viewer.js" | "viewer.css";

/** Reads one `@genie/viewer` static asset's text (default: from disk). */
export type AssetReader = (name: ViewerAssetName) => Promise<string>;

/** Reads a preview file's raw bytes for the `data:` fallback, or null. */
export type PreviewReader = (kitDir: string, relPath: string) => Promise<Buffer | null>;

/** Embedded transport card: stable kit identity plus its vehicle-specific URL. */
export interface EmbeddedManifestCard extends ManifestCard {
  sourcePath: string;
}

/** Manifest shape inlined into the embedded viewer document. */
export interface EmbeddedManifest extends Omit<Manifest, "components"> {
  components: EmbeddedManifestCard[];
}

/** Options for {@link registerGridResource}. Every collaborator is injectable. */
export interface GridResourceOptions {
  /** Kits root — the same value the kit verbs + `preview` resolve against. */
  kitsRoot: string;
  /** Manifest compiler seam (default wraps M3-03 `compileManifest`). */
  compile?: ManifestCompiler;
  /** Static-asset reader seam (default reads `@genie/viewer/static`). */
  readAsset?: AssetReader;
  /** Preview-bytes reader for the `data:` fallback (default reads from disk). */
  readPreviewBytes?: PreviewReader;
  /**
   * Separate-origin previews host base URL for AC4 (e.g.
   * `https://previews.example.com`). When set, each card iframe `src` becomes
   * `${base}/${kitId}/${card.path}`. When absent (solo dev), the handler falls
   * back to a `data:text/html;base64,…` inline URL built from the preview's
   * bytes. Defaults to `process.env.GENIE_PREVIEWS_BASE_URL`.
   */
  previewsBaseUrl?: string;
}

// ─── kitId → kit dir (path-traversal guard, shared with `preview`) ────────────

/**
 * Resolve `kitId` to its on-disk dir under `kitsRoot`, or `null` when the id is
 * absent or fails {@link KIT_ID_PATTERN}. Returning `null` (rather than
 * throwing) lets the handler degrade to an EMPTY grid instead of erroring a
 * host's `resources/read` — a hostile or malformed `kitId` can never escape the
 * kits root (RFC §10 T-13, the same guard `preview`/`read_file` apply).
 */
export function resolveKitDir(kitsRoot: string, kitId: string | undefined): string | null {
  if (kitId === undefined || !KIT_ID_PATTERN.test(kitId)) return null;
  return join(kitsRoot, kitId);
}

// ─── AC2 manifest filter ─────────────────────────────────────────────────────

/**
 * Narrow a manifest to an optional single component and/or group (the
 * `componentName` / `group` query params `preview` forwards). Exact,
 * case-sensitive matches — the fuzzy substring search is the viewer's job
 * (`#q`); this pre-filter is deterministic so the inlined payload is stable for
 * a given URI. `groups` is recomputed from what survives so no empty section is
 * inlined. A filter that matches nothing yields an empty-but-valid manifest
 * (the viewer renders its empty state).
 */
export function filterManifest(
  manifest: Manifest,
  filter: { componentName?: string; group?: string },
): Manifest {
  const { componentName, group } = filter;
  if (componentName === undefined && group === undefined) return manifest;

  const components = manifest.components.filter(
    (c) =>
      (group === undefined || c.group === group) &&
      (componentName === undefined || c.name === componentName),
  );
  const survivingGroups = new Set(components.map((c) => c.group));
  return {
    ...manifest,
    groups: manifest.groups.filter((g) => survivingGroups.has(g)),
    components,
  };
}

// ─── AC4 card `src` rewrite (byte-identical content; transport differs) ───────

/**
 * Validate + normalise a configured previews base URL. Returns the parsed
 * `URL` (its `href` forced to end in `/` so a later relative-join appends
 * rather than replacing the last path segment) when `raw` is a well-formed
 * ABSOLUTE `http(s)` URL, else `undefined`. A malformed value (a bare host, a
 * typo, a non-http scheme) degrades to `undefined` — the caller then falls
 * back to the solo-dev `data:` transport instead of throwing. Centralising the
 * one `new URL()` parse here is what keeps `rewriteCardPaths` /`buildCspMeta`
 * from crashing `resources/read` or server startup on bad config (the exact
 * failure the reviewer flagged): validate once, branch on the result.
 */
export function normalizePreviewsBaseUrl(raw: string | undefined): URL | undefined {
  if (raw === undefined || raw === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

/**
 * Preserve every card's kit-relative identity as `sourcePath`, then rewrite
 * `path` to the URL the EMBEDDED tier's iframe should load (AC4). With a valid
 * `previewsBaseUrl`, that's an absolute `https://` URL on
 * the separate previews origin (`${base}/${kitId}/${path}`) — the cross-origin
 * isolation the RFC §6/T-09 recommends. Without one — OR when the configured
 * base URL is malformed (see {@link normalizePreviewsBaseUrl}) — the preview's
 * bytes are read and encoded as a `data:text/html;base64,…` URL so the grid is
 * fully self-contained. A preview whose bytes can't be read keeps its relative
 * `path` (harmless: that card simply won't resolve in the embedded tier — a
 * strictly better degradation than dropping the card).
 *
 * Card CONTENT is never altered here — only the URL the iframe points at — so
 * the card stays byte-identical to the `file://`/localhost vehicles (G-5).
 */
export async function rewriteCardPaths(
  manifest: Manifest,
  opts: {
    kitId: string;
    kitDir: string;
    previewsBaseUrl?: string;
    readPreviewBytes: PreviewReader;
  },
): Promise<EmbeddedManifest> {
  const { kitId, kitDir, previewsBaseUrl, readPreviewBytes } = opts;

  // Validate the previews base URL ONCE up front; a malformed value degrades to
  // the solo-dev `data:` path rather than throwing per-card.
  const base = normalizePreviewsBaseUrl(previewsBaseUrl);

  const components = await Promise.all(
    manifest.components.map(async (card) => {
      const sourcePath = card.path;
      if (base !== undefined) {
        // Absolute https:// on the separate previews origin. `base` already ends
        // in `/` (normalizePreviewsBaseUrl) so the kitId segment is appended,
        // not replacing the last path part; `URL` percent-encodes the join.
        const src = new URL(`${encodeURIComponent(kitId)}/${card.path}`, base).toString();
        return { ...card, sourcePath, path: src };
      }
      // Solo-dev fallback: inline the preview bytes as a data: URL.
      const bytes = await readPreviewBytes(kitDir, card.path);
      if (bytes === null) return { ...card, sourcePath }; // keep relative path; degrade gracefully
      const src = `data:text/html;base64,${bytes.toString("base64")}`;
      return { ...card, sourcePath, path: src };
    }),
  );

  return { ...manifest, components };
}

// ─── AC2 manifest inlining (XSS-safe) ────────────────────────────────────────

/**
 * Escape a JSON string for safe embedding inside `<script type="application/
 * json">`. In JSON, `<`/`>`/`&` only ever occur INSIDE string literals, so
 * replacing them with their `\uXXXX` escapes yields equivalent, still-valid
 * JSON that no HTML parser can misread as a `</script>` terminator or a comment
 * (`<!--`). U+2028/U+2029 are escaped too (defensive; they're legal in JSON but
 * not in JS string literals, and some embedders re-parse). This is the
 * canonical safe-embedding transform.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Inject the compiled manifest into the viewer's `index.html` as an inline
 * `<script type="application/json" id="manifest">` (AC2), placed just before
 * `</head>` so it parses before `viewer.js` runs. If no `</head>` is present
 * (defensive — the shipped shell always has one) the script is prepended, which
 * still parses before the body script. The manifest is JSON-escaped so a
 * hostile component name/path can't break out of the script element.
 */
export function inlineManifest(indexHtml: string, manifest: Manifest): string {
  const json = escapeJsonForScript(JSON.stringify(manifest));
  const tag = `<script type="application/json" id="${MANIFEST_ELEMENT_ID}">${json}</script>`;
  const headClose = indexHtml.indexOf("</head>");
  if (headClose === -1) return tag + indexHtml;
  return indexHtml.slice(0, headClose) + tag + indexHtml.slice(headClose);
}

// ─── AC5 CSP allow-list ──────────────────────────────────────────────────────

/** The MCP-Apps CSP allow-list carried on the resource `_meta` (AC5). */
export interface GridCspMeta {
  /** `fetch()`/XHR targets — empty: the manifest is inlined, nothing to fetch. */
  connectDomains: string[];
  /** Origins the app loads its OWN sub-resources (viewer.js/.css) from. */
  resourceDomains: string[];
  /** Origins allowed as per-card iframe sources (the previews host or `data:`). */
  frameDomains: string[];
  /** A concrete CSP header string derived from the allow-list (RFC §6.5). */
  policy: string;
}

/**
 * Build the AC5 CSP allow-list for a given previews configuration. The card
 * iframes load from the previews origin when configured, else from `data:`
 * (solo dev). `connectDomains` is always empty — `connect-src 'none'` — because
 * the manifest travels inline (AC2); there is nothing to fetch. `img-src`
 * permits `data:`/`https:` for card thumbnails. This is the shape
 * `@modelcontextprotocol/ext-apps` would carry; reproduced here since that dep
 * is absent (see module header).
 */
export function buildCspMeta(previewsBaseUrl: string | undefined): GridCspMeta {
  // Validate via the shared normaliser so a malformed GENIE_PREVIEWS_BASE_URL
  // NEVER throws here — an invalid value degrades to the solo-dev `data:` frame
  // origin exactly as `rewriteCardPaths` does, keeping the two in lockstep and
  // never crashing `registerGridResource`/server startup (reviewer flag).
  const base = normalizePreviewsBaseUrl(previewsBaseUrl);
  const frameDomains = base !== undefined ? [base.origin] : ["data:"];
  const resourceDomains = [RESOURCE_ORIGIN];
  const frameSrc = frameDomains.join(" ");
  const resourceSrc = resourceDomains.join(" ");
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resourceSrc}`,
    `style-src 'unsafe-inline' ${resourceSrc}`,
    "img-src data: https:",
    `frame-src ${frameSrc}`,
    "connect-src 'none'",
  ].join("; ");
  return { connectDomains: [], resourceDomains, frameDomains, policy };
}

/** The `_meta` object attached to the grid resource (namespaced; provisional). */
export function gridResourceMeta(previewsBaseUrl: string | undefined): Record<string, unknown> {
  // Namespace is provisional pending an `@modelcontextprotocol/ext-apps`
  // adoption, which would define the canonical key. Kept descriptive so a
  // reviewer/host can find it. Both a structured allow-list AND a concrete
  // policy string are exposed so either consumption style works.
  return { "mcp-app/csp": buildCspMeta(previewsBaseUrl) };
}

// ─── Default seams ───────────────────────────────────────────────────────────

/** Default compiler: the real M3-03 walk (returns just the manifest). */
const defaultCompile: ManifestCompiler = async (kitDir) => {
  const { manifest } = await compileManifest(kitDir);
  return manifest;
};

/**
 * Default asset reader: locate `@genie/viewer`'s `static/` dir by RESOLVING its
 * `package.json` (a resolution, not an import — so this file carries no
 * build-time edge to the viewer package, mirroring `preview.ts`'s optional-peer
 * pattern) and read the named file. Results are cached per process. A failure
 * (viewer package unresolvable) rejects — the handler turns that into a minimal
 * self-describing shell so a `resources/read` never hard-fails.
 */
function makeDefaultAssetReader(): AssetReader {
  const cache = new Map<ViewerAssetName, string>();
  const require = createRequire(import.meta.url);
  return async (name) => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const pkgJson = require.resolve("@genie/viewer/package.json");
    const staticDir = resolve(dirname(pkgJson), "static");
    const text = await readFile(join(staticDir, name), "utf8");
    cache.set(name, text);
    return text;
  };
}

/** Default preview reader: read `join(kitDir, relPath)`; null on any error. */
const defaultReadPreviewBytes: PreviewReader = async (kitDir, relPath) => {
  try {
    // `relPath` originates from the compiled manifest (already inside the kit);
    // still re-check containment defensively before reading. Uses the SAME
    // segment-aware guard as `store/local.ts`'s `safePath` (path.relative + sep
    // + isAbsolute) rather than a `startsWith(root + "/")` prefix test, which
    // is wrong on Windows (`\` separator) and can false-negative a legitimate
    // sibling dir sharing a name prefix.
    const root = resolve(kitDir);
    const abs = resolve(root, relPath);
    if (!isInside(root, abs)) return null;
    return await readFile(abs);
  } catch {
    return null;
  }
};

/**
 * True when `child` is `parent` itself or a descendant of it, using the
 * repo's established segment-aware containment test (mirrors `safePath` in
 * `store/local.ts`): the relative path escapes only when it IS `..`, starts
 * with `..` + a path separator, or is absolute. Cross-platform (honours the
 * OS `sep`), unlike a `startsWith(parent + "/")` prefix check.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true; // child === parent
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/** A minimal, dependency-free shell used only when the viewer assets can't be
 * read — keeps `resources/read` answering with valid HTML rather than erroring. */
function fallbackShell(manifest: Manifest): string {
  const json = escapeJsonForScript(JSON.stringify(manifest));
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    `<title>genie — preview</title>` +
    `<script type="application/json" id="${MANIFEST_ELEMENT_ID}">${json}</script>` +
    '</head><body><main id="grid"></main>' +
    "<p>genie viewer assets unavailable in this environment.</p>" +
    "</body></html>"
  );
}

// ─── Core: assemble the embedded HTML ────────────────────────────────────────

/** Fully-resolved dependencies for {@link buildGridDocument}. */
interface ResolvedDeps {
  kitsRoot: string;
  compile: ManifestCompiler;
  readAsset: AssetReader;
  readPreviewBytes: PreviewReader;
  previewsBaseUrl: string | undefined;
}

/**
 * Produce the embedded grid HTML for a resource URI's query params. Resolves
 * the kit (path-guarded), compiles + filters the manifest, rewrites card paths
 * for the embedded tier (AC4), and inlines the result into the viewer shell
 * (AC2/AC3). Every failure mode degrades to a still-valid document: an absent/
 * invalid `kitId` or an uncompilable kit yields an EMPTY manifest (the viewer's
 * empty state); unreadable viewer assets yield the {@link fallbackShell}.
 */
export async function buildGridDocument(
  deps: ResolvedDeps,
  params: { kitId?: string; componentName?: string; group?: string },
): Promise<string> {
  const kitDir = resolveKitDir(deps.kitsRoot, params.kitId);

  let manifest: Manifest = emptyManifest();
  if (kitDir !== null) {
    try {
      manifest = await deps.compile(kitDir);
    } catch {
      manifest = emptyManifest(); // uncompiled/missing kit → empty grid, not an error
    }
    manifest = filterManifest(manifest, {
      componentName: params.componentName,
      group: params.group,
    });
    manifest = await rewriteCardPaths(manifest, {
      kitId: params.kitId as string, // non-null: resolveKitDir only returns a dir for a valid id
      kitDir,
      previewsBaseUrl: deps.previewsBaseUrl,
      readPreviewBytes: deps.readPreviewBytes,
    });
  }

  let indexHtml: string;
  try {
    indexHtml = await deps.readAsset("index.html");
  } catch {
    return fallbackShell(manifest);
  }
  return inlineManifest(indexHtml, manifest);
}

/** An empty-but-valid manifest (viewer renders its empty state). */
function emptyManifest(): Manifest {
  return { version: 1, name: "", generatedAt: "", groups: [], components: [] };
}

// ─── MCP registration (AC1 + AC3) ────────────────────────────────────────────

/** Parse the three recognised query params off a resolved resource `URL`. */
function paramsFromUri(uri: URL): { kitId?: string; componentName?: string; group?: string } {
  const get = (k: string): string | undefined => uri.searchParams.get(k) ?? undefined;
  return { kitId: get("kitId"), componentName: get("componentName"), group: get("group") };
}

/**
 * Register `ui://genie/grid` and its sibling assets on `server`.
 *
 * Routing (verified against the installed SDK): the SDK matches a static
 * resource by EXACT `uri.toString()` and a template via `UriTemplate.match`.
 * `preview` emits `ui://genie/grid?kitId=…` with optional extra params, so a
 * single static registration (no query) or a rigid `{?kitId,…}` template (all-
 * or-nothing) would miss most real URIs. We therefore register BOTH a static
 * `ui://genie/grid` (the bare URI) and a `{+rest}` catch-all template that
 * matches any query-bearing URI; both dispatch to the same handler, which reads
 * its params off the full `URL`. The two sibling assets (AC3) are plain statics.
 */
export function registerGridResource(server: McpServer, options: GridResourceOptions): void {
  const deps: ResolvedDeps = {
    kitsRoot: options.kitsRoot,
    compile: options.compile ?? defaultCompile,
    readAsset: options.readAsset ?? makeDefaultAssetReader(),
    readPreviewBytes: options.readPreviewBytes ?? defaultReadPreviewBytes,
    previewsBaseUrl: options.previewsBaseUrl ?? process.env.GENIE_PREVIEWS_BASE_URL,
  };

  const meta = gridResourceMeta(deps.previewsBaseUrl);
  const gridConfig = {
    title: "genie preview grid",
    description:
      "Embedded MCP-Apps preview of a genie UI kit — a card grid rendered inside " +
      "the host's sandboxed iframe. Referenced by the `preview` tool's " +
      "_meta.ui.resourceUri.",
    mimeType: GRID_RESOURCE_MIME,
    _meta: meta,
  };

  const readGrid = async (uri: URL): Promise<ReadResourceResult> => {
    const html = await buildGridDocument(deps, paramsFromUri(uri));
    return {
      contents: [{ uri: uri.toString(), mimeType: GRID_RESOURCE_MIME, text: html, _meta: meta }],
    };
  };

  // Bare URI (exact match) — e.g. a host that reads `ui://genie/grid` directly.
  server.registerResource("genie-grid", GRID_RESOURCE_URI, gridConfig, (uri) => readGrid(uri));

  // Query-bearing URIs (`?kitId=…[&componentName=…][&group=…]`) via a catch-all
  // template. `list: undefined` — the bare static above is what `resources/list`
  // advertises; the template is a routing device, not a discoverable resource.
  const template = new ResourceTemplate(`${GRID_RESOURCE_URI}{+rest}`, { list: undefined });
  server.registerResource("genie-grid-query", template, gridConfig, (uri) => readGrid(uri));

  // AC3 — the relative `./viewer.js` / `./viewer.css` in the shell resolve to
  // these siblings; the host reads them from the same resource handler.
  registerAsset(server, "genie-viewer-js", VIEWER_JS_URI, "text/javascript", () =>
    deps.readAsset("viewer.js"),
  );
  registerAsset(server, "genie-viewer-css", VIEWER_CSS_URI, "text/css", () =>
    deps.readAsset("viewer.css"),
  );
}

/** Register one static text asset resource (viewer.js / viewer.css). */
function registerAsset(
  server: McpServer,
  name: string,
  uri: string,
  mimeType: string,
  read: () => Promise<string>,
): void {
  server.registerResource(
    name,
    uri,
    { title: name, mimeType },
    async (u): Promise<ReadResourceResult> => {
      const text = await read();
      return { contents: [{ uri: u.toString(), mimeType, text }] };
    },
  );
}
