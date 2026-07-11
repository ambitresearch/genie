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
 *
 * ── Accessibility (M4-09/DRO-271) ───────────────────────────────────────────
 * Each card is a keyboard-operable `role="link"` (M4-09 AC3): `tabindex="0"`
 * puts it in Tab order, an explicit `aria-label` gives it a clean accessible
 * name (without one, a screen reader would concatenate the heading + group
 * pill + viewport text with no separators — "Primary buttonsactions480x240"),
 * and a `keydown`/`click` handler activates it (mirrors native `<a>`/`<button>`
 * behaviour, which `role="link"` does NOT get for free — ARIA supplies
 * semantics, never key handling). The card's own iframe is pulled OUT of Tab
 * order (`tabindex="-1"`): a sandboxed iframe with no `allow-same-origin` is
 * STILL natively focusable, so without this, Tab order would be
 * search → card → iframe → card → iframe (M4-09 AC3 asks for
 * search → card → card). Verified empirically against a real Chromium +
 * axe-core run (`test/a11y.test.ts`) that this combination introduces no new
 * violations and that `frame-title` (M4-09 AC5) still evaluates the iframe
 * element correctly.
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
   * (M4-06 / DRO-268) injects: a `<script type="application/json" id="manifest">`
   * data island holding the compiled manifest. That tier's CSP is
   * `default-src 'none'; … connect-src 'none'` — `fetch()` is blocked outright —
   * so the manifest MUST travel inside the document and `boot` reads it from
   * here instead of the network. The `file://` and localhost tiers carry NO such
   * node, so they transparently keep the `fetch(MANIFEST_URL)` path — the one
   * `viewer.js` stays byte-identical across all three vehicles (RFC G-5).
   */
  var MANIFEST_ELEMENT_ID = "manifest";
  var TOOL_RESULT_SHELL_META = "genie-tool-result-shell";
  var MCP_APP_PROTOCOL_VERSION = "2026-01-26";
  var mcpAppRequestId = 0;

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
   * Returns `value` trimmed, or `fallback` when it is missing, empty, or
   * whitespace-only. Used for the two places M4-09 needs a GUARANTEED
   * non-empty accessible name: the card's `aria-label` (axe-core's
   * `link-name` rule flags a `role="link"` with no accessible name as a
   * CRITICAL violation — and an empty string `aria-label=""` counts as "no
   * name", it does NOT fall back to the element's text content) and the
   * iframe's `title` (axe-core's `frame-title` rule, same "empty is not
   * acceptable" contract). A card whose upstream manifest carries `name: ""`
   * (schema-legal — `store/manifest.ts` only requires `z.string()`, not a
   * non-empty one) must still render an accessible, non-violating card
   * rather than silently produce an unnamed link/frame.
   *
   * @param {string=} value
   * @param {string} fallback
   * @returns {string}
   */
  function accessibleName(value, fallback) {
    var trimmed = (value || "").trim();
    return trimmed === "" ? fallback : trimmed;
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

    // M4-09 AC3 — keyboard-operable card: `tabindex="0"` puts it in Tab
    // order, `role="link"` + an explicit `aria-label` give it a clean
    // accessible name (see the module doc's "Accessibility" section —
    // without the label, a screen reader concatenates the heading + group
    // pill + viewport text with no separators), and Enter/click activate it
    // (`role="link"` supplies semantics only, never key handling — unlike a
    // real `<a>`, so the listener below is required, not decorative). There
    // is no dedicated card-detail route yet (M4-05 leaves "per-card detail
    // view" out of scope for v1), so the placeholder destination is the
    // component's own preview: the one real, already-working URL a card
    // carries.
    article.setAttribute("tabindex", "0");
    article.setAttribute("role", "link");
    // `accessibleName` guards against axe-core's `link-name` (critical): an
    // empty-string aria-label is worse than none (it suppresses the normal
    // fall-back-to-content accessible-name computation), so an unnamed
    // component still gets a real label rather than an empty one.
    article.setAttribute("aria-label", accessibleName(card.name, "Untitled component"));
    var openDetail = function () {
      var view = doc.defaultView;
      if (view && card.path) view.location.assign(card.path);
    };
    article.addEventListener("click", openDetail);
    article.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        // Prevent a default action (e.g. a native scroll-on-Enter in some
        // ATs) before navigating — mirrors how a real `<a>` suppresses it
        // too.
        event.preventDefault();
        openDetail();
      }
    });

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
    var cardSrc = card.path || "";
    var cardIdentity = card.sourcePath || cardSrc;
    iframe.setAttribute("src", cardSrc);
    // M4-09 AC5 — the accessible name axe-core's `frame-title` rule checks
    // for. `accessibleName` guards the same empty-string trap as the card's
    // own aria-label above: `title=""` is indistinguishable from a missing
    // title to `frame-title`, so a nameless component still gets a real
    // fallback string.
    iframe.setAttribute("title", accessibleName(card.name, "preview"));
    // M4-09 AC3 — pull the iframe itself OUT of Tab order. A sandboxed
    // iframe with no `allow-same-origin` is STILL natively focusable (the
    // sandbox only restricts what the framed document can DO, not whether
    // the frame element itself takes focus) — see the module doc's
    // "Accessibility" section. Without this, Tab order would be
    // search → card → iframe → card → iframe instead of the required
    // search → card → card.
    iframe.setAttribute("tabindex", "-1");
    // M4-04 (DRO-266) — the canonical, kit-root-relative preview path, kept
    // verbatim (never cache-busted) so the HMR bridge can match a
    // `card.changed` message's `path` against exactly this attribute. The
    // live `src` may later carry an `?__genie_hmr=N` cache-bust (see
    // reloadIframeEl); `data-path` stays the stable identity.
    iframe.setAttribute("data-path", cardIdentity);
    // Embedded manifests replace `path` with an absolute/data transport URL.
    // Keep that source separate from the kit-relative identity above so a host
    // can target the card by sourcePath and replace its bytes safely.
    iframe.setAttribute("data-src", cardSrc);

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

  function filterManifestBySearch(manifest, search) {
    var Params =
      typeof window !== "undefined" && typeof window.URLSearchParams === "function"
        ? window.URLSearchParams
        : null;
    if (!Params) return manifest;
    var params = new Params(search || "");
    var componentName = params.get("componentName");
    var group = params.get("group");
    if (!componentName && !group) return manifest;

    var components = ((manifest && manifest.components) || []).filter(function (component) {
      return (
        (!componentName || component.name === componentName) &&
        (!group || component.group === group)
      );
    });
    var survivingGroups = new Set(
      components.map(function (component) {
        return component.group;
      }),
    );
    return {
      ...manifest,
      groups: ((manifest && manifest.groups) || []).filter(function (groupName) {
        return survivingGroups.has(groupName);
      }),
      components: components,
    };
  }

  var detachedShellHeaders = new WeakMap();

  function restoreShellHeader(doc) {
    var entry = detachedShellHeaders.get(doc);
    if (!entry || !doc.body) return;
    if (entry.nextSibling && entry.nextSibling.parentNode === doc.body) {
      doc.body.insertBefore(entry.header, entry.nextSibling);
    } else {
      doc.body.appendChild(entry.header);
    }
    detachedShellHeaders.delete(doc);
  }

  function detachShellHeader(doc) {
    var header = doc.querySelector("body > header");
    if (!header) return;
    detachedShellHeaders.set(doc, { header: header, nextSibling: header.nextSibling });
    header.remove();
  }

  function renderToolResultError(doc, grid, detail) {
    grid.replaceChildren();
    var box = doc.createElement("div");
    box.className = "ds-error";
    box.textContent = detail;
    grid.appendChild(box);
  }

  function renderToolResult(doc, grid, result) {
    restoreShellHeader(doc);
    var structured = result && result.structuredContent;
    if ((result && result.isError) || !structured) {
      var messages = [];
      var content = result && Array.isArray(result.content) ? result.content : [];
      for (var i = 0; i < content.length; i++) {
        if (content[i] && content[i].type === "text" && typeof content[i].text === "string") {
          messages.push(content[i].text);
        }
      }
      renderToolResultError(doc, grid, messages.join("\n") || "Preview unavailable");
      return false;
    }
    if (typeof structured.embeddedError === "string" && structured.embeddedError) {
      renderError(doc, grid, structured.embeddedError);
      return false;
    }

    if (structured.locality !== "local" && structured.embeddedManifest) {
      if (canRenderEmbeddedManifest(structured.embeddedManifest)) {
        renderGrid(doc, grid, structured.embeddedManifest);
        return true;
      }
      renderError(
        doc,
        grid,
        "remote previews require GENIE_PREVIEWS_BASE_URL so cards run on a declared origin",
      );
      return false;
    }

    var rawUrl = structured && structured.viewerUrl;
    if (structured.locality !== "local" || typeof rawUrl !== "string") {
      if (structured.embeddedManifest) {
        if (canRenderEmbeddedManifest(structured.embeddedManifest)) {
          renderGrid(doc, grid, structured.embeddedManifest);
          return true;
        }
        renderError(
          doc,
          grid,
          "preview viewer unavailable; configure GENIE_PREVIEWS_BASE_URL for embedded cards",
        );
        return false;
      }
      renderToolResultError(doc, grid, "Preview unavailable");
      return false;
    }

    var URLCtor = doc.defaultView && doc.defaultView.URL;
    if (typeof URLCtor !== "function") {
      renderToolResultError(doc, grid, "Preview unavailable");
      return false;
    }
    var parsed;
    try {
      parsed = new URLCtor(rawUrl);
    } catch {
      renderToolResultError(doc, grid, "Preview unavailable");
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      renderToolResultError(doc, grid, "Preview unavailable");
      return false;
    }

    var iframe = doc.createElement("iframe");
    iframe.className = "ds-viewer-embed";
    iframe.setAttribute("src", parsed.toString());
    iframe.setAttribute("title", "genie component preview");
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    detachShellHeader(doc);
    grid.replaceChildren(iframe);
    return true;
  }

  function canRenderEmbeddedManifest(manifest) {
    if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.components)) {
      return false;
    }
    var components = manifest.components;
    return components.every(function (component) {
      if (!component || typeof component.path !== "string") return false;
      try {
        var URLCtor =
          typeof window !== "undefined" && typeof window.URL === "function" ? window.URL : null;
        if (!URLCtor) return false;
        var parsed = new URLCtor(component.path);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    });
  }

  function initMcpApp(doc, options) {
    var opts = options || {};
    var onTeardown = typeof opts.onTeardown === "function" ? opts.onTeardown : function () {};
    var win = "win" in opts ? opts.win : typeof window !== "undefined" ? window : undefined;
    if (
      !win ||
      !win.parent ||
      win.parent === win ||
      typeof win.addEventListener !== "function" ||
      typeof win.parent.postMessage !== "function"
    ) {
      return function () {};
    }

    var host = win.parent;
    var initializeId = ++mcpAppRequestId;
    var resizeObserver = null;
    var lastWidth = -1;
    var lastHeight = -1;
    var tornDown = false;
    function post(message) {
      host.postMessage(message, "*");
    }
    function notifySize() {
      var root = doc.documentElement;
      var body = doc.body;
      var width = Math.ceil(Math.max(root?.scrollWidth || 0, body?.scrollWidth || 0));
      var height = Math.ceil(Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0));
      if (width <= 0 || height <= 0 || (width === lastWidth && height === lastHeight)) return;
      lastWidth = width;
      lastHeight = height;
      post({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { width: width, height: height },
      });
    }
    function observeSize() {
      var ResizeObserverCtor = win.ResizeObserver;
      if (typeof ResizeObserverCtor !== "function" || !doc.documentElement) return;
      resizeObserver = new ResizeObserverCtor(notifySize);
      resizeObserver.observe(doc.documentElement);
      if (doc.body) resizeObserver.observe(doc.body);
    }
    function teardown() {
      if (tornDown) return;
      tornDown = true;
      if (typeof win.removeEventListener === "function") {
        win.removeEventListener("message", onMessage);
      }
      if (resizeObserver && typeof resizeObserver.disconnect === "function") {
        resizeObserver.disconnect();
      }
      onTeardown();
    }
    function onMessage(event) {
      if (tornDown) return;
      if (!event || event.source !== host) return;
      var data = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || typeof data !== "object") return;

      if (data.method === "ping" && "id" in data) {
        post({ jsonrpc: "2.0", id: data.id, result: {} });
        return;
      }
      if (data.method === "ui/resource-teardown" && "id" in data) {
        post({ jsonrpc: "2.0", id: data.id, result: {} });
        teardown();
        return;
      }
      if (data.id === initializeId && data.result) {
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
        notifySize();
        observeSize();
        return;
      }
      if (data.method === "ui/notifications/tool-result") {
        var grid = doc.getElementById("grid");
        if (grid) {
          renderToolResult(doc, grid, data.params);
          notifySize();
        }
      }
    }

    win.addEventListener("message", onMessage);
    post({
      jsonrpc: "2.0",
      id: initializeId,
      method: "ui/initialize",
      params: {
        protocolVersion: MCP_APP_PROTOCOL_VERSION,
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        appInfo: { name: "genie-preview-grid", version: "1.0.0" },
      },
    });

    return teardown;
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
      "Could not load the preview manifest (" +
      detail +
      "). Run the genie MCP server against this kit first.";
    grid.appendChild(box);
  }

  // ── HMR: per-card live refresh (M4-04 / DRO-266) ───────────────────────────
  //
  // Two transports, one pure dispatcher (`applyHmrMessage`):
  //   1. A WebSocket on `/__genie_hmr` (AC1/AC2) — the primary channel on the
  //      Vite dev server (`http(s)://…`). The server plugin
  //      (`src/hmr-plugin.ts`) pushes `{event:"card.changed",path}` /
  //      `{event:"tokens.changed"}` off Vite's own file watcher.
  //   2. `window` `postMessage` — the bridge for the EMBEDDED `ui://` tier,
  //      where the grid runs inside a host iframe under strict CSP
  //      (`default-src 'none'`, coordinated with DRO-269) that may forbid a
  //      direct WebSocket. A host forwards the same refresh signal as a
  //      message; we accept both the WS shape AND the research sketch's
  //      `{type:"refresh", id|path}` shape (M4-04 summary).
  //
  // Why src-reassignment, not `iframe.contentWindow.location.reload()` (which
  // AC2 literally names): every preview iframe is `sandbox="allow-scripts"`
  // with NO `allow-same-origin` (M4-03 AC3, a hard security rule) — so it has
  // an opaque origin and touching `contentWindow.location` throws cross-origin.
  // Reassigning `src` with a fresh cache-bust token is the cross-origin-safe
  // equivalent with the identical observable outcome: ONLY that one iframe
  // refetches its `preview.html` and reloads; the grid never re-renders and no
  // sibling card reflows (AC3 — the sub-100 ms, one-card-only guarantee is
  // structural, not a timing hack). `data-path` stays the stable identity the
  // bridge matches on; the `?__genie_hmr=N` token rides only on the live `src`.

  /** AC1's WebSocket endpoint path — must match `GENIE_HMR_PATH` server-side. */
  var HMR_PATH = "/__genie_hmr";

  /** Cache-bust query param appended to a reloaded iframe's live `src`. */
  var HMR_CACHE_BUST_PARAM = "__genie_hmr";

  /** AC4 — polling-fallback cadence when the WebSocket is unavailable. */
  var HMR_POLL_INTERVAL_MS = 2000;

  /** Monotonic cache-bust token source (never `Date.now`, so tests are pure). */
  var hmrReloadToken = 0;

  /**
   * Normalise a raw WS frame (a JSON string) or a `postMessage` payload (a
   * string or already-parsed object) into an internal reload command, or
   * `null` for anything unrecognised (so unrelated `postMessage`s from other
   * libraries are silently ignored). Accepts both wire shapes:
   *   - `{ event: "card.changed", path }`  → `{ kind: "card", path }`   (WS, AC2)
   *   - `{ event: "tokens.changed" }`       → `{ kind: "tokens" }`       (WS, AC5)
   *   - `{ event: "manifest.changed" }`     → `{ kind: "manifest" }`     (WS, structural)
   *   - `{ type: "refresh", path, src? }`   → `{ kind: "card", path, src? }` (postMessage)
   *   - `{ type: "refresh", id }`           → `{ kind: "card", path:id }` (postMessage; `id` is the card path)
   *   - `{ type: "refresh" }` (no target)   → `{ kind: "tokens" }`       (refresh-all)
   *
   * @param {unknown} raw
   * @returns {{ kind: "card", path: string, src?: string } | { kind: "tokens" } | { kind: "manifest" } | null}
   */
  function normalizeHmrMessage(raw) {
    var data = raw;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return null;
      }
    }
    if (!data || typeof data !== "object") return null;

    if (data.event === "card.changed") {
      if (typeof data.path !== "string" || !data.path) return null;
      return typeof data.src === "string" && data.src
        ? { kind: "card", path: data.path, src: data.src }
        : { kind: "card", path: data.path };
    }
    if (data.event === "tokens.changed") return { kind: "tokens" };
    if (data.event === "manifest.changed") return { kind: "manifest" };

    if (data.type === "refresh") {
      var target = typeof data.path === "string" && data.path ? data.path : data.id;
      if (typeof target === "string" && target) {
        return typeof data.src === "string" && data.src
          ? { kind: "card", path: target, src: data.src }
          : { kind: "card", path: target };
      }
      return { kind: "tokens" }; // a target-less refresh means "reload everything".
    }
    return null;
  }

  /**
   * Reassign one iframe's `src` to its stable `data-src` plus a fresh
   * cache-bust token, or install `freshSrc` from the embedded host for a
   * data-backed card. Returns `true` when a navigation was started.
   *
   * @param {HTMLIFrameElement} iframe
   * @param {number|string} token
   * @param {string=} freshSrc
   * @returns {boolean}
   */
  function reloadIframeEl(iframe, token, freshSrc) {
    if (freshSrc) {
      iframe.setAttribute("data-src", freshSrc);
      iframe.setAttribute("src", freshSrc);
      return true;
    }

    var src =
      iframe.getAttribute("data-src") ||
      iframe.getAttribute("src") ||
      iframe.getAttribute("data-path");
    if (!src || /^data:/i.test(src)) return false;
    var sep = src.indexOf("?") === -1 ? "?" : "&";
    iframe.setAttribute("src", src + sep + HMR_CACHE_BUST_PARAM + "=" + token);
    return true;
  }

  /**
   * AC2 — reload ONLY the card(s) whose `data-path` equals `path`. Iterates
   * (rather than a `[data-path="…"]` selector) so a path with selector-special
   * characters can't break matching. Returns how many iframes were reloaded.
   *
   * @param {HTMLElement} grid
   * @param {string} path
   * @param {number|string} token
   * @param {string=} freshSrc
   * @returns {number}
   */
  function reloadCardByPath(grid, path, token, freshSrc) {
    if (!grid || !path) return 0;
    var iframes = grid.querySelectorAll("iframe[data-path]");
    var n = 0;
    for (var i = 0; i < iframes.length; i++) {
      if (
        iframes[i].getAttribute("data-path") === path &&
        reloadIframeEl(iframes[i], token, freshSrc)
      )
        n++;
    }
    return n;
  }

  /**
   * AC5 — reload EVERY card iframe (a tokens/styles change repaints them all).
   * One shared token for the batch is fine: each iframe has a distinct path, so
   * the token only needs to differ from that iframe's previous `src`.
   *
   * @param {HTMLElement} grid
   * @param {number|string} token
   * @returns {number}
   */
  function reloadAllCards(grid, token) {
    if (!grid) return 0;
    var iframes = grid.querySelectorAll("iframe[data-path]");
    var n = 0;
    for (var i = 0; i < iframes.length; i++) {
      if (reloadIframeEl(iframes[i], token)) n++;
    }
    return n;
  }

  /**
   * Pure dispatcher: normalise a message and apply it to the grid, returning
   * the number of iframes reloaded (0 for an unrecognised or no-match message).
   * A caller may pin `token` for determinism; otherwise a monotonic token is
   * used so each dispatch actually changes every affected `src`.
   *
   * @param {HTMLElement} grid
   * @param {unknown} message
   * @param {number|string=} token
   * @returns {number}
   */
  function applyHmrMessage(grid, message, token) {
    var cmd = normalizeHmrMessage(message);
    if (!cmd) return 0;
    if (cmd.kind === "manifest") return 0;
    var t = token === undefined ? ++hmrReloadToken : token;
    return cmd.kind === "card"
      ? reloadCardByPath(grid, cmd.path, t, cmd.src)
      : reloadAllCards(grid, t);
  }

  /**
   * AC4 (polling fallback) — pure diff of two manifests: the kit-relative paths
   * of components PRESENT in both whose `hash` changed. Structural and rendered
   * metadata changes are detected separately by `manifestStructureChanged` and
   * trigger a full re-render; this helper intentionally reports only in-place
   * content edits. Never throws on a partial/absent manifest.
   *
   * @param {object} prev
   * @param {object} next
   * @returns {string[]}
   */
  function diffManifestHashes(prev, next) {
    var prevByPath = {};
    var pc = (prev && prev.components) || [];
    for (var i = 0; i < pc.length; i++) {
      if (!pc[i]) continue;
      var prevPath = pc[i].sourcePath || pc[i].path;
      if (typeof prevPath === "string") prevByPath[prevPath] = pc[i].hash;
    }
    var changed = [];
    var nc = (next && next.components) || [];
    for (var j = 0; j < nc.length; j++) {
      var comp = nc[j];
      if (!comp) continue;
      var nextPath = comp.sourcePath || comp.path;
      if (typeof nextPath !== "string") continue;
      if (
        Object.prototype.hasOwnProperty.call(prevByPath, nextPath) &&
        prevByPath[nextPath] !== comp.hash
      ) {
        changed.push(nextPath);
      }
    }
    return changed;
  }

  /**
   * True when component membership/order or declared group order changed.
   * Content-only hash changes keep the lightweight per-card reload path.
   *
   * @param {object} prev
   * @param {object} next
   * @returns {boolean}
   */
  function manifestStructureChanged(prev, next) {
    function identity(manifest) {
      var components = (manifest && manifest.components) || [];
      var cards = [];
      for (var i = 0; i < components.length; i++) {
        var component = components[i] || {};
        cards.push({
          path: component.path || "",
          sourcePath: component.sourcePath || "",
          name: component.name || "",
          group: component.group || "",
          viewport: component.viewport || "",
        });
      }
      return JSON.stringify({
        groups: (manifest && manifest.groups) || [],
        cards: cards,
      });
    }
    return identity(prev) !== identity(next);
  }

  /** Re-render from a fresh manifest while preserving the active search query. */
  function renderManifestUpdate(doc, grid, manifest) {
    var searchQuery =
      doc.defaultView && doc.defaultView.location && doc.defaultView.location.search;
    renderGrid(doc, grid, filterManifestBySearch(manifest, searchQuery || ""));
    var searchInput = doc.getElementById("q");
    if (searchInput) applyFilter(grid, searchInput.value || "");
  }

  /**
   * AC6 — increment the header's reload counter by `n` (a no-op when `n<=0` or
   * the counter element is absent, e.g. the embedded shell). The count is
   * mirrored in a `data-count` attribute so a test can read it without parsing
   * display text.
   *
   * @param {Document} doc
   * @param {number} n
   * @returns {number} the new total
   */
  function bumpReloadCounter(doc, n) {
    var el = doc.getElementById("hmr-count");
    if (!el || !(n > 0)) return el ? Number(el.getAttribute("data-count") || "0") : 0;
    var next = Number(el.getAttribute("data-count") || "0") + n;
    el.setAttribute("data-count", String(next));
    el.textContent = String(next);
    return next;
  }

  /**
   * The `ws(s)://…/__genie_hmr` URL for the current location, or `null` when
   * there is no dev server to connect to — a `file://` open or an opaque/`ui://`
   * embedded origin. That `null` is what makes the script byte-identical across
   * vehicles (RFC G-5): the SAME `viewer.js` simply skips the live socket where
   * one can't exist and leans on the `postMessage` bridge instead.
   *
   * @param {Location|{protocol?:string,host?:string}} loc
   * @returns {string|null}
   */
  function hmrSocketUrl(loc) {
    if (!loc || (loc.protocol !== "http:" && loc.protocol !== "https:") || !loc.host) return null;
    return (loc.protocol === "https:" ? "wss:" : "ws:") + "//" + loc.host + HMR_PATH;
  }

  /**
   * Wire the live-refresh channels and return a teardown function. Everything
   * the browser touches is injectable so `hmr-client.test.ts` drives the whole
   * thing in jsdom with fakes — no real socket, no real timers, no network:
   *
   *   - `win`            — the window to bind `message`/`WebSocket` on (default `window`)
   *   - `location`       — used to derive the WS URL (default `win.location`)
   *   - `WebSocketImpl`  — the WebSocket constructor (default `win.WebSocket`)
   *   - `fetchImpl`      — manifest fetch for the poll fallback (default `win.fetch`)
   *   - `setIntervalImpl` / `clearIntervalImpl` — poll timer seam (default `win`'s)
   *   - `manifestUrl`    — poll target (default `MANIFEST_URL`)
   *   - `initialManifest`— baseline so the FIRST poll can already detect a change
   *   - `pollIntervalMs` — cadence (default `HMR_POLL_INTERVAL_MS`)
   *   - `parentOrigin`   — optional trusted embedding-host origin; otherwise
   *                        derived from `document.referrer` when available
   *
   * The `postMessage` bridge is ALWAYS active (harmless where unused). The WS +
   * polling only engage when {@link hmrSocketUrl} resolves (a real dev server);
   * on `file://`/`ui://` there is nothing to poll, so we don't spin a timer
   * against a static snapshot.
   *
   * @param {Document} doc
   * @param {object=} options
   * @returns {() => void} teardown
   */
  function initHmr(doc, options) {
    var opts = options || {};
    var grid = doc.getElementById("grid");
    if (!grid) return function () {};

    // Resolve each injectable via an explicit "key in opts" check (not `||`), so
    // a test can DISABLE a capability by passing it as `undefined`/`null` — e.g.
    // `WebSocketImpl: undefined` to exercise the no-WebSocket polling path even
    // though the ambient jsdom `window` provides a real one. Production callers
    // omit the key entirely and get the ambient default.
    var win = "win" in opts ? opts.win : typeof window !== "undefined" ? window : undefined;
    var location = "location" in opts ? opts.location : win && win.location;
    var WebSocketImpl =
      "WebSocketImpl" in opts
        ? opts.WebSocketImpl
        : (win && win.WebSocket) || (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    var fetchImpl = "fetchImpl" in opts ? opts.fetchImpl : win && win.fetch;
    var setIntervalImpl =
      "setIntervalImpl" in opts
        ? opts.setIntervalImpl
        : (win && win.setInterval) ||
          (typeof setInterval !== "undefined" ? setInterval : undefined);
    var clearIntervalImpl =
      "clearIntervalImpl" in opts
        ? opts.clearIntervalImpl
        : (win && win.clearInterval) ||
          (typeof clearInterval !== "undefined" ? clearInterval : undefined);
    var manifestUrl = opts.manifestUrl || MANIFEST_URL;
    var pollIntervalMs = opts.pollIntervalMs || HMR_POLL_INTERVAL_MS;

    var socket = null;
    var pollTimer = null;
    var lastManifest = opts.initialManifest || null;
    var pollInFlight = false;
    var manifestRefreshPending = false;
    var torn = false;

    function applyFetchedManifest(next) {
      if (!next) return;
      if (!lastManifest || manifestStructureChanged(lastManifest, next)) {
        renderManifestUpdate(doc, grid, next);
        bumpReloadCounter(doc, 1);
      } else {
        var changed = diffManifestHashes(lastManifest, next);
        var total = 0;
        for (var i = 0; i < changed.length; i++) {
          total += reloadCardByPath(grid, changed[i], ++hmrReloadToken);
        }
        if (total > 0) bumpReloadCounter(doc, total);
      }
      lastManifest = next;
    }

    function finishManifestFetch() {
      pollInFlight = false;
      if (manifestRefreshPending && !torn) {
        manifestRefreshPending = false;
        fetchManifestUpdate();
      }
    }

    function fetchManifestUpdate() {
      if (torn || !fetchImpl) return;
      if (pollInFlight) {
        manifestRefreshPending = true;
        return;
      }
      pollInFlight = true;
      fetchImpl(manifestUrl)
        .then(function (res) {
          return res && res.ok ? res.json() : null;
        })
        .then(function (next) {
          if (torn || !next) return;
          applyFetchedManifest(next);
        })
        .catch(function () {
          // Keep the current grid; a later manifest event/poll can retry.
        })
        .then(finishManifestFetch);
    }

    /** Apply any inbound message (WS or postMessage) and bump the counter. */
    function handle(rawData) {
      var command = normalizeHmrMessage(rawData);
      if (command && command.kind === "manifest") {
        fetchManifestUpdate();
        return;
      }
      var reloaded = applyHmrMessage(grid, rawData);
      if (reloaded > 0) bumpReloadCounter(doc, reloaded);
    }

    // ── Transport 2: the postMessage bridge (embedded ui:// tier) ────────────
    var parentOrigin = null;
    var configuredParentOrigin = "parentOrigin" in opts ? opts.parentOrigin : doc.referrer;
    var ParentURL = win && win.URL;
    if (configuredParentOrigin && typeof ParentURL === "function") {
      try {
        var parsedParentOrigin = new ParentURL(configuredParentOrigin).origin;
        if (parsedParentOrigin !== "null") parentOrigin = parsedParentOrigin;
      } catch {
        parentOrigin = null;
      }
    }

    function onMessage(event) {
      // Sandboxed cards can call parent.postMessage despite lacking
      // allow-same-origin. Only the embedding host may issue refresh commands.
      if (!event || !win || event.source !== win.parent) return;
      if (parentOrigin && event.origin !== parentOrigin) return;
      handle(event && "data" in event ? event.data : event);
    }
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("message", onMessage);
    }

    // ── AC4: polling fallback ────────────────────────────────────────────────
    function poll() {
      if (torn || pollInFlight || !fetchImpl) return;
      pollInFlight = true;
      fetchImpl(manifestUrl)
        .then(function (res) {
          return res && res.ok ? res.json() : null;
        })
        .then(function (next) {
          if (torn || !next) return;
          applyFetchedManifest(next);
        })
        .catch(function () {
          // A transient fetch failure must not kill the poll loop — try again
          // next tick.
        })
        .then(finishManifestFetch);
    }

    function startPolling() {
      if (torn || pollTimer || !setIntervalImpl || !fetchImpl) return;
      pollTimer = setIntervalImpl(poll, pollIntervalMs);
    }

    // ── Transport 1: the WebSocket (primary, dev-server only) ────────────────
    var url = hmrSocketUrl(location);
    if (url && WebSocketImpl) {
      try {
        socket = new WebSocketImpl(url);
        socket.onmessage = function (event) {
          handle(event && "data" in event ? event.data : event);
        };
        // A socket error or close (server gone, CSP block, network drop) falls
        // back to polling — but only once (guarded inside startPolling).
        socket.onerror = startPolling;
        socket.onclose = startPolling;
      } catch {
        // Constructing the socket threw (e.g. a CSP `connect-src` block) — go
        // straight to the polling fallback.
        startPolling();
      }
    } else if (url && !WebSocketImpl) {
      // A dev server is present but this environment has no WebSocket at all —
      // poll from the start.
      startPolling();
    }
    // else (url === null): file:// / ui:// — no dev server to reach; the
    // postMessage bridge above is the only live channel, by design.

    return function teardown() {
      torn = true;
      if (win && typeof win.removeEventListener === "function") {
        win.removeEventListener("message", onMessage);
      }
      if (socket) {
        socket.onmessage = socket.onerror = socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      if (pollTimer && clearIntervalImpl) {
        clearIntervalImpl(pollTimer);
        pollTimer = null;
      }
    };
  }

  /**
   * Read the manifest inlined by the embedded `ui://genie/grid` tier (M4-06):
   * a `<script type="application/json" id="manifest">` data island whose text
   * content is the compiled manifest JSON. Returns the parsed object, or
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
        var inlineSearch = doc.defaultView && doc.defaultView.location;
        renderGrid(doc, grid, filterManifestBySearch(inline, inlineSearch?.search || ""));
        wireSearch(doc, grid);
        // M4-04 (DRO-266) — this tier is EXACTLY who the postMessage bridge
        // exists for (its strict CSP, connect-src 'none', blocks fetch AND a
        // direct WebSocket alike — see initHmr's own header). hmrSocketUrl
        // resolves to null here (no http(s) origin with a host — see its own
        // doc), so initHmr transparently skips the WS + polling paths and
        // wires ONLY the `message` listener: no network access is attempted,
        // satisfying the CSP without special-casing this branch. Omitting
        // this call (as an earlier revision did) left the bridge dead code in
        // the one tier it was built for. Best-effort, like the fetch path
        // below: a throw here must never take down an otherwise-good render.
        var teardownHmr = function () {};
        try {
          teardownHmr = initHmr(doc, { initialManifest: inline });
        } catch {
          /* live refresh is an enhancement, never a boot blocker */
        }
        if (doc.querySelector(`meta[name="${TOOL_RESULT_SHELL_META}"]`)) {
          initMcpApp(doc, { onTeardown: teardownHmr });
        }
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
        var fetchedLocation = doc.defaultView && doc.defaultView.location;
        renderGrid(doc, grid, filterManifestBySearch(manifest, fetchedLocation?.search || ""));
        wireSearch(doc, grid);

        // M4-04 (DRO-266) — engage live per-card refresh AFTER the grid exists,
        // handing the just-fetched manifest in as the polling baseline so the
        // fallback's very first tick can already spot a hash change. Best-effort:
        // if it throws (an exotic embed with no window at all), the static grid
        // still stands. The teardown fn is intentionally unused here — the
        // browser page lives until navigation; tests call `initHmr` directly and
        // own their own teardown.
        try {
          initHmr(doc, { initialManifest: manifest });
        } catch {
          /* live refresh is an enhancement, never a boot blocker */
        }
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
    window.__genieViewerTestHooks.accessibleName = accessibleName;
    window.__genieViewerTestHooks.createCard = createCard;
    window.__genieViewerTestHooks.renderGrid = renderGrid;
    window.__genieViewerTestHooks.filterManifestBySearch = filterManifestBySearch;
    window.__genieViewerTestHooks.renderToolResult = renderToolResult;
    window.__genieViewerTestHooks.initMcpApp = initMcpApp;
    window.__genieViewerTestHooks.applyFilter = applyFilter;
    window.__genieViewerTestHooks.readInlineManifest = readInlineManifest;
    window.__genieViewerTestHooks.wireSearch = wireSearch;
    window.__genieViewerTestHooks.MANIFEST_ELEMENT_ID = MANIFEST_ELEMENT_ID;
    window.__genieViewerTestHooks.boot = boot;
    // M4-04 (DRO-266) — HMR client seam.
    window.__genieViewerTestHooks.HMR_PATH = HMR_PATH;
    window.__genieViewerTestHooks.HMR_CACHE_BUST_PARAM = HMR_CACHE_BUST_PARAM;
    window.__genieViewerTestHooks.HMR_POLL_INTERVAL_MS = HMR_POLL_INTERVAL_MS;
    window.__genieViewerTestHooks.normalizeHmrMessage = normalizeHmrMessage;
    window.__genieViewerTestHooks.reloadCardByPath = reloadCardByPath;
    window.__genieViewerTestHooks.reloadAllCards = reloadAllCards;
    window.__genieViewerTestHooks.applyHmrMessage = applyHmrMessage;
    window.__genieViewerTestHooks.diffManifestHashes = diffManifestHashes;
    window.__genieViewerTestHooks.manifestStructureChanged = manifestStructureChanged;
    window.__genieViewerTestHooks.renderManifestUpdate = renderManifestUpdate;
    window.__genieViewerTestHooks.bumpReloadCounter = bumpReloadCounter;
    window.__genieViewerTestHooks.hmrSocketUrl = hmrSocketUrl;
    window.__genieViewerTestHooks.initHmr = initHmr;
  }
})();
