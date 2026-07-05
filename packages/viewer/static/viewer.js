/**
 * M4-03 (DRO-265) — genie preview viewer grid renderer.
 *
 * This is the browser-native script the Vite viewer (M4-02) and the
 * `ui://genie/grid` MCP-Apps resource (M4-06) both boot into. It fetches the
 * kit's compiled manifest, groups the cards by their `@genie` group, and
 * renders each as a sandboxed, lazy-loaded `<iframe>` pointing at the
 * component's `preview.html`.
 *
 * ── Classic script, NOT an ES module (DRO-749 fix) ─────────────────────────
 * `index.html` loads this via `<script src="./viewer.js">` — no
 * `type="module"`. It was briefly shipped as `type="module"` (the original
 * M4-03/#164 merge); that broke the `file://` vehicle outright: verified
 * empirically (headless Chromium, real `file://` navigation) that a module
 * script's relative-path fetch is rejected — every `file://` document gets an
 * opaque, distinct origin, so the ES module loader's same-origin check fails
 * against it and the script never executes (console: "has been blocked by
 * CORS policy"). Dynamic `import()` fails the same way. A classic script has
 * no such restriction and runs identically under `file://`, the Vite dev
 * server, and inside a sandboxed iframe — the only choice that actually
 * satisfies RFC G-5 ("byte-identical across file:// / localhost / ui://",
 * AGENTS.md hard rule 5). Modern syntax (`const`/`let`, arrow functions,
 * template literals, optional chaining, async/await) is all still available
 * outside a module — only `import`/`export` are off the table, and this file
 * is the only script in the kit tree, so it needs neither.
 *
 * ── Manifest contract ───────────────────────────────────────────────────────
 * The original DRO-265 issue body sketches `manifest.cards[]` with a
 * structured `viewport:{width,height}`. That was the research-report sketch;
 * the SHIPPED M3-03 compiler (`packages/server/src/manifest/compiler.ts`)
 * instead emits:
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
 * ── Group order (DRO-749 fix) ────────────────────────────────────────────────
 * `renderGrid` prefers the manifest's own `groups: string[]` for section
 * order — the compiler already resolved `_groups.json` pinning server-side
 * (`orderGroups` in compiler.ts). Previously this file derived order purely
 * from first-seen-among-components, silently ignoring a pinned `groups[]`
 * order (flagged in PR #164 review). `computeGroupOrder` ALWAYS appends any
 * group actually present in the components that the declared list omitted
 * (mirroring the server's own `orderGroups` remainder logic), so a partial
 * or absent `groups[]` never silently drops a group's cards from the grid.
 *
 * ── Design: pure functions + guarded auto-boot ─────────────────────────────
 * Every function takes its `document` (and `fetch`) as an argument and
 * returns DOM rather than reaching for ambient globals, so `grid-renderer.
 * test.ts` can drive the whole script inside a programmatic jsdom window (the
 * same pattern as the server's `*-preview-host.test.ts`). Since a classic
 * script cannot be `import`ed for its bindings, the pure helpers are exposed
 * on `window.__genieViewerTestHooks` — but ONLY when that object already
 * exists before this script runs (set up by the test harness via
 * `window.eval`). Production pages never define it, so nothing is exposed
 * and there is zero footprint on the shipped page.
 *
 * ── Security (defence in depth; hardened further in M4-07/DRO-269) ──────────
 * Each preview iframe is `sandbox="allow-scripts"` with NO `allow-same-origin`:
 * a compromised preview cannot reach the viewer's origin, cookies, or storage.
 * `card.name` is written via `textContent` (never `innerHTML`), so a hostile
 * component name cannot inject markup into the grid chrome.
 */
