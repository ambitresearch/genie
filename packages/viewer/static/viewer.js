/**
 * M4-03 (DRO-265) — genie preview viewer grid renderer.
 *
 * This is the browser-native ES module the Vite viewer (M4-02) and the
 * `ui://genie/grid` MCP-Apps resource (M4-06) both boot into. It fetches the
 * kit's compiled manifest, groups the cards by their `@genie` group, and
 * renders each as a sandboxed, lazy-loaded `<iframe>` pointing at the
 * component's `preview.html`.
 *
 * ── Manifest contract (IMPORTANT) ──────────────────────────────────────────
 * The DRO-265 issue body sketches `manifest.cards[]` with a structured
 * `viewport:{width,height}`. That was the research-report sketch; the SHIPPED
 * M3-03 compiler (`packages/server/src/manifest/compiler.ts`) instead emits:
 *
 *     { version, name, generatedAt, groups: string[],
 *       components: [{ name, group, path, viewport, hash, lastModified }] }
 *
 * where `viewport` is the RAW marker string — either `"WxH"` (e.g. `"480x240"`)
 * or a named token like `"desktop"` (kept opaque). `list_components`, a live P0
 * tool, parses `components` and would throw on a `cards` key — so this viewer
 * reads `components[]` and parses the string viewport itself. See the fixture
 * at `packages/viewer/test/fixtures/kit/.genie/manifest.json`.
 *
 * ── Design: pure functions + guarded auto-boot ─────────────────────────────
 * Every function takes its `document` (and `fetch`) as an argument and returns
 * DOM rather than reaching for ambient globals, so `grid-renderer.test.ts` can
 * drive the whole module inside a programmatic jsdom window (the same pattern
 * as the server's `*-preview-host.test.ts`). The single side-effecting line —
 * the browser auto-boot — is guarded by `typeof document !== "undefined"`, so
 * importing the module under node (the test) runs no DOM code.
 *
 * ── Security (defence in depth; hardened further in M4-07/DRO-269) ──────────
 * Each preview iframe is `sandbox="allow-scripts"` with NO `allow-same-origin`:
 * a compromised preview cannot reach the viewer's origin, cookies, or storage.
 * `card.name` is written via `textContent` (never `innerHTML`), so a hostile
 * component name cannot inject markup into the grid chrome.
 */

/**
 * The kit-relative manifest URL. The AC sketch says `./manifest.json`, but the
 * shipped compiler + M4-08 CLI (`MANIFEST_RELATIVE_PATH`) put it at
 * `.genie/manifest.json`; the viewer fetches the real location.
 */
export const MANIFEST_URL = ".genie/manifest.json";

/**
 * Fallback card height (px) for a named/unparseable viewport (e.g. "desktop").
 * A comfortable 16:10-ish default so a card without an explicit WxH still
 * reserves a sensible preview area instead of collapsing to nothing.
 */
export const DEFAULT_CARD_HEIGHT = 320;

/**
 * Parse a manifest `viewport` token into `{ width, height }`, or `null` when it
 * is a named token ("desktop"), empty, absent, or otherwise not the strict
 * `<digits>x<digits>` shape. Mirrors the server's `extractViewport` so the
 * viewer and compiler agree on exactly which tokens are dimensional.
 *
 * @param {string=} token
 * @returns {{ width: number, height: number } | null}
 */
