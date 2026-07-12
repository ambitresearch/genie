/**
 * MCP-Apps resource: `ui://genie/grid` (M4-06 / DRO-268).
 *
 * Registers the embedded preview surface a `ui://`-capable harness (Claude,
 * VS Code ≥Jan 2026, ChatGPT, Cursor, …) renders inside its own sandboxed
 * iframe. The `preview` tool (M4-05 / DRO-267) advertises the bare URI as its
 * standards-compliant app shell and retains a query-bearing result URI for
 * legacy hosts. THIS module answers both resource forms.
 *
 * ── Contract (this issue's AC1–AC6; RFC §6.5) ────────────────────────────────
 *   AC1  register `ui://genie/grid`, MIME `text/html;profile=mcp-app`.
 *   AC2  handler resolves `?kitId=…`, compiles the manifest (M3-03), inlines it
 *        as `<script type="application/json" id="manifest">…</script>` — the
 *        sandboxed iframe needs NO fetch (its CSP is `connect-src 'none'`).
 *   AC3  viewer.js / viewer.css are inlined byte-for-byte into the one raw HTML
 *        resource a compliant MCP Apps host sends to its sandbox proxy.
 *   AC4  each card's iframe `src` is rewritten to an absolute `https://` URL on
 *        a separate-origin previews host, or (solo dev) a `data:` inline URL.
 *   AC5  the CSP allow-list (`connectDomains` / `resourceDomains` /
 *        `frameDomains`) is declared at canonical `_meta.ui.csp`.
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
 * ── Self-contained host contract ──────────────────────────────────────────────
 * MCP Apps hosts receive raw HTML in `resources/read` and do not translate
 * browser-relative URLs into additional MCP resource reads. The shipped shell's
 * relative asset tags are therefore replaced with exact inline bytes, each
 * allow-listed by SHA-256 in the injected CSP. Sibling resources remain
 * registered only for backwards compatibility with older host experiments.
 *
 * ── Byte-identical cards (RFC G-5) ───────────────────────────────────────────
 * Only the card *transport* differs per vehicle: `file://`/localhost fetch the
 * manifest and use relative preview paths; the embedded `ui://` tier inlines
 * the manifest and rewrites each preview path to an absolute/`data:` URL (AC4).
 * The preview HTML bytes themselves are untouched — the card renders identically
 * in all three vehicles.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { parse } from "parse5";

import { ensureManifest, type Manifest, type ManifestCard } from "../manifest/index.js";
import { KIT_ID_PATTERN } from "../tools/get_kit.js";
import type { CardAssetBroker, CardAssetKit } from "./card-asset-broker.js";

// ─── Public constants (AC1) ──────────────────────────────────────────────────

/**
 * The embedded preview resource URI. `v` identifies the wire contract while
 * the process-scoped nonce prevents hosts from reusing a stale app document
 * after the MCP server restarts. It remains stable for every read in one
 * process, so resource registration and tool metadata always agree.
 */
export const GRID_RESOURCE_URI = `ui://genie/grid?v=2&instance=${randomBytes(16).toString("hex")}`;

/** The spec-mandated MCP-Apps MIME (stable spec 2026-01-26; RFC §6.5). */
export const GRID_RESOURCE_MIME = "text/html;profile=mcp-app";

/** The DOM id `viewer.js` reads the inlined manifest from (must match it). */
export const MANIFEST_ELEMENT_ID = "manifest";
export const TOOL_RESULT_SHELL_META = "genie-tool-result-shell";

/** Legacy sibling asset URIs retained for older experimental hosts. */
export const VIEWER_JS_URI = "ui://genie/viewer.js";
export const VIEWER_CSS_URI = "ui://genie/viewer.css";

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