(function () {
  "use strict";

  /**
   * The kit-relative manifest URL. The AC sketch says `./manifest.json`, but
   * the shipped compiler + M4-08 CLI (`MANIFEST_RELATIVE_PATH`) put it at
   * `.genie/manifest.json`; the viewer fetches the real location.
   */
  var MANIFEST_URL = ".genie/manifest.json";

  /**
   * DOM id of the inlined-manifest script the embedded `ui://genie/grid` tier
   * (M4-06 / DRO-268) injects: `<script type="application/json" id="manifest">
   * …</script>`. That tier's CSP is `default-src 'none'; … connect-src 'none'`
   * — `fetch()` is blocked outright — so the manifest MUST travel inside the
   * document and `boot` reads it from here instead of the network. The `file://`
   * and localhost tiers carry NO such node, so they transparently keep the
   * `fetch(MANIFEST_URL)` path — the one `viewer.js` stays byte-identical across
   * all three vehicles (RFC G-5).
   */
  var MANIFEST_ELEMENT_ID = "manifest";

  /**
   * Fallback card height (px) for a named/unparseable viewport (e.g. "desktop").
   * A comfortable 16:10-ish default so a card without an explicit WxH still
   * reserves a sensible preview area instead of collapsing to nothing.
   */
  var DEFAULT_CARD_HEIGHT = 320;

  var VIEWPORT_TOKEN_RE = /^(\d+)x(\d+)$/;

  /**
   * Parse a manifest `viewport` token into `{ width, height }`, or `null`
   * when it is a named token ("desktop"), empty, absent, or otherwise not the
   * strict `<digits>x<digits>` shape. Mirrors the server's `extractViewport`
   * so the viewer and compiler agree on exactly which tokens are dimensional.
   *
   * @param {string=} token
   * @returns {{ width: number, height: number } | null}
   */
  function parseViewport(token) {
    if (typeof token !== "string") return null;
    var match = VIEWPORT_TOKEN_RE.exec(token.trim());
    if (!match) return null;
    var width = Number(match[1]);
    var height = Number(match[2]);
    // A zero (or non-positive) dimension is degenerate — treat it like a
    // named token and fall back to the default height rather than render a
    // 0-size, invisible iframe.
    if (width <= 0 || height <= 0) return null;
    return { width: width, height: height };
  }

  /**
   * Bucket components by `group`, preserving first-seen group order (used as
   * the fallback order when the manifest has no usable `groups[]` — see
   * {@link computeGroupOrder}).
   *
   * @param {ReadonlyArray<object>} components
   * @returns {Map<string, object[]>}
   */
  function groupByGroup(components) {
    var groups = new Map();
    for (var i = 0; i < components.length; i++) {
      var component = components[i];
      var bucket = groups.get(component.group);
      if (bucket) bucket.push(component);
      else groups.set(component.group, [component]);
    }
    return groups;
  }

  /**
   * Section display order (DRO-749 fix): prefer the manifest's own `groups`
   * array — the compiler already resolved alphabetical-vs-`_groups.json`-
   * pinned order server-side, so there is no reason to re-derive a
   * (possibly different) order client-side — but ALWAYS append any group
   * actually present in `grouped` that `declaredGroups` omitted, in
   * first-seen order. Mirrors the server's own `orderGroups` "remainder"
   * logic (`packages/server/src/manifest/compiler.ts`): "an incomplete pin
   * list never silently drops a group." Without this, a valid-but-partial
   * `groups[]` (e.g. a hand-edited or stale manifest listing only some of
   * the groups `components[]` actually uses) would cause `renderGrid` to
   * silently drop every component in an undeclared group — worse than the
   * plain first-seen order this replaces. When `declaredGroups` is absent,
   * empty, or entirely malformed, this degrades to pure first-seen order
   * among `grouped`'s own keys (every group is then "remainder").
   *
   * @param {unknown} declaredGroups — `manifest.groups`, untrusted shape.
   * @param {Map<string, object[]>} grouped
   * @returns {string[]}
   */
  function computeGroupOrder(declaredGroups, grouped) {
    var order = [];
    var seen = new Set();
    if (Array.isArray(declaredGroups)) {
      for (var i = 0; i < declaredGroups.length; i++) {
        var g = declaredGroups[i];
        if (typeof g === "string" && !seen.has(g)) {
          seen.add(g);
          order.push(g);
        }
      }
    }
    // Remainder: any group actually present in `grouped` that the declared
    // list didn't name (or the whole list was absent/empty/malformed) —
    // appended in first-seen order, never dropped.
    for (var key of grouped.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    return order;
  }

  /**
   * Build one card element for a component: a header (name + group pill +
   * viewport meta) and a sandboxed, lazy `<iframe>` preview.
   *
   * @param {Document} doc
   * @param {object} card
   * @returns {HTMLElement}
   */
  function createCard(doc, card) {
    var article = doc.createElement("article");
    article.className = "ds-card";
    // Lowercased once here so the search filter (AC5) is a plain substring
    // test and never re-lowercases per keystroke.
    article.setAttribute("data-name", (card.name || "").toLowerCase());

    var header = doc.createElement("header");
    header.className = "ds-card__head";

    var title = doc.createElement("h3");
    title.className = "ds-card__name";
    // textContent, never innerHTML — a hostile component name must not
    // inject markup into the viewer chrome.
    title.textContent = card.name || "";
    header.appendChild(title);

    var meta = doc.createElement("div");
    meta.className = "ds-card__meta";

    var group = doc.createElement("span");
    group.className = "ds-card__group";
    group.textContent = card.group || "";
    meta.appendChild(group);

    if (card.viewport) {
      var vp = doc.createElement("span");
      vp.className = "ds-card__viewport";
      vp.textContent = card.viewport;
      meta.appendChild(vp);
    }

    header.appendChild(meta);
    article.appendChild(header);

    var frame = doc.createElement("div");
    frame.className = "ds-card__frame";

    var iframe = doc.createElement("iframe");
    // AC3 — allow-scripts ONLY. No allow-same-origin: a compromised preview
    // stays walled off from the viewer's origin (defence in depth; M4-07
    // adds the full CSP layer).
    iframe.setAttribute("sandbox", "allow-scripts");
    // AC4 — never eagerly load offscreen previews.
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("src", card.path || "");
    iframe.setAttribute("title", card.name || "preview");

    // AC2 — size from the viewport when it is a real WxH; otherwise reserve
    // a sane default height and let CSS own the width (responsive column).
    var size = parseViewport(card.viewport);
    if (size) {
      iframe.setAttribute("width", String(size.width));
      iframe.setAttribute("height", String(size.height));
      // Preserve the intrinsic aspect ratio as the column flexes.
      iframe.style.aspectRatio = size.width + " / " + size.height;
    } else {
      iframe.setAttribute("height", String(DEFAULT_CARD_HEIGHT));
    }

    frame.appendChild(iframe);
    article.appendChild(frame);

    return article;
  }

  /**
   * Render the whole manifest into `grid`: one `<section>` per group
   * (labelled, with a heading), each holding its cards, in the order
   * {@link computeGroupOrder} resolves. An empty manifest renders a single
   * visible empty state and zero iframes (AC6). Idempotent: clears any prior
   * render first, so a re-render (e.g. future HMR, M4-04) never doubles
   * cards.
   *
   * @param {Document} doc
   * @param {HTMLElement} grid
   * @param {object} manifest
   */
  function renderGrid(doc, grid, manifest) {
    grid.replaceChildren();

    var components = (manifest && manifest.components) || [];
    if (components.length === 0) {
      var empty = doc.createElement("div");
      empty.className = "ds-empty";
      empty.textContent = "No components yet — generate one to see it here.";
      grid.appendChild(empty);
      return;
    }

    var grouped = groupByGroup(components);
    var order = computeGroupOrder(manifest && manifest.groups, grouped);

    for (var i = 0; i < order.length; i++) {
      var groupName = order[i];
      var cards = grouped.get(groupName);
      // A declared-but-now-empty group (stale `groups[]` entry) is skipped —
      // an empty section would render a heading over nothing.
      if (!cards || cards.length === 0) continue;

      var section = doc.createElement("section");
      section.className = "ds-group";
      section.setAttribute("data-group", groupName);

      var heading = doc.createElement("h2");
      heading.className = "ds-group__title";
      heading.textContent = groupName;
      section.appendChild(heading);

      var row = doc.createElement("div");
      row.className = "ds-grid";
      for (var j = 0; j < cards.length; j++) {
        row.appendChild(createCard(doc, cards[j]));
      }
      section.appendChild(row);

      grid.appendChild(section);
    }
  }

  /**
   * AC5 — filter rendered cards by a case-insensitive substring of the
   * component `name`. Hides non-matching cards, and hides a whole group
   * section when none of its cards match (so an empty group header doesn't
   * linger). An empty query reveals everything.
   *
   * @param {HTMLElement} grid
   * @param {string} query
   */
  function applyFilter(grid, query) {
    var needle = (query || "").trim().toLowerCase();

    var sections = grid.querySelectorAll("section.ds-group");
    for (var s = 0; s < sections.length; s++) {
      var section = sections[s];
      var anyVisible = false;
      var cards = section.querySelectorAll("[data-name]");
      for (var c = 0; c < cards.length; c++) {
        var card = cards[c];
        var name = card.getAttribute("data-name") || "";
        var match = needle === "" || name.indexOf(needle) !== -1;
        card.hidden = !match;
        if (match) anyVisible = true;
      }
      section.hidden = !anyVisible;
    }
  }

  /**
   * Render a visible error state in the grid (never throw out of `boot`) — a
   * failed manifest fetch should tell the developer what to do, not blow up
   * the page.
   *
   * @param {Document} doc
   * @param {HTMLElement} grid
   * @param {string} detail
   */
  function renderError(doc, grid, detail) {
    grid.replaceChildren();
    var box = doc.createElement("div");
    box.className = "ds-error";
    box.textContent =
      "Could not load the preview manifest (" + detail + "). Run the genie MCP server against this kit first.";
    grid.appendChild(box);
  }

  /**
   * Read the manifest inlined by the embedded `ui://genie/grid` tier (M4-06):
   * a `<script type="application/json" id="manifest">…</script>` node whose
   * text content is the compiled manifest JSON. Returns the parsed object, or
   * `null` when there is no such node (the `file://` / localhost tiers, which
   * fetch instead) OR the node is present but not usable — wrong `type`, empty,
   * or malformed JSON. A `null` return is the caller's signal to fall back to
   * the network path; a malformed INLINE manifest deliberately degrades to that
   * same fallback rather than throwing, so a corrupt payload surfaces as the
   * normal error state, never an uncaught exception on the page.
   *
   * Reading `type` guards against picking up an unrelated `#manifest` element
   * and, more importantly, means only a genuine data block (never an executable
   * `<script>`) is ever parsed here.
   *
   * @param {Document} doc
   * @returns {object | null}
   */
  function readInlineManifest(doc) {
    var el = doc.getElementById(MANIFEST_ELEMENT_ID);
    if (!el) return null;
    // Only a JSON data block counts — never an executable script.
    var type = (el.getAttribute && el.getAttribute("type")) || "";
    if (type.toLowerCase() !== "application/json") return null;
    var raw = el.textContent || "";
    if (raw.trim() === "") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Wire the `#q` search box to live-filter the rendered grid (AC5). Shared by
   * both boot paths (inline + fetch) so the two vehicles behave identically.
   *
   * @param {Document} doc
   * @param {HTMLElement} grid
   */
  function wireSearch(doc, grid) {
    var search = doc.getElementById("q");
    if (search) {
      search.addEventListener("input", function () {
        applyFilter(grid, search.value);
      });
    }
  }

  /**
   * Boot the viewer: obtain the manifest, render the grid, and wire the `#q`
   * search input to live-filter (AC5). Resolves (never rejects) so a caller
   * / the browser auto-boot can `await` it without an unhandled rejection;
   * on any failure it paints the error state instead.
   *
   * ── Manifest source: inline first, then fetch (M4-06 / DRO-268) ────────────
   * The embedded `ui://genie/grid` tier inlines the manifest into the document
   * (`<script type="application/json" id="manifest">`) because its CSP
   * (`connect-src 'none'`) blocks `fetch` entirely. So `boot` reads the inline
   * node FIRST and, when present, renders straight from it — issuing NO network
   * request. Only when there is no inline node (the `file://` / localhost tiers)
   * does it fall back to `fetch(MANIFEST_URL)`. This keeps `viewer.js`
   * byte-identical across all three vehicles (RFC G-5) while honouring each
   * tier's transport.
   *
   * @param {Document} doc
   * @param {typeof fetch} fetchImpl
   * @returns {Promise<void>}
   */
  function boot(doc, fetchImpl) {
    var grid = doc.getElementById("grid");
    if (!grid) return Promise.resolve();

    // Embedded tier: manifest is inlined; render it directly, never fetch.
    var inline = readInlineManifest(doc);
    if (inline !== null) {
      try {
        renderGrid(doc, grid, inline);
        wireSearch(doc, grid);
      } catch (err) {
        var inlineDetail = err && err.message ? err.message : String(err);
        renderError(doc, grid, inlineDetail);
      }
      return Promise.resolve();
    }

    // file:// / localhost tiers: no inline node — fetch the manifest.
    return fetchImpl(MANIFEST_URL)
      .then(function (response) {
        if (!response.ok) {
          renderError(doc, grid, "HTTP " + response.status);
          return null;
        }
        return response.json();
      })
      .then(function (manifest) {
        if (manifest === null) return; // error already rendered above
        renderGrid(doc, grid, manifest);
        wireSearch(doc, grid);
      })
      .catch(function (err) {
        var detail = err && err.message ? err.message : String(err);
        renderError(doc, grid, detail);
      });
  }

  // ── Browser auto-boot ─────────────────────────────────────────────────────
  // The ONLY side-effecting line. Guarded so evaluating this script under a
  // test harness that hasn't triggered a real navigation still behaves, and
  // so the auto-boot never fires twice. In the browser, `fetch` and
  // `document` are ambient globals.
  if (typeof document !== "undefined" && typeof fetch !== "undefined") {
    void boot(document, fetch);
  }

  // Test-only seam — see file header. No-op (and no global write at all)
  // unless a test harness pre-defines the hook object before this script
  // runs.
  if (typeof window !== "undefined" && window.__genieViewerTestHooks) {
    window.__genieViewerTestHooks.MANIFEST_URL = MANIFEST_URL;
    window.__genieViewerTestHooks.DEFAULT_CARD_HEIGHT = DEFAULT_CARD_HEIGHT;
    window.__genieViewerTestHooks.parseViewport = parseViewport;
    window.__genieViewerTestHooks.groupByGroup = groupByGroup;
    window.__genieViewerTestHooks.computeGroupOrder = computeGroupOrder;
    window.__genieViewerTestHooks.createCard = createCard;
    window.__genieViewerTestHooks.renderGrid = renderGrid;
    window.__genieViewerTestHooks.applyFilter = applyFilter;
    window.__genieViewerTestHooks.readInlineManifest = readInlineManifest;
    window.__genieViewerTestHooks.wireSearch = wireSearch;
    window.__genieViewerTestHooks.MANIFEST_ELEMENT_ID = MANIFEST_ELEMENT_ID;
    window.__genieViewerTestHooks.boot = boot;
  }
})();
