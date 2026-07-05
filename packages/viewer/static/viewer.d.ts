/**
 * M4-03 (DRO-265) — type surface for the browser-native `viewer.js` grid
 * renderer.
 *
 * `viewer.js` is authored as a real browser ES module (it ships verbatim to the
 * Vite viewer and the `ui://genie/grid` resource), so its types live here in a
 * sibling `.d.ts` rather than as inline TS. `grid-renderer.test.ts` imports
 * from `../static/viewer.js` and picks these up automatically.
 *
 * The shapes mirror the SHIPPED M3-03 manifest
 * (`packages/server/src/manifest/compiler.ts` — `Manifest` / `ManifestCard`):
 * a `components[]` array whose per-card `viewport` is the raw marker STRING,
 * NOT the `cards[]`/`{width,height}` of the issue-body sketch.
 */

/** One compiled component card, as written into `.genie/manifest.json`. */
export interface ManifestCard {
  name: string;
  group: string;
  /** Kit-relative POSIX path to the component's `preview.html`. */
  path: string;
  /** Raw marker token: `"WxH"` (e.g. `"480x240"`) or a named token ("desktop"). */
  viewport: string;
  /** `sha256-<base64>` SRI hash of the preview bytes. */
  hash: string;
  /** ISO-8601 mtime of the preview file. */
  lastModified: string;
  subtitle?: string;
  tags?: string[];
}

/** The full compiled manifest the viewer fetches and renders. */
export interface ViewerManifest {
  version: 1;
  name: string;
  generatedAt: string;
  groups: string[];
  components: ManifestCard[];
}

/** Kit-relative URL of the compiled manifest (`.genie/manifest.json`). */
export declare const MANIFEST_URL: string;

/** Fallback iframe height (px) for a named/unparseable viewport. */
export declare const DEFAULT_CARD_HEIGHT: number;

/** Parse a `"WxH"` viewport token into integers, or `null` if not dimensional. */
export declare function parseViewport(
  token: string | undefined,
): { width: number; height: number } | null;

/** Bucket components by `group`, preserving first-seen group order. */
export declare function groupByGroup(
  components: ReadonlyArray<ManifestCard>,
): Map<string, ManifestCard[]>;

/** Build one sandboxed, lazy-loaded preview card element for a component. */
export declare function createCard(doc: Document, card: ManifestCard): HTMLElement;

/** Render the manifest into `grid`: one labelled section per group (AC2/AC6). */
export declare function renderGrid(
  doc: Document,
  grid: HTMLElement,
  manifest: ViewerManifest,
): void;

/** Case-insensitive substring filter over card names; hides empty groups (AC5). */
export declare function applyFilter(grid: HTMLElement, query: string): void;

/** Fetch the manifest, render the grid, and wire the `#q` search input (AC5). */
export declare function boot(doc: Document, fetchImpl: typeof fetch): Promise<void>;