export function parseViewport(token) {
  if (typeof token !== "string") return null;
  const match = /^(\d+)x(\d+)$/.exec(token.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  // A zero (or non-positive) dimension is degenerate — treat it like a named
  // token and fall back to the default height rather than render a 0-size,
  // invisible iframe.
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Bucket components by `group`, preserving first-seen group order (so the grid
 * section order is stable and matches the manifest's own `components` order
 * rather than an arbitrary hash iteration).
 *
 * @param {ReadonlyArray<import("./viewer.js").ManifestCard>} components
 * @returns {Map<string, import("./viewer.js").ManifestCard[]>}
 */
export function groupByGroup(components) {
  /** @type {Map<string, import("./viewer.js").ManifestCard[]>} */
  const groups = new Map();
  for (const component of components) {
    const bucket = groups.get(component.group);
    if (bucket) bucket.push(component);
    else groups.set(component.group, [component]);
  }
  return groups;
}

/**
 * Build one card element for a component: a header (name + group pill +
 * viewport meta) and a sandboxed, lazy `<iframe>` preview.
 *
 * @param {Document} doc
 * @param {import("./viewer.js").ManifestCard} card
 * @returns {HTMLElement}
 */
export function createCard(doc, card) {
  const article = doc.createElement("article");
  article.className = "ds-card";
  // Lowercased once here so the search filter (AC5) is a plain substring test
  // and never re-lowercases per keystroke.
  article.setAttribute("data-name", (card.name ?? "").toLowerCase());

  const header = doc.createElement("header");
  header.className = "ds-card__head";

  const title = doc.createElement("h3");
  title.className = "ds-card__name";
  // textContent, never innerHTML — a hostile component name must not inject
  // markup into the viewer chrome.
  title.textContent = card.name ?? "";
  header.appendChild(title);

  const meta = doc.createElement("div");
  meta.className = "ds-card__meta";

  const group = doc.createElement("span");
  group.className = "ds-card__group";
  group.textContent = card.group ?? "";
  meta.appendChild(group);

  if (card.viewport) {
    const vp = doc.createElement("span");
    vp.className = "ds-card__viewport";
    vp.textContent = card.viewport;
    meta.appendChild(vp);
  }

  header.appendChild(meta);
  article.appendChild(header);

  const frame = doc.createElement("div");
  frame.className = "ds-card__frame";

  const iframe = doc.createElement("iframe");
  // AC3 — allow-scripts ONLY. No allow-same-origin: a compromised preview
  // stays walled off from the viewer's origin (defence in depth; M4-07 adds
  // the full CSP layer).
  iframe.setAttribute("sandbox", "allow-scripts");
  // AC4 — never eagerly load offscreen previews.
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("src", card.path ?? "");
  iframe.setAttribute("title", card.name ?? "preview");

  // AC2 — size from the viewport when it is a real WxH; otherwise reserve a
  // sane default height and let CSS own the width (responsive column).
  const size = parseViewport(card.viewport);
  if (size) {
    iframe.setAttribute("width", String(size.width));
    iframe.setAttribute("height", String(size.height));
    // Preserve the intrinsic aspect ratio as the column flexes.
    iframe.style.aspectRatio = `${size.width} / ${size.height}`;
  } else {
    iframe.setAttribute("height", String(DEFAULT_CARD_HEIGHT));
  }

  frame.appendChild(iframe);
  article.appendChild(frame);

  return article;
}

/**
 * Render the whole manifest into `grid`: one `<section>` per group (labelled,
 * with a heading), each holding its cards. An empty manifest renders a single
 * visible empty state and zero iframes (AC6). Idempotent: clears any prior
 * render first, so a re-render (e.g. future HMR, M4-04) never doubles cards.
 *
 * @param {Document} doc
 * @param {HTMLElement} grid
 * @param {import("./viewer.js").ViewerManifest} manifest
 */
export function renderGrid(doc, grid, manifest) {
  grid.replaceChildren();

  const components = manifest?.components ?? [];
  if (components.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "ds-empty";
    empty.textContent = "No components yet — generate one to see it here.";
    grid.appendChild(empty);
    return;
  }

  const grouped = groupByGroup(components);
  for (const [groupName, cards] of grouped) {
    const section = doc.createElement("section");
    section.className = "ds-group";
    section.setAttribute("data-group", groupName);

    const heading = doc.createElement("h2");
    heading.className = "ds-group__title";
    heading.textContent = groupName;
    section.appendChild(heading);

    const row = doc.createElement("div");
    row.className = "ds-grid";
    for (const card of cards) {
      row.appendChild(createCard(doc, card));
    }
    section.appendChild(row);

    grid.appendChild(section);
  }
}

/**
 * AC5 — filter rendered cards by a case-insensitive substring of the component
 * `name`. Hides non-matching cards, and hides a whole group section when none
 * of its cards match (so an empty group header doesn't linger). An empty query
 * reveals everything.
 *
 * @param {HTMLElement} grid
 * @param {string} query
 */
export function applyFilter(grid, query) {
  const needle = (query ?? "").trim().toLowerCase();

  for (const section of grid.querySelectorAll("section.ds-group")) {
    let anyVisible = false;
    for (const card of section.querySelectorAll("[data-name]")) {
      const name = card.getAttribute("data-name") ?? "";
      const match = needle === "" || name.includes(needle);
      /** @type {HTMLElement} */ (card).hidden = !match;
      if (match) anyVisible = true;
    }
    /** @type {HTMLElement} */ (section).hidden = !anyVisible;
  }
}

/**
 * Render a visible error state in the grid (never throw out of `boot`) — a
 * failed manifest fetch should tell the developer what to do, not blow up the
 * page.
 *
 * @param {Document} doc
 * @param {HTMLElement} grid
 * @param {string} detail
 */
function renderError(doc, grid, detail) {
  grid.replaceChildren();
  const box = doc.createElement("div");
  box.className = "ds-error";
  box.textContent = `Could not load the preview manifest (${detail}). Run the genie MCP server against this kit first.`;
  grid.appendChild(box);
}

/**
 * Boot the viewer: fetch the manifest, render the grid, and wire the `#q`
 * search input to live-filter (AC5). Resolves (never rejects) so a caller /
 * the browser auto-boot can `await` it without an unhandled rejection; on any
 * failure it paints the error state instead.
 *
 * @param {Document} doc
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<void>}
 */
export async function boot(doc, fetchImpl) {
  const grid = doc.getElementById("grid");
  if (!grid) return;

  try {
    const response = await fetchImpl(MANIFEST_URL);
    if (!response.ok) {
      renderError(doc, /** @type {HTMLElement} */ (grid), `HTTP ${response.status}`);
      return;
    }
    const manifest = /** @type {import("./viewer.js").ViewerManifest} */ (await response.json());
    renderGrid(doc, /** @type {HTMLElement} */ (grid), manifest);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    renderError(doc, /** @type {HTMLElement} */ (grid), detail);
    return;
  }

  const search = /** @type {HTMLInputElement | null} */ (doc.getElementById("q"));
  if (search) {
    search.addEventListener("input", () => {
      applyFilter(/** @type {HTMLElement} */ (grid), search.value);
    });
  }
}

// ── Browser auto-boot ───────────────────────────────────────────────────────
// The ONLY side-effecting line. Guarded so importing this module under node
// (the vitest suite) runs no DOM code — the test drives `boot`/`renderGrid`
// with its own jsdom `document`. In the browser, `fetch` and `document` are
// ambient globals.
if (typeof document !== "undefined" && typeof fetch !== "undefined") {
  void boot(document, fetch);
}