/** Exact CSP hashes for trusted inline executable/style blocks. */
export interface InlineCspHashes {
  scriptHashes: string[];
  styleHashes: string[];
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
  /**
   * Lazily resolves the process-scoped local card broker used by UI-capable
   * hosts. Omit this seam for legacy/unit callers that require the self-
   * contained `data:` fallback.
   */
  getCardAssetBroker?: () => Promise<CardAssetBroker>;
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
    cardAssetKit?: CardAssetKit;
    onPreviewHtml?: (html: string) => void;
  },
): Promise<EmbeddedManifest> {
  const { kitId, kitDir, previewsBaseUrl, readPreviewBytes, cardAssetKit, onPreviewHtml } = opts;

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
      if (cardAssetKit !== undefined) {
        return { ...card, sourcePath, path: cardAssetKit.urlFor(card.path) };
      }
      // Solo-dev fallback: inline the preview bytes as a data: URL.
      const bytes = await readPreviewBytes(kitDir, card.path);
      if (bytes === null) return { ...card, sourcePath }; // keep relative path; degrade gracefully
      onPreviewHtml?.(bytes.toString("utf8"));
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

interface ParsedHtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedHtmlNode[];
}

function cspSha256(content: string): string {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

function rawText(node: ParsedHtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(rawText).join("");
}

/**
 * Parse HTML and hash its trusted inline `<script>` / `<style>` text exactly as
 * the browser sees it. External scripts have no inline bytes and are ignored.
 */
export function collectInlineCspHashes(html: string): InlineCspHashes {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  const root = parse(html) as unknown as ParsedHtmlNode;

  function visit(node: ParsedHtmlNode): void {
    if (node.tagName === "script") {
      const hasSrc = node.attrs?.some((attr) => attr.name.toLowerCase() === "src") ?? false;
      const content = rawText(node);
      if (!hasSrc && content !== "") scripts.add(cspSha256(content));
    } else if (node.tagName === "style") {
      const content = rawText(node);
      if (content !== "") styles.add(cspSha256(content));
    }
    for (const child of node.childNodes ?? []) visit(child);
  }

  visit(root);
  return { scriptHashes: [...scripts], styleHashes: [...styles] };
}

function escapeRawTextEndTag(content: string, tagName: "script" | "style"): string {
  return content.replace(new RegExp(`</${tagName}`, "gi"), `<\\/${tagName}`);
}

/**
 * Make the MCP App document self-contained. A host receives one raw HTML
 * resource; browser-relative `ui://` siblings are not additional resources/read
 * calls, so the exact viewer JS/CSS bytes must travel inside that document.
 */
export function inlineViewerAssets(
  indexHtml: string,
  viewerJs: string,
  viewerCss: string,
): { html: string; hashes: InlineCspHashes } {
  const script = escapeRawTextEndTag(viewerJs, "script");
  const style = escapeRawTextEndTag(viewerCss, "style");
  const styleTag = `<style>${style}</style>`;
  const scriptTag = `<script>${script}</script>`;

  const cssLink = /<link\b[^>]*href=["']\.\/viewer\.css["'][^>]*>/i;
  const jsScript = /<script\b[^>]*src=["']\.\/viewer\.js["'][^>]*><\/script>/i;
  let html = cssLink.test(indexHtml)
    ? indexHtml.replace(cssLink, styleTag)
    : injectBeforeClosingTag(indexHtml, "head", styleTag);
  html = jsScript.test(html)
    ? html.replace(jsScript, scriptTag)
    : injectBeforeClosingTag(html, "body", scriptTag);

  return {
    html,
    hashes: {
      scriptHashes: [cspSha256(script)],
      styleHashes: [cspSha256(style)],
    },
  };
}

function injectBeforeClosingTag(html: string, tagName: "head" | "body", content: string): string {
  const close = `</${tagName}>`;
  const at = html.indexOf(close);
  return at === -1 ? html + content : html.slice(0, at) + content + html.slice(at);
}

// ─── AC5 CSP allow-list ──────────────────────────────────────────────────────

/**
 * MCP Apps domain declarations plus genie's stricter in-document CSP.
 * Resources/read cannot deliver an HTTP response header; compliant hosts build
 * their sandbox CSP from the domain arrays under `_meta.ui.csp`.
 */
export interface GridCspMeta {
  /** `fetch()`/XHR targets — empty: the manifest is inlined, nothing to fetch. */
  connectDomains: string[];
  /** External static-resource origins; empty because the document is self-contained. */
  resourceDomains: string[];
  /** Origins allowed as per-card iframe sources (the previews host or `data:`). */
  frameDomains: string[];
  /** Strict hash-based policy injected into the self-contained HTML document. */
  metaPolicy: string;
}

/**
 * Build the AC5 domain allow-list and strict hash-based document policy.
 *
 * The card iframes load from the previews origin when configured, else from
 * `data:` (solo dev). `connectDomains` is always empty — `connect-src 'none'`
 * — because the manifest travels inline (AC2); there is nothing to fetch.
 * `img-src` permits `data:`/`https:` for card thumbnails. The domain shape
 * matches the stable MCP Apps 2026-01-26 `_meta.ui.csp` contract.
 *
 * Hardening applied vs the pre-M4-07 policy:
 *   • Removed `'unsafe-inline'` / `'unsafe-eval'` (AC3). The exact inlined
 *     viewer assets and legitimate inline blocks inside data-backed cards are
 *     allow-listed by SHA-256. Event-handler attributes remain blocked because
 *     the policy does not opt into `'unsafe-hashes'`.
 *   • Added `base-uri 'none'` — no `<base href>` can redirect URLs.
 *   • Added `form-action 'none'` and `object-src 'none'` — deny `<form>` /
 *     `<object>` / `<embed>` per AC1's "deny form/object/embed" line.
 * Resources/read has no HTTP-header channel, so no raw header policy or
 * `frame-ancestors` claim is advertised.
 */
export function buildCspMeta(
  previewsBaseUrl: string | undefined,
  inlineHashes: InlineCspHashes = { scriptHashes: [], styleHashes: [] },
  exactFrameDomains?: readonly string[],
): GridCspMeta {
  // Validate via the shared normaliser so a malformed GENIE_PREVIEWS_BASE_URL
  // NEVER throws here — an invalid value degrades to the solo-dev `data:` frame
  // origin exactly as `rewriteCardPaths` does, keeping the two in lockstep and
  // never crashing `registerGridResource`/server startup (reviewer flag).
  const base = normalizePreviewsBaseUrl(previewsBaseUrl);
  const frameDomains =
    base !== undefined
      ? [base.origin]
      : exactFrameDomains === undefined
        ? ["data:"]
        : [...new Set(exactFrameDomains)];
  const resourceDomains: string[] = [];
  const frameSrc = frameDomains.length === 0 ? "'none'" : frameDomains.join(" ");
  const scriptHashes = validCspHashes(inlineHashes.scriptHashes);
  const styleHashes = validCspHashes(inlineHashes.styleHashes);
  const scriptSrc = scriptHashes.length > 0 ? scriptHashes.join(" ") : "'none'";
  const styleSrc = styleHashes.length > 0 ? styleHashes.join(" ") : "'none'";

  const core = [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src data: https:",
    `frame-src ${frameSrc}`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];

  const metaPolicy = core.join("; ");
  return { connectDomains: [], resourceDomains, frameDomains, metaPolicy };
}

function validCspHashes(hashes: string[]): string[] {
  return [...new Set(hashes.filter((hash) => /^'sha256-[A-Za-z0-9+/]+={0,2}'$/.test(hash)))];
}

/**
 * Render a `<meta http-equiv="Content-Security-Policy" content="…">` tag for
 * the given policy meta. Uses {@link GridCspMeta.metaPolicy}.
 *
 * The `content` attribute value is HTML-attribute-escaped (`&`, `"`, `<`, `>`)
 * defensively. In current use the policy string is server-authored with no
 * user input, so the escape is defence-in-depth against a future change that
 * accidentally embeds a `"` — without it the attribute would terminate early
 * and the policy would silently degrade.
 */
export function cspMetaTag(meta: GridCspMeta): string {
  const attr = escapeHtmlAttribute(meta.metaPolicy);
  return `<meta http-equiv="Content-Security-Policy" content="${attr}">`;
}

/**
 * Escape a string for safe embedding inside a `"`-quoted HTML attribute value.
 * Handles the four characters `&` (must be first, else it double-escapes
 * subsequent `&`s), `"` (attribute delimiter), `<`, `>`. Defence-in-depth for
 * {@link cspMetaTag} — the policy is server-authored today, but a future
 * directive that legitimately contains a `"` (e.g. a hostname in quotes) must
 * not break the attribute.
 */
function escapeHtmlAttribute(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Inject the enforced CSP meta into an assembled document. Placed at the very
 * top of `<head>` so every subsequent element — the manifest data island,
 * inlined `viewer.js`/`viewer.css`, any inline attributes — is parsed under
 * the policy. If the shell has no `<head>` (defensive; every shipped shell
 * does) the tag is prepended so it still parses first.
 */
export function injectCspMeta(html: string, meta: GridCspMeta): string {
  const tag = cspMetaTag(meta);
  const headOpen = html.indexOf("<head>");
  if (headOpen === -1) return tag + html;
  return html.slice(0, headOpen + "<head>".length) + tag + html.slice(headOpen + "<head>".length);
}

/** Canonical MCP Apps resource metadata (stable 2026-01-26 shape). */
export function gridResourceMeta(
  previewsBaseUrl: string | undefined,
  exactFrameDomains?: readonly string[],
): Record<string, unknown> {
  const { connectDomains, resourceDomains, frameDomains } = buildCspMeta(
    previewsBaseUrl,
    undefined,
    exactFrameDomains,
  );
  return {
    ui: { csp: { connectDomains, resourceDomains, frameDomains } },
    "openai/widgetCSP": {
      connect_domains: connectDomains,
      resource_domains: resourceDomains,
      frame_domains: frameDomains,
    },
  };
}

// ─── Default seams ───────────────────────────────────────────────────────────

/** Default compiler: the shared `ensureManifest` seam (compiles + persists). */
const defaultCompile: ManifestCompiler = async (kitDir) => {
  return ensureManifest(kitDir);
};

/**
 * Default asset reader: prefer the viewer assets copied beside the compiled
 * server module by `copy-viewer-assets.mjs`. This guarantees the published
 * server's tool-result shell remains executable even when `@genie/viewer` is
 * not installed at runtime. Source/tsx development falls back to resolving the
 * workspace viewer package without creating a build-time import edge. Results
 * are cached per process.
 */
function makeDefaultAssetReader(): AssetReader {
  const cache = new Map<ViewerAssetName, string>();
  const require = createRequire(import.meta.url);
  const bundledStaticDir = resolve(dirname(fileURLToPath(import.meta.url)), "viewer-static");
  return async (name) => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    let text: string;
    try {
      text = await readFile(join(bundledStaticDir, name), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const pkgJson = require.resolve("@genie/viewer/package.json");
      const staticDir = resolve(dirname(pkgJson), "static");
      text = await readFile(join(staticDir, name), "utf8");
    }
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

/** A last-resort, dependency-free shell used only when both the packaged assets
 * and source-workspace fallback are unreadable (or a test injects a failing
 * reader). Normal built deployments always carry executable assets beside this
 * module. The emergency shell keeps `resources/read` valid and carries the SAME
 * enforced CSP meta: corruption must not downgrade security (M4-07 AC1). */
function fallbackShell(manifest: Manifest, cspMeta: GridCspMeta): string {
  const json = escapeJsonForScript(JSON.stringify(manifest));
  return (
    '<!doctype html><html lang="en"><head>' +
    cspMetaTag(cspMeta) +
    '<meta charset="utf-8" />' +
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
  getCardAssetBroker?: () => Promise<CardAssetBroker>;
  cardAssetKit?: CardAssetKit;
  exactFrameDomains?: readonly string[];
  denyRequestedKit?: boolean;
}

/**
 * Produce the embedded grid HTML for a resource URI's query params. Resolves
 * the kit (path-guarded), compiles + filters the manifest, rewrites card paths
 * for the embedded tier (AC4), inlines the result into the viewer shell
 * (AC2/AC3), and injects the enforced CSP meta (M4-07 AC1) so browsers apply
 * the hardened policy at parse time. Every failure mode degrades to a still-
 * valid, still-hardened document: an absent/invalid `kitId` or an
 * uncompilable kit yields an EMPTY manifest (the viewer's empty state);
 * unreadable viewer assets yield the {@link fallbackShell} (also CSP-injected).
 */
export async function buildGridDocument(
  deps: ResolvedDeps,
  params: { kitId?: string; componentName?: string; group?: string },
): Promise<string> {
  const kitDir = deps.denyRequestedKit ? null : resolveKitDir(deps.kitsRoot, params.kitId);
  const scriptHashes = new Set<string>();
  const styleHashes = new Set<string>();
  const addHashes = (html: string): void => {
    const hashes = collectInlineCspHashes(html);
    for (const hash of hashes.scriptHashes) scriptHashes.add(hash);
    for (const hash of hashes.styleHashes) styleHashes.add(hash);
  };
  const currentHashes = (): InlineCspHashes => ({
    scriptHashes: [...scriptHashes],
    styleHashes: [...styleHashes],
  });

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
      cardAssetKit: deps.cardAssetKit,
      onPreviewHtml: addHashes,
    });
  }

  let indexHtml: string;
  let viewerJs: string;
  let viewerCss: string;
  try {
    [indexHtml, viewerJs, viewerCss] = await Promise.all([
      deps.readAsset("index.html"),
      deps.readAsset("viewer.js"),
      deps.readAsset("viewer.css"),
    ]);
  } catch {
    const fallback = fallbackShell(
      manifest,
      buildCspMeta(deps.previewsBaseUrl, currentHashes(), deps.exactFrameDomains),
    );
    return params.kitId === undefined ? markToolResultShell(fallback) : fallback;
  }

  const inlinedAssets = inlineViewerAssets(indexHtml, viewerJs, viewerCss);
  for (const hash of inlinedAssets.hashes.scriptHashes) scriptHashes.add(hash);
  for (const hash of inlinedAssets.hashes.styleHashes) styleHashes.add(hash);
  const cspMeta = buildCspMeta(deps.previewsBaseUrl, currentHashes(), deps.exactFrameDomains);
  const document = inlineManifest(inlinedAssets.html, manifest);
  return injectCspMeta(
    params.kitId === undefined ? markToolResultShell(document) : document,
    cspMeta,
  );
}

function markToolResultShell(html: string): string {
  const marker = `<meta name="${TOOL_RESULT_SHELL_META}" content="true">`;
  const headOpen = html.indexOf("<head>");
  if (headOpen === -1) return marker + html;
  return (
    html.slice(0, headOpen + "<head>".length) + marker + html.slice(headOpen + "<head>".length)
  );
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

interface PreparedCardBroker {
  cardAssetKit?: CardAssetKit;
  exactFrameDomains: readonly string[];
  denyRequestedKit?: boolean;
}

async function registerRequestedCardAssetKit(
  broker: CardAssetBroker,
  kitsRoot: string,
  kitId: string,
): Promise<CardAssetKit | undefined> {
  const kitDir = resolveKitDir(kitsRoot, kitId);
  if (kitDir === null) return undefined;
  try {
    const info = await lstat(kitDir);
    if (!info.isDirectory()) return undefined;
    return await broker.registerKit(kitId, kitDir);
  } catch {
    return undefined;
  }
}

async function prepareCardBroker(
  deps: ResolvedDeps,
  params: { kitId?: string },
): Promise<PreparedCardBroker | undefined> {
  if (
    deps.getCardAssetBroker === undefined ||
    normalizePreviewsBaseUrl(deps.previewsBaseUrl) !== undefined
  ) {
    return undefined;
  }

  let broker: CardAssetBroker;
  try {
    broker = await deps.getCardAssetBroker();
  } catch {
    return {
      exactFrameDomains: [],
      denyRequestedKit: params.kitId !== undefined,
    };
  }

  if (params.kitId === undefined) {
    return { exactFrameDomains: broker.frameOrigins() };
  }

  if (!KIT_ID_PATTERN.test(params.kitId)) {
    return { exactFrameDomains: broker.frameOrigins() };
  }
  const cardAssetKit = await registerRequestedCardAssetKit(broker, deps.kitsRoot, params.kitId);
  if (cardAssetKit === undefined) {
    return {
      exactFrameDomains: broker.frameOrigins(),
      denyRequestedKit: true,
    };
  }
  return { cardAssetKit, exactFrameDomains: broker.frameOrigins() };
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
 * its params off the full `URL`. Legacy sibling assets remain plain statics.
 */
export function registerGridResource(server: McpServer, options: GridResourceOptions): void {
  const deps: ResolvedDeps = {
    kitsRoot: options.kitsRoot,
    compile: options.compile ?? defaultCompile,
    readAsset: options.readAsset ?? makeDefaultAssetReader(),
    readPreviewBytes: options.readPreviewBytes ?? defaultReadPreviewBytes,
    previewsBaseUrl: options.previewsBaseUrl ?? process.env.GENIE_PREVIEWS_BASE_URL,
    getCardAssetBroker: options.getCardAssetBroker,
  };

  const hasLocalCardBroker =
    deps.getCardAssetBroker !== undefined &&
    normalizePreviewsBaseUrl(deps.previewsBaseUrl) === undefined;
  // Resource-list metadata is necessarily static. A broker is lazy, so its
  // concrete origins are attached to resources/read after discovery; publish
  // an empty (deny-all) exact list here rather than a wildcard or `data:`.
  const registrationMeta = gridResourceMeta(
    deps.previewsBaseUrl,
    hasLocalCardBroker ? [] : undefined,
  );
  const baseGridConfig = {
    title: "genie preview grid",
    description:
      "Embedded MCP-Apps preview of a genie UI kit — a card grid rendered inside " +
      "the host's sandboxed iframe. Referenced by the `preview` tool's " +
      "_meta.ui.resourceUri.",
    mimeType: GRID_RESOURCE_MIME,
  };

  const readGrid = async (uri: URL): Promise<ReadResourceResult> => {
    const params = paramsFromUri(uri);
    const prepared = await prepareCardBroker(deps, params);
    const readDeps: ResolvedDeps =
      prepared === undefined
        ? deps
        : {
            ...deps,
            cardAssetKit: prepared.cardAssetKit,
            exactFrameDomains: prepared.exactFrameDomains,
            denyRequestedKit: prepared.denyRequestedKit,
          };
    const meta = gridResourceMeta(deps.previewsBaseUrl, prepared?.exactFrameDomains);
    const html = await buildGridDocument(readDeps, params);
    return {
      contents: [{ uri: uri.toString(), mimeType: GRID_RESOURCE_MIME, text: html, _meta: meta }],
    };
  };

  // Bare URI (exact match) — e.g. a host that reads `ui://genie/grid` directly.
  server.registerResource(
    "genie-grid",
    GRID_RESOURCE_URI,
    { ...baseGridConfig, _meta: registrationMeta },
    (uri) => readGrid(uri),
  );

  // Query-bearing URIs (`?kitId=…[&componentName=…][&group=…]`) via a catch-all
  // template. `list: undefined` — the bare static above is what `resources/list`
  // advertises; the template is a routing device, not a discoverable resource.
  const template = new ResourceTemplate(`${GRID_RESOURCE_URI}{+rest}`, { list: undefined });
  server.registerResource(
    "genie-grid-query",
    template,
    { ...baseGridConfig, _meta: registrationMeta },
    (uri) => readGrid(uri),
  );

  // Compatibility for older experimental hosts. The standard MCP Apps payload
  // is self-contained and does not reference these sibling resources.
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
