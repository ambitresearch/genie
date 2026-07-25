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
  var TOOL_RESULT_EMBEDDED_MANIFEST_META_KEY = "genie/embeddedManifest";
  var MCP_APP_PROTOCOL_VERSION = "2026-01-26";
  var mcpAppRequestId = 0;
  var LIST_KITS_TOOL = "mcp__genie__list_kits";
  var CONJURE_TOOL = "mcp__genie__conjure";
  var LIST_FILES_TOOL = "mcp__genie__list_files";
  var READ_FILE_TOOL = "mcp__genie__read_file";
  var LIST_COMPONENTS_TOOL = "mcp__genie__list_components";

  /**
   * Kit-relative path prefix that marks a file as design-token source (genie#239).
   * `create_kit`'s starter tree and every fixture/demo kit put token files
   * under `tokens/` (see `packages/viewer/test/fixtures/kit/tokens/colors.css`),
   * so this is the same convention `conjure`'s system prompt already asks the
   * model to look for (tokens, primitives, house style) — just resolved from
   * real kit files instead of the caller inventing them.
   */
  var TOKENS_DIR_PREFIX = "tokens/";

  /**
   * Canonical root stylesheet a kit may keep its shared variables/import
   * closure in, alongside (or instead of) `tokens/**`. The viewer's own
   * static serving (`packages/viewer/README.md:106`, `packages/viewer/src/
   * config.ts:234`) and HMR both treat root `styles.css` as token context, so
   * `buildKitContext` must include it too — otherwise a kit that keeps its
   * house style here (rather than under `tokens/`) sends no styling context
   * at all (Copilot review on #246).
   */
  var ROOT_STYLES_PATH = "styles.css";

  /**
   * Hard caps on how much kit context genie#239's `buildKitContext` will ever
   * read into the `conjure` call. `read_file` already caps a single file at
   * 256 KiB (`MAX_FILE_BYTES`, read_file.ts) — this bounds the *count* of
   * token files read (a kit could have dozens) and the *total* character
   * budget handed to the model, so a token-heavy kit can't balloon the
   * request or blow past `conjure`'s own 100_000-char `kit` field cap
   * (conjure.ts `conjureInputShape`).
   */
  var KIT_CONTEXT_MAX_TOKEN_FILES = 12;
  var KIT_CONTEXT_MAX_CHARS = 20_000;

  /**
   * How many existing components' file contents `buildKitContext` will read
   * for primitive/house-style context, beyond the bare group/name inventory
   * (Copilot review on #246: metadata alone gives the model no actual
   * primitive code to match). Small — a handful of representative components
   * is enough context without ballooning the request.
   */
  var KIT_CONTEXT_MAX_COMPONENT_FILES = 5;

  /**
   * Overall wall-clock budget (ms) for ALL of `buildKitContext`'s tool calls
   * combined. Each individual `read_file`/`list_*` call still inherits the
   * host bridge's normal per-call timeout (60s), so serial reads could
   * otherwise stall `conjure` by many minutes (Copilot review on #246).
   * Context-gathering is best-effort by design, so once this deadline is hit
   * we proceed with whatever partial context has resolved so far rather than
   * waiting on slower calls.
   */
  var KIT_CONTEXT_DEADLINE_MS = 8_000;

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

  /**
   * Copilot #1 — extract the embedded manifest a `ui/notifications/tool-
   * result` payload carries, using the SAME resolution order
   * `renderToolResult` itself uses (`_meta` key first, then
   * `structuredContent.embeddedManifest`), so the Browse workbench and the
   * hidden `#grid` are always kept in sync from one source of truth.
   *
   * @param {object} result
   * @returns {object|null}
   */
  function extractToolResultManifest(result) {
    var structured = result && result.structuredContent;
    var metadata = result && result._meta;
    var embeddedManifest =
      metadata && metadata[TOOL_RESULT_EMBEDDED_MANIFEST_META_KEY] !== undefined
        ? metadata[TOOL_RESULT_EMBEDDED_MANIFEST_META_KEY]
        : structured && structured.embeddedManifest;
    return embeddedManifest && canRenderEmbeddedManifest(embeddedManifest)
      ? embeddedManifest
      : null;
  }

  function renderToolResult(doc, grid, result) {
    restoreShellHeader(doc);
    var structured = result && result.structuredContent;
    var metadata = result && result._meta;
    var embeddedManifest =
      metadata && metadata[TOOL_RESULT_EMBEDDED_MANIFEST_META_KEY] !== undefined
        ? metadata[TOOL_RESULT_EMBEDDED_MANIFEST_META_KEY]
        : structured && structured.embeddedManifest;
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
    if (embeddedManifest && canRenderEmbeddedManifest(embeddedManifest)) {
      renderGrid(doc, grid, embeddedManifest);
      return true;
    }

    if (typeof structured.embeddedError === "string" && structured.embeddedError) {
      renderError(doc, grid, structured.embeddedError);
      return false;
    }

    if (structured.locality !== "local" && embeddedManifest) {
      renderError(
        doc,
        grid,
        "remote previews require GENIE_PREVIEWS_BASE_URL so cards run on a declared origin",
      );
      return false;
    }

    var rawUrl = structured && structured.viewerUrl;
    if (structured.locality !== "local" || typeof rawUrl !== "string") {
      if (embeddedManifest) {
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
    var onReady = typeof opts.onReady === "function" ? opts.onReady : function () {};
    var onUnavailable =
      typeof opts.onUnavailable === "function" ? opts.onUnavailable : function () {};
    var win = "win" in opts ? opts.win : typeof window !== "undefined" ? window : undefined;
    if (
      !win ||
      !win.parent ||
      win.parent === win ||
      typeof win.addEventListener !== "function" ||
      typeof win.parent.postMessage !== "function"
    ) {
      // No host frame to hand-shake with. Resolve the shell out of its pending
      // state so a caller that started it as `undefined` (the inline tier) can't
      // get stranded showing a spinner forever — mirrors the old non-host path
      // that went straight to `initProductShell(doc, null)` (immediate
      // unavailable). Embedded frames never reach here (parent !== win).
      onUnavailable();
      return function () {};
    }

    var host = win.parent;
    var initializeId = ++mcpAppRequestId;
    var resizeObserver = null;
    var lastWidth = -1;
    var lastHeight = -1;
    var tornDown = false;
    var hostBridge = null;
    var initializeTimer = null;
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
      if (initializeTimer !== null) win.clearTimeout(initializeTimer);
      if (hostBridge) hostBridge.destroy();
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
        if (initializeTimer !== null) {
          win.clearTimeout(initializeTimer);
          initializeTimer = null;
        }
        // A host can complete the `ui/initialize` handshake without actually
        // advertising tool-proxy support. MCP Apps signals that support via
        // `hostCapabilities.serverTools` in the InitializeResult — gate on it
        // explicitly instead of treating any successful reply as "ready",
        // otherwise a handshake-only host still enables Conjure and only
        // fails later at `tools/call` time.
        var serverToolsAvailable = Boolean(
          data.result && data.result.hostCapabilities && data.result.hostCapabilities.serverTools,
        );
        if (!serverToolsAvailable) {
          post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
          onUnavailable();
          return;
        }
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
        hostBridge = createHostBridge(win, host, opts.onProgress);
        onReady(hostBridge, data.result);
        notifySize();
        observeSize();
        return;
      }
      if (data.method === "ui/notifications/tool-result") {
        var grid = doc.getElementById("grid");
        if (grid) {
          renderToolResult(doc, grid, data.params);
          notifySize();
          // Copilot #1 — keep the Browse workbench (not just the hidden
          // `#grid`) in sync with every live tool-result update, the same
          // manifest source `renderToolResult` just wrote into `#grid`.
          if (typeof opts.onToolResult === "function") opts.onToolResult(data.params);
        }
      }
    }

    win.addEventListener("message", onMessage);
    if (typeof opts.onUnavailable === "function") {
      initializeTimer = win.setTimeout(function () {
        initializeTimer = null;
        onUnavailable();
      }, 3000);
    }
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

  function normalizeRoute(route) {
    return route === "browse" || route === "review" ? route : "generate";
  }

  function writeRoute(win, route, replace) {
    try {
      var next = new win.URL(win.location.href);
      next.searchParams.set("route", normalizeRoute(route));
      win.history[replace ? "replaceState" : "pushState"]({}, "", next);
    } catch {
      /* opaque/about:blank embedded origins cannot persist history */
    }
  }

  function canConjure(state) {
    return Boolean(
      state &&
      typeof state.prompt === "string" &&
      state.prompt.trim().length >= 3 &&
      state.kitId &&
      state.model &&
      state.hostAvailable &&
      !state.inFlight,
    );
  }

  function selectInitialKit(kits, remembered) {
    var editable = Array.isArray(kits)
      ? kits.filter(function (kit) {
          return kit && kit.canEdit === true && typeof kit.id === "string" && kit.id;
        })
      : [];
    if (
      remembered &&
      editable.some(function (kit) {
        return kit.id === remembered;
      })
    ) {
      return remembered;
    }
    return editable.length === 1 ? editable[0].id : "";
  }

  function isConjureResult(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.componentName === "string" &&
      value.componentName.trim() &&
      typeof value.group === "string" &&
      Array.isArray(value.files) &&
      value.manifestEntry &&
      typeof value.manifestEntry === "object" &&
      value.usage &&
      typeof value.usage === "object",
    );
  }

  function createDraftStore() {
    var drafts = [];
    return {
      add: function (result) {
        var number = drafts.length + 1;
        var draft = { number: number, label: "draft #" + number, result: result };
        drafts.push(draft);
        return draft;
      },
      current: function () {
        return drafts.length ? drafts[drafts.length - 1] : null;
      },
    };
  }

  function safeHostMessage(value, fallback) {
    var message = typeof value === "string" && value.trim() ? value.trim() : fallback;
    return message
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
      .replace(/\b(api[-_ ]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
      .slice(0, 500);
  }

  function hostErrorMessage(result) {
    if (result && result.error) {
      return safeHostMessage(result.error.message, "The host rejected the request.");
    }
    var content = result && result.result && result.result.content;
    if (Array.isArray(content)) {
      for (var i = 0; i < content.length; i++) {
        if (content[i] && content[i].type === "text" && typeof content[i].text === "string") {
          try {
            var parsed = JSON.parse(content[i].text);
            if (parsed && typeof parsed.message === "string") {
              return safeHostMessage(parsed.message, "The tool returned an error.");
            }
          } catch {
            return safeHostMessage(content[i].text, "The tool returned an error.");
          }
        }
      }
    }
    return "The tool returned an error.";
  }

  /**
   * @typedef {{callTool(name:string,args:object):Promise<object>,destroy():void}} HostBridge
   */
  function createHostBridge(win, host, onProgress, timeoutMs) {
    var pending = new Map();
    var timeout = typeof timeoutMs === "number" ? timeoutMs : 60_000;
    function onMessage(event) {
      if (!event || event.source !== host || !event.data || typeof event.data !== "object") return;
      var data = event.data;
      if (data.method === "notifications/progress") {
        if (typeof onProgress === "function") {
          onProgress(
            safeHostMessage(data.params && data.params.message, "Conjuring your component…"),
          );
        }
        return;
      }
      if (!pending.has(data.id)) return;
      var request = pending.get(data.id);
      pending.delete(data.id);
      win.clearTimeout(request.timer);
      if (data.error || (data.result && data.result.isError)) {
        request.reject(new Error(hostErrorMessage(data)));
        return;
      }
      var structured = data.result && data.result.structuredContent;
      if (!structured || typeof structured !== "object") {
        request.reject(new Error("The host returned a malformed tool result."));
        return;
      }
      request.resolve(structured);
    }
    win.addEventListener("message", onMessage);
    return {
      callTool: function (name, args) {
        var id = ++mcpAppRequestId;
        return new Promise(function (resolve, reject) {
          var timer = win.setTimeout(function () {
            pending.delete(id);
            reject(new Error("The host tool request timed out. Try again."));
          }, timeout);
          pending.set(id, { resolve: resolve, reject: reject, timer: timer });
          host.postMessage(
            {
              jsonrpc: "2.0",
              id: id,
              method: "tools/call",
              params: { name: name, arguments: args },
            },
            "*",
          );
        });
      },
      destroy: function () {
        win.removeEventListener("message", onMessage);
        for (var request of pending.values()) {
          win.clearTimeout(request.timer);
          request.reject(new Error("The host closed the viewer."));
        }
        pending.clear();
      },
    };
  }

  function initProductShell(doc, bridge) {
    var win = doc.defaultView;
    var form = doc.getElementById("generate-form");
    if (!win || !form) return;
    var prompt = doc.getElementById("generate-prompt");
    var kitSelect = doc.getElementById("kit-select");
    var modelSelect = doc.getElementById("model-select");
    var submit = doc.getElementById("conjure-button");
    var kitState = doc.getElementById("kit-state");
    var errorBox = doc.getElementById("generate-error");
    var errorDetail = doc.getElementById("generate-error-detail");
    var retry = doc.getElementById("generate-retry");
    var progress = doc.getElementById("generate-progress");
    var progressCopy = doc.getElementById("generate-progress-copy");
    var status = doc.getElementById("app-status");
    var drafts = createDraftStore();
    var kits = [];
    var inFlight = false;
    var hostAvailable = Boolean(bridge);
    var hostPending = bridge === undefined;

    function renderRoute(route, focusView) {
      var selected = normalizeRoute(route);
      var views = doc.querySelectorAll("[data-route-view]");
      for (var i = 0; i < views.length; i++) {
        views[i].hidden = views[i].getAttribute("data-route-view") !== selected;
      }
      var links = doc.querySelectorAll("[data-route-link]");
      for (var j = 0; j < links.length; j++) {
        if (links[j].getAttribute("data-route-link") === selected) {
          links[j].setAttribute("aria-current", "page");
        } else {
          links[j].removeAttribute("aria-current");
        }
      }
      // On an explicit route change, move keyboard focus into the newly shown
      // view so the next action starts predictably there — and, critically, so
      // focus is never left inside a now-hidden subtree (e.g. the Conjure button
      // after routing to Review on success). Skipped on initial load/popstate so
      // we don't steal focus the user didn't ask to move.
      if (focusView) {
        if (selected === "generate") {
          prompt.focus();
        } else if (selected === "review") {
          var draftReview = doc.getElementById("draft-review");
          var heading =
            draftReview && !draftReview.hidden
              ? doc.getElementById("draft-name")
              : doc.getElementById("review-empty-heading");
          if (heading) heading.focus();
        }
      }
    }

    function navigate(route, replace, focusView) {
      writeRoute(win, route, replace);
      renderRoute(route, focusView);
    }

    function updateGate() {
      submit.disabled = !canConjure({
        prompt: prompt.value,
        kitId: kitSelect.value,
        model: modelSelect.value,
        hostAvailable: hostAvailable,
        inFlight: inFlight,
      });
    }

    function showError(error) {
      errorDetail.textContent = safeHostMessage(
        error && error.message,
        "The host could not complete this request.",
      );
      errorBox.hidden = false;
      progress.hidden = true;
      errorBox.focus();
      updateGate();
    }

    function showProgress(message) {
      progressCopy.textContent = safeHostMessage(message, "Conjuring your component…");
      progress.hidden = false;
    }

    /**
     * True when a kit-relative path is design-token/house-style source: either
     * inside `tokens/**` or the canonical root `styles.css` (Copilot review on
     * #246 — the root file carries a kit's shared variables/import closure
     * just as much as `tokens/**` does; see `ROOT_STYLES_PATH`'s doc comment).
     */
    function isKitStyleContextFile(path) {
      return path === ROOT_STYLES_PATH || path.indexOf(TOKENS_DIR_PREFIX) === 0;
    }

    /**
     * Resolve `promise` but never wait longer than `ms` for it: resolves to
     * `null` (rather than rejecting) on timeout OR on the wrapped promise's own
     * rejection, so callers can `Promise.all` a batch of these without any one
     * slow/failing call sinking the others or the overall deadline (Copilot
     * review on #246 — `buildKitContext`'s tool calls used to run serially,
     * each inheriting the host bridge's full 60s per-call timeout).
     */
    function withDeadline(promise, ms) {
      return new Promise(function (resolve) {
        var settled = false;
        var timer = win.setTimeout(
          function () {
            if (settled) return;
            settled = true;
            resolve(null);
          },
          Math.max(0, ms),
        );
        promise.then(
          function (value) {
            if (settled) return;
            settled = true;
            win.clearTimeout(timer);
            resolve(value);
          },
          function () {
            if (settled) return;
            settled = true;
            win.clearTimeout(timer);
            resolve(null);
          },
        );
      });
    }

    /**
     * genie#239 — resolve the SELECTED kit's real compiled context (tokens +
     * primitives/components) instead of handing `conjure` just its display
     * name. Reuses tools the viewer's host already exposes — `list_files`,
     * `read_file`, `list_components` — so this needs no new server contract
     * and `conjure`'s `kit` field stays the free-form string it already is
     * (#233/M7-01: "reuse the existing conjure contract, this is not a
     * redesign of the generation engine").
     *
     * All tool calls (the two `list_*` calls, then every `read_file` call) run
     * CONCURRENTLY and share one overall `KIT_CONTEXT_DEADLINE_MS` wall-clock
     * budget — not the host bridge's full per-call timeout — so a slow or
     * unresponsive host can delay `conjure` by at most that budget, not by
     * minutes (Copilot review on #246).
     *
     * Best-effort by design: any tool failure or deadline miss here (a host
     * that doesn't implement these verbs yet, a slow kit, etc.) degrades to
     * partial context, and total failure falls back to the OLD
     * display-name-only behavior rather than blocking generation — losing
     * kit-fidelity is strictly better than losing the ability to generate at
     * all.
     *
     * @param {{callTool(name:string,args:object):Promise<object>}} hostBridge
     * @param {string} kitId
     * @param {string} kitName
     * @param {number} [deadlineMs] Overall wall-clock budget in ms. Defaults
     *   to `KIT_CONTEXT_DEADLINE_MS`; overridable so tests can exercise the
     *   "deadline elapses" path without waiting on the real production
     *   value (Copilot review on #246 — a test previously waited on the
     *   real 8s `KIT_CONTEXT_DEADLINE_MS`, adding 8s of real wall-clock time
     *   to every run that hit it).
     * @returns {Promise<string>}
     */
    async function buildKitContext(hostBridge, kitId, kitName, deadlineMs) {
      var sections = ['UI kit "' + kitName + '" (id: ' + kitId + ")."];
      var budget = KIT_CONTEXT_MAX_CHARS - sections[0].length;
      var deadline =
        Date.now() + (typeof deadlineMs === "number" ? deadlineMs : KIT_CONTEXT_DEADLINE_MS);
      function remaining() {
        return deadline - Date.now();
      }

      var results = await Promise.all([
        withDeadline(hostBridge.callTool(LIST_FILES_TOOL, { kitId: kitId }), remaining()),
        withDeadline(hostBridge.callTool(LIST_COMPONENTS_TOOL, { kitId: kitId }), remaining()),
      ]);
      var filesReply = results[0];
      var componentsReply = results[1];

      var files = Array.isArray(filesReply && filesReply.files) ? filesReply.files : [];
      // Root `styles.css` is prioritized ahead of `tokens/**` entries so it
      // survives KIT_CONTEXT_MAX_TOKEN_FILES truncation on token-heavy kits.
      var styleFiles = files
        .filter(function (entry) {
          return entry && typeof entry.path === "string" && isKitStyleContextFile(entry.path);
        })
        .sort(function (a, b) {
          return (a.path === ROOT_STYLES_PATH ? 0 : 1) - (b.path === ROOT_STYLES_PATH ? 0 : 1);
        })
        .slice(0, KIT_CONTEXT_MAX_TOKEN_FILES);

      var components = Array.isArray(componentsReply && componentsReply.components)
        ? componentsReply.components
        : [];
      var componentSampleTargets = components
        .filter(function (entry) {
          return entry && typeof entry.path === "string";
        })
        .slice(0, KIT_CONTEXT_MAX_COMPONENT_FILES);

      // Read every style file and the bounded component sample concurrently —
      // each individually capped by the SAME shared deadline — rather than in
      // series, so one slow file can't crowd out the rest of the budget.
      var readTargets = styleFiles
        .map(function (entry) {
          return { path: entry.path, label: entry.path };
        })
        .concat(
          componentSampleTargets.map(function (entry) {
            return {
              path: entry.path,
              label: entry.group + "/" + entry.name + " (" + entry.path + ")",
            };
          }),
        );

      var reads = await Promise.all(
        readTargets.map(function (target) {
          return withDeadline(
            hostBridge.callTool(READ_FILE_TOOL, { kitId: kitId, path: target.path }),
            remaining(),
          ).then(function (fileReply) {
            return { label: target.label, fileReply: fileReply };
          });
        }),
      );

      var styleReadCount = styleFiles.length;
      for (var i = 0; i < reads.length && budget > 0; i++) {
        var isStyleRead = i < styleReadCount;
        var fileReply = reads[i].fileReply;
        if (fileReply && fileReply.encoding === "utf-8" && typeof fileReply.content === "string") {
          var heading = isStyleRead
            ? "--- " + reads[i].label + " ---"
            : "--- component: " + reads[i].label + " ---";
          // The heading itself counts against `budget` too — slicing only the
          // file content and then prepending the heading on top of that
          // slice let the assembled chunk exceed `budget` (Copilot review on
          // #246).
          var contentBudget = budget - heading.length - 1; /* -1 for the "\n" join */
          if (contentBudget <= 0) continue;
          var chunk = heading + "\n" + fileReply.content.slice(0, contentBudget);
          sections.push(chunk);
          budget -= chunk.length;
        }
        /* an unreadable/timed-out file must not sink the whole context. */
      }

      if (components.length && budget > 0) {
        var namesPrefix = "Existing primitives/components: ";
        var names = components
          .map(function (component) {
            return component.group + "/" + component.name;
          })
          .join(", ");
        // Same accounting bug as above: this line was appended unconditionally
        // AFTER the budget-tracked loop, so it could push the assembled
        // context past KIT_CONTEXT_MAX_CHARS (and conjure's own kit-schema
        // cap) regardless of how much budget remained. Truncate to what's left.
        var namesBudget = budget - namesPrefix.length;
        if (namesBudget > 0) {
          sections.push(namesPrefix + names.slice(0, namesBudget));
        }
      }

      // Belt-and-suspenders: the per-chunk budget accounting above should
      // already keep the assembled string within KIT_CONTEXT_MAX_CHARS, but
      // the "\n\n" join separators between sections aren't accounted for in
      // `budget`, so hard-cap the final string as a last line of defense
      // (Copilot review on #246).
      var assembled = sections.join("\n\n");
      return assembled.length > KIT_CONTEXT_MAX_CHARS
        ? assembled.slice(0, KIT_CONTEXT_MAX_CHARS)
        : assembled;
    }

    function renderDraft(draft) {
      doc.getElementById("review-empty").hidden = true;
      doc.getElementById("draft-review").hidden = false;
      doc.getElementById("draft-label").textContent = draft.label;
      doc.getElementById("draft-name").textContent = draft.result.componentName;
      var summary = doc.getElementById("draft-summary");
      summary.replaceChildren();
      var values = [
        ["UI kit", kitSelect.options[kitSelect.selectedIndex].textContent],
        ["Group", draft.result.group],
        ["Proposed files", String(draft.result.files.length)],
        ["Model", modelSelect.options[modelSelect.selectedIndex].textContent],
      ];
      for (var i = 0; i < values.length; i++) {
        var dt = doc.createElement("dt");
        var dd = doc.createElement("dd");
        dt.textContent = values[i][0];
        dd.textContent = values[i][1];
        summary.append(dt, dd);
      }
    }

    async function submitGenerate(event) {
      if (event) event.preventDefault();
      if (
        !canConjure({
          prompt: prompt.value,
          kitId: kitSelect.value,
          model: modelSelect.value,
          hostAvailable: hostAvailable,
          inFlight: inFlight,
        })
      )
        return;
      var selectedKit = kits.find(function (kit) {
        return kit.id === kitSelect.value;
      });
      if (!selectedKit) return;
      inFlight = true;
      errorBox.hidden = true;
      showProgress("Conjuring your component…");
      prompt.disabled = true;
      kitSelect.disabled = true;
      modelSelect.disabled = true;
      submit.textContent = "✦ Conjuring…";
      updateGate();
      try {
        // genie#239 — resolve the real kit context (tokens/primitives), not
        // just the display name. Best-effort: falls back to `selectedKit.name`
        // alone if context-gathering throws (see buildKitContext's header).
        var kitContext = selectedKit.name;
        try {
          kitContext = await buildKitContext(bridge, selectedKit.id, selectedKit.name);
        } catch {
          /* fall back to the display name — generation must still proceed. */
        }
        var result = await bridge.callTool(CONJURE_TOOL, {
          kitId: selectedKit.id,
          kit: kitContext,
          prompt: prompt.value.trim(),
          model: modelSelect.value,
        });
        if (!isConjureResult(result)) throw new Error("The host returned an invalid draft.");
        var draft = drafts.add(result);
        renderDraft(draft);
        status.textContent = "Generated " + result.componentName + ", " + draft.label + ".";
        navigate("review", false, true);
      } catch (error) {
        showError(error);
      } finally {
        inFlight = false;
        prompt.disabled = false;
        kitSelect.disabled = kits.length === 0;
        modelSelect.disabled = false;
        submit.replaceChildren();
        var spark = doc.createElement("span");
        spark.setAttribute("aria-hidden", "true");
        spark.textContent = "✦";
        submit.append(spark, " Conjure");
        progress.hidden = true;
        updateGate();
      }
    }

    async function loadKits() {
      if (hostPending) return;
      if (!bridge) {
        kitState.textContent =
          "Conjure requires an MCP-capable host. Use the genie MCP workflow from your coding host.";
        kitSelect.replaceChildren();
        var unavailable = doc.createElement("option");
        unavailable.textContent = "Host unavailable";
        unavailable.value = "";
        kitSelect.appendChild(unavailable);
        updateGate();
        return;
      }
      try {
        var reply = await bridge.callTool(LIST_KITS_TOOL, {});
        if (!Array.isArray(reply.kits)) throw new Error("The host returned malformed UI-kit data.");
        kits = reply.kits.filter(function (kit) {
          return (
            kit &&
            kit.canEdit === true &&
            typeof kit.id === "string" &&
            typeof kit.name === "string"
          );
        });
        kitSelect.replaceChildren();
        if (!kits.length) {
          var empty = doc.createElement("option");
          empty.value = "";
          empty.textContent = "No editable UI kits";
          kitSelect.appendChild(empty);
          kitSelect.disabled = true;
          kitState.textContent = "No kits yet — create or connect a UI kit first in your host.";
        } else {
          if (kits.length > 1) {
            var choose = doc.createElement("option");
            choose.value = "";
            choose.textContent = "Choose a UI kit…";
            kitSelect.appendChild(choose);
          }
          for (var i = 0; i < kits.length; i++) {
            var option = doc.createElement("option");
            option.value = kits[i].id;
            option.textContent = kits[i].name + " · " + (kits[i].owner || "local");
            kitSelect.appendChild(option);
          }
          kitSelect.value = selectInitialKit(kits, "");
          kitSelect.disabled = false;
          kitState.textContent =
            kits.length === 1
              ? "Using " + kits[0].name + "."
              : "Choose the UI kit this draft should match.";
        }
      } catch (error) {
        kitState.textContent = "UI kits could not be loaded.";
        showError(error);
      }
      updateGate();
    }

    doc.addEventListener("click", function (event) {
      var link = event.target && event.target.closest && event.target.closest("[data-route-link]");
      if (!link) return;
      event.preventDefault();
      navigate(link.getAttribute("data-route-link"), false, true);
    });
    win.addEventListener("popstate", function () {
      renderRoute(new win.URL(win.location.href).searchParams.get("route"), false);
    });
    prompt.addEventListener("input", updateGate);
    kitSelect.addEventListener("change", updateGate);
    modelSelect.addEventListener("change", updateGate);
    prompt.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submitGenerate(event);
    });
    form.addEventListener("submit", function (event) {
      void submitGenerate(event);
    });
    retry.addEventListener("click", function () {
      // The one retry button covers two distinct failures. If kit discovery is
      // what failed, no kit is selected and submitGenerate() early-returns —
      // leaving the user stuck without a reload. So when the host is present but
      // no kits loaded, retry discovery; otherwise retry the generation.
      if (bridge && kits.length === 0) {
        errorBox.hidden = true;
        void loadKits();
        return;
      }
      void submitGenerate();
    });
    var initialRoute = normalizeRoute(new win.URL(win.location.href).searchParams.get("route"));
    navigate(initialRoute, true, initialRoute === "generate");
    void loadKits();

    // M7-02 (#234) AC11 — persist the exact Refine handoff context Browse
    // hands off, and render it into the Review empty-state (no consumer
    // beyond that existed before this issue; full refine/apply is M7-03).
    function renderRefineContext(context) {
      var dl = doc.getElementById("review-refine-context");
      if (!dl) return;
      dl.replaceChildren();
      if (!context) {
        dl.hidden = true;
        return;
      }
      var rows = [
        ["UI kit", context.kitId],
        ["Group", context.group],
        ["Component", context.componentName],
        ["Variant", context.variant],
      ];
      for (var i = 0; i < rows.length; i++) {
        var dt = doc.createElement("dt");
        dt.textContent = rows[i][0];
        var dd = doc.createElement("dd");
        dd.textContent = rows[i][1] || "Not provided";
        dl.append(dt, dd);
      }
      dl.hidden = false;
    }

    return {
      setBridge: function (nextBridge) {
        bridge = nextBridge;
        hostAvailable = Boolean(nextBridge);
        hostPending = false;
        kitState.textContent = "Discovering editable UI kits…";
        void loadKits();
      },
      setUnavailable: function () {
        bridge = null;
        hostAvailable = false;
        hostPending = false;
        void loadKits();
      },
      showProgress: function (message) {
        if (inFlight) showProgress(message);
      },
      setRefineContext: renderRefineContext,
      // Exposed for direct unit testing of context-gathering behavior (token
      // files, root styles.css, component sampling, deadline handling)
      // without having to drive the full submitGenerate flow end to end.
      // `deadlineMs` lets tests override KIT_CONTEXT_DEADLINE_MS so the
      // "deadline elapses" case doesn't have to wait on the real 8s value.
      buildKitContext: function (hostBridge, kitId, kitName, deadlineMs) {
        return buildKitContext(hostBridge, kitId, kitName, deadlineMs);
      },
    };
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

  // ── Browse UI-kit workbench (M7-02 / #234) ─────────────────────────────────
  //
  // Turns the M4 grid into a navigable tree + component-detail workbench,
  // reusing the same manifest, iframe sandbox, and HMR machinery above.
  // Everything here is additive: `renderGrid`/`applyFilter`/HMR are untouched,
  // and this module only reads the manifest — it never mutates it (AC2/AC3).
  //
  // Design reference: `docs/designs/design-6/01-ui-kit-browser.svg` +
  // `design.md` §§7, 11-14. Decision #5 (issue #234): the shipped manifest
  // carries NO variant concept (`store/manifest.ts` / `manifest/compiler.ts`
  // have no `variant` field) — so `computeVariantTabs` below deliberately
  // renders Default-only with Hover/Focus/Disabled declared-but-disabled,
  // rather than inventing a new schema.

  /**
   * Case-insensitive substring match against a component's name AND group —
   * the same "supported metadata" search scope the product-behavior section
   * of #234 describes. Pure; never mutates its inputs.
   *
   * @param {object} component
   * @param {string} needle — already-lowercased query.
   * @returns {boolean}
   */
  function componentMatchesSearch(component, needle) {
    if (!needle) return true;
    var name = ((component && component.name) || "").toLowerCase();
    var group = ((component && component.group) || "").toLowerCase();
    var tags = Array.isArray(component && component.tags) ? component.tags : [];
    if (name.indexOf(needle) !== -1 || group.indexOf(needle) !== -1) return true;
    for (var i = 0; i < tags.length; i++) {
      if (typeof tags[i] === "string" && tags[i].toLowerCase().indexOf(needle) !== -1) return true;
    }
    return false;
  }

  /**
   * Project a compiled manifest into the Browse tree shape: groups (in the
   * manifest's own deterministic order, via {@link computeGroupOrder}), each
   * holding its matching components, plus overall counts and the two
   * distinct "nothing to show" flags AC4 requires:
   *   - `isEmptyKit`  — the KIT itself has zero components (no search applied
   *     or not — an empty kit is empty regardless of the query).
   *   - `isNoMatch`   — the kit has components, but the current `search`
   *     matched none of them.
   * Never mutates `manifest`.
   *
   * @param {object} manifest
   * @param {string=} search
   * @returns {{ groups: Array<{name:string,count:number,components:Array<object>}>, totalCount: number, isEmptyKit: boolean, isNoMatch: boolean }}
   */
  function projectManifestToTree(manifest, search) {
    var components = (manifest && manifest.components) || [];
    var isEmptyKit = components.length === 0;
    var needle = (search || "").trim().toLowerCase();

    var grouped = groupByGroup(components);
    var order = computeGroupOrder(manifest && manifest.groups, grouped);

    var groups = [];
    var totalCount = 0;
    for (var i = 0; i < order.length; i++) {
      var groupName = order[i];
      var cards = grouped.get(groupName) || [];
      var matched = [];
      for (var j = 0; j < cards.length; j++) {
        if (componentMatchesSearch(cards[j], needle)) {
          matched.push({
            componentName: cards[j].name,
            group: cards[j].group,
            path: cards[j].path,
            sourcePath: cards[j].sourcePath,
            viewport: cards[j].viewport,
            hash: cards[j].hash,
            lastModified: cards[j].lastModified,
            subtitle: cards[j].subtitle,
            tags: cards[j].tags,
          });
        }
      }
      if (matched.length === 0) continue;
      groups.push({ name: groupName, count: matched.length, components: matched });
      totalCount += matched.length;
    }

    return {
      groups: groups,
      totalCount: totalCount,
      isEmptyKit: isEmptyKit,
      // A kit with data but a query that hid everything is a distinct state
      // from "the kit is empty" (AC4) — never true when the kit itself is
      // empty (that's `isEmptyKit`'s job) or when there is no active query.
      isNoMatch: !isEmptyKit && totalCount === 0 && needle !== "",
    };
  }

  /**
   * Resolve a `{kitId, group, componentName}` selection against a projected
   * tree by STABLE IDENTITY (never DOM/array index — AC3/Decision #7).
   * `kitId` is accepted for the caller's bookkeeping (a future multi-kit
   * host) but the current single-kit tree only disambiguates on
   * `group + componentName`, matching the compiled manifest's own identity.
   *
   * @param {ReturnType<typeof projectManifestToTree>} tree
   * @param {{kitId?: string, group?: string, componentName?: string}} selection
   * @returns {{found: boolean, component: object|null}}
   */
  function resolveSelection(tree, selection) {
    if (!selection || !selection.group || !selection.componentName) {
      return { found: false, component: null };
    }
    var groups = (tree && tree.groups) || [];
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].name !== selection.group) continue;
      var components = groups[i].components || [];
      for (var j = 0; j < components.length; j++) {
        if (components[j].componentName === selection.componentName) {
          return { found: true, component: components[j] };
        }
      }
    }
    return { found: false, component: null };
  }

  /**
   * A UI-kit change always invalidates a prior selection's identity (AC/
   * product-behavior: "changing UI kit clears an invalid prior component
   * selection"). Returns `null` unconditionally — callers choose the new
   * default (first valid component, or none) deterministically themselves;
   * this helper only guarantees the OLD identity is never silently kept.
   *
   * @param {ReturnType<typeof projectManifestToTree>} _tree — the NEW kit's tree.
   * @param {{kitId?: string, group?: string, componentName?: string}} _priorSelection
   * @returns {null}
   */
  function selectionForKitChange(_tree, _priorSelection) {
    return null;
  }

  /**
   * Serialize a selection into `URLSearchParams`-compatible query params —
   * the deep-link contract (Decision #7): `kitId`, `group`, `componentName`
   * all survive refresh without relying on array position.
   *
   * @param {{kitId?: string, group?: string, componentName?: string}} selection
   * @returns {string}
   */
  function serializeSelection(selection) {
    var Params =
      typeof window !== "undefined" && typeof window.URLSearchParams === "function"
        ? window.URLSearchParams
        : typeof URLSearchParams !== "undefined"
          ? URLSearchParams
          : null;
    if (!Params) return "";
    var params = new Params();
    if (selection && selection.kitId) params.set("kitId", selection.kitId);
    if (selection && selection.group) params.set("group", selection.group);
    if (selection && selection.componentName) params.set("componentName", selection.componentName);
    return params.toString();
  }

  /**
   * Parse a deep-link's `URLSearchParams` back into a selection, or `null`
   * when `group`/`componentName` (the two identity-bearing fields) are not
   * BOTH present — a partial link is not a valid selection (AC4's
   * "unknown selection falls back to a controlled not-found state").
   *
   * @param {URLSearchParams} params
   * @returns {{kitId: string, group: string, componentName: string}|null}
   */
  function parseSelection(params) {
    var group = params.get("group");
    var componentName = params.get("componentName");
    if (!group || !componentName) return null;
    return {
      kitId: params.get("kitId") || "",
      group: group,
      componentName: componentName,
    };
  }

  /** Declared variant tabs, in Design 6's fixed order. */
  var VARIANT_TAB_ORDER = ["default", "hover", "focus", "disabled"];

  /**
   * Decision #5 — the compiled manifest carries no variant concept today.
   * Returns the four Design-6 tabs with ONLY `default` marked available;
   * the rest are declared-but-disabled with an accessible reason, never a
   * fabricated rendered state (AC8). If a future manifest version adds a
   * `variants` array, this is the single place that would start reading it.
   *
   * @param {object} component
   * @returns {Array<{id: string, label: string, available: boolean, reason?: string}>}
   */
  function computeVariantTabs(component) {
    var declared =
      component && Array.isArray(component.variants)
        ? component.variants.filter(function (v) {
            return typeof v === "string";
          })
        : [];
    return VARIANT_TAB_ORDER.map(function (id) {
      var label = id.charAt(0).toUpperCase() + id.slice(1);
      if (id === "default" || declared.indexOf(id) !== -1) {
        return { id: id, label: label, available: true };
      }
      return {
        id: id,
        label: label,
        available: false,
        reason: "No variant data available for " + label + ".",
      };
    });
  }

  /** Default truncation length (chars) for the source panel (AC10). */
  var SOURCE_TRUNCATE_LENGTH = 20_000;

  /**
   * Prepare raw source text for safe, plain-text display: never executed,
   * never `innerHTML`'d (callers must use `textContent`), and truncated
   * progressively for large files rather than rendering megabytes inline.
   * Non-string input (a failed/absent read) degrades to an empty, non-
   * truncated result rather than throwing (AC16 — a hostile/malformed read
   * must not take the panel down).
   *
   * @param {unknown} raw
   * @param {number=} limit
   * @returns {{text: string, truncated: boolean, totalLength: number}}
   */
  function sanitizeSourceForDisplay(raw, limit) {
    var max = typeof limit === "number" && limit > 0 ? limit : SOURCE_TRUNCATE_LENGTH;
    if (typeof raw !== "string") return { text: "", truncated: false, totalLength: 0 };
    if (raw.length <= max) return { text: raw, truncated: false, totalLength: raw.length };
    return { text: raw.slice(0, max), truncated: true, totalLength: raw.length };
  }

  /**
   * Build the exact context object Refine hands to Review (AC11): the
   * selected kit/group/component/variant, and nothing else — no mutation,
   * no write. `viewer.js` has no Review-side consumer yet beyond the M7-01
   * shell's empty-draft view (M7-03 is the actual apply workflow); this is a
   * pure, independently-testable data-shaping step so that wiring is a small
   * final piece rather than an untested one.
   *
   * @param {string} kitId
   * @param {object} component
   * @param {string} variant
   * @returns {{kitId: string, group: string, componentName: string, variant: string}}
   */
  function buildRefineContext(kitId, component, variant) {
    return {
      kitId: kitId || "",
      group: (component && component.group) || "",
      componentName: (component && component.componentName) || "",
      variant: variant || "default",
    };
  }

  /**
   * Render the 240px Browse tree: kit header, one labelled section per group
   * with a live count, and keyboard-operable `role="treeitem"` rows (AC/a11y:
   * arrow-key roving tabindex, Home/End, Enter/Space to select). Distinguishes
   * the three "nothing selected yet" states (AC4): empty kit (CTA to
   * Generate), no-filter-match (scoped Clear-filter action), and the normal
   * populated tree.
   *
   * @param {Document} doc
   * @param {HTMLElement} container
   * @param {ReturnType<typeof projectManifestToTree>} tree
   * @param {string|null} activeSearch — current query, for the no-match Clear action.
   * @param {(selection: {group:string, componentName:string}) => void=} onSelect
   * @param {{group:string, componentName:string}|null=} selected
   */
  function renderBrowseTree(doc, container, tree, activeSearch, onSelect, selected) {
    container.replaceChildren();
    var select = typeof onSelect === "function" ? onSelect : function () {};

    var treeEl = doc.createElement("div");
    // Copilot review (PR #248, a11y) — `role="tree"` requires ARIA
    // `treeitem` children (`aria-required-children`); it's only set once we
    // know we're building the REAL tree branch below. The empty-kit and
    // no-match states render a plain message/action instead, so `treeEl`
    // stays a plain unlabeled `div` for those (still gets the rail-toggle/
    // overlay/compact-nav responsive treatment — just not the `tree` role
    // it doesn't structurally satisfy).
    treeEl.className = "browse-tree";
    treeEl.id = "browse-tree-nav";

    // Copilot #13 (AC14, 720–1099px) — a 44px group rail whose activation
    // opens an IDENTIFIABLE overlay tree, rather than only shrinking every
    // row label to its first letter (which left same-initial components
    // visually indistinguishable and offered no way to open real
    // navigation). `.tree-sidebar`'s CSS at this breakpoint hides
    // `#browse-tree-nav` off-canvas by default and only the rail toggle is
    // visible; activating it reveals `#browse-tree-nav` as a real overlay
    // (`browse-tree--overlay-open`) without covering focus invisibly — the
    // toggle itself IS the 44px rail control, and its `aria-expanded`/
    // `aria-controls` make the relationship programmatically discoverable.
    //
    // Copilot review (PR #248) — this rail toggle, the overlay `treeEl`, and
    // the <720px `compactNav` below are now ALWAYS built, even for the
    // empty-kit and no-match states. The earlier revision returned before
    // building any of this responsive chrome for those two states, so at
    // the 720–1099px breakpoint (where `.tree-sidebar` collapses the raw
    // sidebar column to 44px and hides `#browse-tree-nav` off-canvas by
    // default) their message + Clear-filter/Generate action rendered
    // directly inside that 44px column instead of inside the overlay,
    // risking unusable/overflowing layout. The empty/no-match content is
    // now placed INSIDE `treeEl` (see below), so it participates in the
    // same rail/overlay/compact-nav responsive behavior as the real tree.
    var railToggle = doc.createElement("button");
    railToggle.type = "button";
    railToggle.className = "browse-tree__rail-toggle";
    railToggle.setAttribute("aria-haspopup", "true");
    railToggle.setAttribute("aria-expanded", "false");
    railToggle.setAttribute("aria-controls", "browse-tree-nav");
    railToggle.setAttribute("aria-label", "Open UI kit navigation");
    railToggle.textContent = "☰";
    railToggle.addEventListener("click", function () {
      var open = treeEl.classList.toggle("browse-tree--overlay-open");
      railToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        var firstTabbable = treeEl.querySelector(
          '[role="treeitem"][tabindex="0"], [data-clear-filter], [data-route-link]',
        );
        if (firstTabbable && typeof firstTabbable.focus === "function") firstTabbable.focus();
      }
    });
    treeEl.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && treeEl.classList.contains("browse-tree--overlay-open")) {
        treeEl.classList.remove("browse-tree--overlay-open");
        railToggle.setAttribute("aria-expanded", "false");
        railToggle.focus();
      }
    });

    // Copilot #14 (AC14, <720px) — the <720px band collapses into a
    // breadcrumb + `<select>` dropdown compact nav, rather than only
    // stacking the full tree into a 40vh scrolling sidebar (which offered
    // no breadcrumb and no dropdown). `.tree-sidebar`'s CSS shows only this
    // element at that breakpoint.
    var compactNav = doc.createElement("div");
    compactNav.className = "browse-tree__compact-nav";
    var compactBreadcrumb = doc.createElement("p");
    compactBreadcrumb.className = "browse-tree__compact-breadcrumb";
    compactBreadcrumb.textContent = selected
      ? selected.group + " / " + selected.componentName
      : "No component selected";
    compactNav.appendChild(compactBreadcrumb);

    if (tree.isEmptyKit) {
      var emptyBox = doc.createElement("div");
      emptyBox.className = "browse-tree__empty";
      var heading = doc.createElement("p");
      heading.textContent = "No components yet — Conjure your first component.";
      var link = doc.createElement("a");
      link.setAttribute("href", "?route=generate");
      link.setAttribute("data-route-link", "generate");
      link.textContent = "Go to Generate";
      emptyBox.append(heading, link);
      treeEl.appendChild(emptyBox);
      // Copilot review (PR #248) — <720px hides `treeEl` entirely (CSS) and
      // shows only `compactNav`, so the message needs its OWN copy there
      // too, not just inside the (now off-canvas-at-this-width) tree.
      compactNav.appendChild(emptyBox.cloneNode(true));
      container.append(railToggle, treeEl, compactNav);
      return;
    }

    if (tree.isNoMatch) {
      var noMatchBox = doc.createElement("div");
      noMatchBox.className = "browse-tree__no-match";
      var noMatchMsg = doc.createElement("p");
      noMatchMsg.textContent = 'No components match "' + (activeSearch || "") + '".';
      var clear = doc.createElement("button");
      clear.type = "button";
      clear.setAttribute("data-clear-filter", "true");
      clear.textContent = "Clear filter";
      noMatchBox.append(noMatchMsg, clear);
      treeEl.appendChild(noMatchBox);
      // Copilot review (PR #248) — same <720px rationale as isEmptyKit
      // above: give the compact nav its own live copy of the Clear-filter
      // action rather than one hidden inside the off-canvas tree. The
      // `container`-level click handler on `[data-clear-filter]` (below)
      // matches by attribute, not by node identity, so either copy works.
      compactNav.appendChild(noMatchBox.cloneNode(true));
      container.append(railToggle, treeEl, compactNav);
      return;
    }

    // Real tree branch — now safe to declare the ARIA `tree` role, since
    // only `treeitem` children (built below) get appended to `treeEl`.
    treeEl.setAttribute("role", "tree");
    treeEl.setAttribute("aria-label", "UI kit components");

    var compactSelect = doc.createElement("select");
    compactSelect.className = "browse-tree__compact-select";
    compactSelect.setAttribute("aria-label", "Jump to a component");
    var placeholderOption = doc.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = "Choose a component…";
    placeholderOption.disabled = true;
    if (!selected) placeholderOption.selected = true;
    compactSelect.appendChild(placeholderOption);

    var allItems = [];
    // Roving tabindex (a11y): exactly ONE item is in Tab order at a time.
    // `tabbableCandidate` tracks that single item as we walk the tree so a
    // LATER-discovered selected row can demote an EARLIER first-row
    // candidate that already received tabindex="0" — otherwise both stay
    // "0" and produce two Tab stops (Copilot review: bug #9).
    var tabbableCandidate = null;
    for (var g = 0; g < tree.groups.length; g++) {
      var group = tree.groups[g];
      var section = doc.createElement("div");
      section.className = "browse-tree__group";
      var label = doc.createElement("p");
      label.className = "browse-tree__group-label";
      label.textContent = group.name + " · " + group.count;
      section.appendChild(label);

      for (var c = 0; c < group.components.length; c++) {
        var component = group.components[c];
        var item = doc.createElement("div");
        item.setAttribute("role", "treeitem");
        item.className = "browse-tree__item";
        item.textContent = component.componentName;
        var isSelected =
          selected &&
          selected.group === group.name &&
          selected.componentName === component.componentName;
        item.setAttribute("aria-selected", isSelected ? "true" : "false");
        if (isSelected) item.classList.add("browse-tree__item--active");
        item.dataset.group = group.name;
        item.dataset.componentName = component.componentName;
        if (isSelected) {
          // A selected row always wins the single tab stop, demoting
          // whatever candidate (e.g. the first row) was previously chosen.
          if (tabbableCandidate) tabbableCandidate.setAttribute("tabindex", "-1");
          item.setAttribute("tabindex", "0");
          tabbableCandidate = item;
        } else if (!tabbableCandidate) {
          // No selection yet encountered — the first row is the provisional
          // candidate until/unless a selected row later demotes it.
          item.setAttribute("tabindex", "0");
          tabbableCandidate = item;
        } else {
          item.setAttribute("tabindex", "-1");
        }
        section.appendChild(item);
        allItems.push(item);

        var option = doc.createElement("option");
        option.value = group.name + " " + component.componentName;
        option.textContent = group.name + " / " + component.componentName;
        if (isSelected) option.selected = true;
        compactSelect.appendChild(option);
      }
      treeEl.appendChild(section);
    }

    compactSelect.addEventListener("change", function () {
      var value = compactSelect.value;
      var sep = value.indexOf(" ");
      if (sep === -1) return;
      select({ group: value.slice(0, sep), componentName: value.slice(sep + 1) });
    });
    compactNav.appendChild(compactSelect);

    function activate(item) {
      select({ group: item.dataset.group, componentName: item.dataset.componentName });
      // Closing the overlay on activation returns focus predictably (a11y
      // requirement: "Focus remains visible and returns predictably when an
      // overlay tree closes").
      if (treeEl.classList.contains("browse-tree--overlay-open")) {
        treeEl.classList.remove("browse-tree--overlay-open");
        railToggle.setAttribute("aria-expanded", "false");
      }
    }

    function moveFocus(fromIndex, delta) {
      if (allItems.length === 0) return;
      var next = (((fromIndex + delta) % allItems.length) + allItems.length) % allItems.length;
      for (var i = 0; i < allItems.length; i++) allItems[i].setAttribute("tabindex", "-1");
      allItems[next].setAttribute("tabindex", "0");
      allItems[next].focus();
    }

    treeEl.addEventListener("keydown", function (event) {
      var target = event.target;
      var index = allItems.indexOf(target);
      if (index === -1) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocus(index, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocus(index, -1);
      } else if (event.key === "Home") {
        event.preventDefault();
        moveFocus(0, 0);
      } else if (event.key === "End") {
        event.preventDefault();
        moveFocus(allItems.length - 1, 0);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(target);
      }
    });
    treeEl.addEventListener("click", function (event) {
      var item = event.target && event.target.closest && event.target.closest('[role="treeitem"]');
      if (item) activate(item);
    });

    container.append(railToggle, treeEl, compactNav);
  }

  /**
   * Render the component detail stage: breadcrumb, heading (with `@genie`
   * marker ONLY when `registered`/`validated` is a proven fact, never
   * fabricated — AC9), variant tabs (Default-only per Decision #5), the
   * reused sandboxed preview iframe (same sandbox/lazy/CSP contract as the
   * grid's own `createCard`), a metadata panel, a sanitized source panel, and
   * the Refine action (disabled + explained when no MCP host bridge is
   * present — AC13).
   *
   * @param {Document} doc
   * @param {HTMLElement} container
   * @param {{kitId: string, kitName?: string, component: object, source: string|null|undefined, sourceLoading?: boolean, hostAvailable: boolean, refineAvailable?: boolean, registered?: boolean, validated?: boolean, onRefine?: (ctx: object) => void}} state
   */
  function renderBrowseDetail(doc, container, state) {
    container.replaceChildren();
    var component = state.component;
    // A stable-ish id derived from group/component identity — safe for use
    // as an element id (no `[` `]` `.` etc. survive real component names,
    // but even if one did, `id`/`aria-controls`/`aria-labelledby` only need
    // to agree with EACH OTHER, not be a valid CSS selector).
    var idBase =
      "browse-detail-" +
      String(component.group || "group").replace(/[^a-zA-Z0-9_-]/g, "_") +
      "-" +
      String(component.componentName || "component").replace(/[^a-zA-Z0-9_-]/g, "_");

    var breadcrumb = doc.createElement("p");
    breadcrumb.className = "browse-breadcrumb";
    breadcrumb.textContent =
      (state.kitName || state.kitId || "kit") +
      " / " +
      component.group +
      " / " +
      component.componentName;
    container.appendChild(breadcrumb);

    var heading = doc.createElement("div");
    heading.className = "browse-detail__heading";
    var titleWrap = doc.createElement("div");
    if (state.registered) {
      var marker = doc.createElement("span");
      marker.className = "genie-marker";
      marker.setAttribute("aria-label", "Genie synced");
      marker.textContent = "@genie";
      titleWrap.appendChild(marker);
      titleWrap.appendChild(doc.createTextNode(" "));
    }
    var titleText = doc.createElement("span");
    titleText.textContent = component.componentName;
    titleWrap.appendChild(titleText);
    heading.appendChild(titleWrap);

    var refineButton = doc.createElement("button");
    refineButton.type = "button";
    refineButton.className = "btn-clay";
    refineButton.setAttribute("data-refine-action", "true");
    refineButton.textContent = "Refine →";
    // Copilot review (PR #248, AC13) — gated on `refineAvailable` (a real
    // MCP-App host bridge), NOT `hostAvailable` (which is also true for the
    // standalone source-read-only adapter and would wrongly enable Refine
    // for browser-only users — see `refineEnabled`'s comment in
    // `initBrowseController`).
    if (!state.refineAvailable) {
      refineButton.disabled = true;
      refineButton.setAttribute("aria-disabled", "true");
    }
    heading.appendChild(refineButton);
    container.appendChild(heading);

    if (!state.refineAvailable) {
      var refineExplain = doc.createElement("p");
      refineExplain.className = "browse-refine-explain";
      refineExplain.textContent =
        "Refine requires an MCP-capable host. Standalone Browse stays read-only.";
      container.appendChild(refineExplain);
    } else if (typeof state.onRefine === "function") {
      refineButton.addEventListener("click", function () {
        state.onRefine(buildRefineContext(state.kitId, component, "default"));
      });
    }

    // Variant tabs (AC8) — Default-only per Decision #5.
    var tabs = computeVariantTabs(component);
    var tablist = doc.createElement("div");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Variants");
    tablist.className = "variants-bar";
    var tabButtons = [];
    var previewPanelId = idBase + "-preview-panel";
    for (var t = 0; t < tabs.length; t++) {
      var tab = tabs[t];
      var button = doc.createElement("button");
      button.type = "button";
      button.setAttribute("role", "tab");
      button.className = "variant-tab";
      button.textContent = tab.label;
      var tabId = idBase + "-tab-" + tab.id;
      button.id = tabId;
      var isActiveTab = tab.id === "default";
      button.setAttribute("aria-selected", isActiveTab ? "true" : "false");
      // AC15 — wire every rendered tab (available or declared-but-disabled)
      // to the single preview stage `tabpanel` it controls, so assistive
      // tech can determine the tab-to-panel relationship (Copilot #18).
      button.setAttribute("aria-controls", previewPanelId);
      button.setAttribute("tabindex", isActiveTab ? "0" : "-1");
      if (!tab.available) {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.title = tab.reason;
      }
      if (isActiveTab) button.classList.add("active");
      tablist.appendChild(button);
      tabButtons.push(button);
    }
    // Arrow-key tab behaviour (a11y AC15).
    tablist.addEventListener("keydown", function (event) {
      var index = tabButtons.indexOf(event.target);
      if (index === -1) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        var delta = event.key === "ArrowRight" ? 1 : -1;
        // Copilot review (PR #248) — with only Default enabled (Decision
        // #5), a single step always landed on a disabled declared-but-
        // unavailable tab, which cannot receive focus: `tabButtons[next]`
        // kept `tabindex=-1` and `.focus()` was a no-op, so the roving
        // tabindex silently stuck (ArrowRight then did nothing on repeat,
        // since focus never actually left Default). Step past every
        // disabled tab in the arrow's direction; if every OTHER tab is
        // disabled, this converges back on the current index and is a
        // harmless no-op, matching a single real tab in the tablist.
        var next = index;
        for (var step = 0; step < tabButtons.length; step++) {
          next = (((next + delta) % tabButtons.length) + tabButtons.length) % tabButtons.length;
          if (!tabButtons[next].disabled) break;
        }
        if (tabButtons[next].disabled) return;
        for (var i = 0; i < tabButtons.length; i++) tabButtons[i].setAttribute("tabindex", "-1");
        tabButtons[next].setAttribute("tabindex", "0");
        tabButtons[next].focus();
      }
    });
    container.appendChild(tablist);

    // Preview stage — reuses the SAME sandbox contract as `createCard`.
    var stage = doc.createElement("div");
    stage.className = "preview-stage";
    // AC15/AC18 — the stage is the panel every variant tab's `aria-controls`
    // points at; `aria-labelledby` the active (Default) tab so its
    // accessible name tracks whichever variant is selected.
    stage.id = previewPanelId;
    stage.setAttribute("role", "tabpanel");
    stage.setAttribute("aria-labelledby", idBase + "-tab-default");
    stage.setAttribute("tabindex", "0");
    var label = doc.createElement("span");
    label.className = "stage-label";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    // AC7 — a distinct loading state: the label starts as "Preview ·
    // Loading…" and only becomes "Preview · Default" once the iframe's
    // `load` event actually fires, so a slow/stalled preview isn't silently
    // presented as already-rendered (Copilot #16).
    label.textContent = "Preview · Loading…";
    stage.appendChild(label);

    var iframe = doc.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("src", component.path || "");
    iframe.setAttribute("title", accessibleName(component.componentName, "preview"));
    // Mirror `createCard`'s iframe contract (Copilot #10): a sandboxed
    // iframe with no `allow-same-origin` is STILL natively focusable, so it
    // must be explicitly pulled out of Tab order or Tab would land inside
    // the sandboxed frame after the variant tabs.
    iframe.setAttribute("tabindex", "-1");
    var size = parseViewport(component.viewport);
    if (size) {
      iframe.setAttribute("width", String(size.width));
      iframe.setAttribute("height", String(size.height));
      iframe.style.aspectRatio = size.width + " / " + size.height;
    } else {
      iframe.setAttribute("height", String(DEFAULT_CARD_HEIGHT));
    }
    iframe.addEventListener("load", function () {
      if (stage.classList.contains("browse-preview--broken")) return;
      label.textContent = "Preview · Default";
    });
    iframe.addEventListener("error", function () {
      stage.classList.add("browse-preview--broken");
      stage.replaceChildren();
      var broken = doc.createElement("p");
      broken.textContent = "Preview unavailable.";
      stage.appendChild(broken);
    });
    stage.appendChild(iframe);
    container.appendChild(stage);

    // Metadata panel (AC9) — only real, provable facts; nothing fabricated.
    var metadata = doc.createElement("dl");
    metadata.className = "browse-metadata";
    metadata.setAttribute("aria-label", "Component metadata");
    var metaRows = [
      ["Group", component.group],
      ["Viewport", component.viewport],
      ["Hash", component.hash],
      ["Last modified", component.lastModified],
      [
        "Tags",
        Array.isArray(component.tags) && component.tags.length ? component.tags.join(", ") : null,
      ],
    ];
    for (var m = 0; m < metaRows.length; m++) {
      var value = metaRows[m][1];
      var dt = doc.createElement("dt");
      dt.textContent = metaRows[m][0];
      var dd = doc.createElement("dd");
      dd.textContent = value ? String(value) : "Not provided";
      metadata.append(dt, dd);
    }
    if (state.validated) {
      var validatedDt = doc.createElement("dt");
      validatedDt.textContent = "Validation";
      var validatedDd = doc.createElement("dd");
      var badge = doc.createElement("span");
      badge.className = "badge badge-success";
      badge.textContent = "✓ validated";
      validatedDd.appendChild(badge);
      metadata.append(validatedDt, validatedDd);
    }
    container.appendChild(metadata);

    // Source panel (AC10) — sanitized plain text, progressive truncation.
    var sourceBox = doc.createElement("div");
    sourceBox.className = "browse-source";
    sourceBox.setAttribute("aria-label", "Component source");
    if (typeof state.source === "string") {
      var sanitized = sanitizeSourceForDisplay(state.source);
      var pre = doc.createElement("pre");
      pre.className = "code-box";
      pre.textContent = sanitized.text; // textContent only — never executed.
      sourceBox.appendChild(pre);
      if (sanitized.truncated) {
        var expand = doc.createElement("button");
        expand.type = "button";
        expand.setAttribute("data-expand-source", "true");
        expand.textContent = "Show more";
        expand.addEventListener("click", function () {
          pre.textContent = state.source;
          expand.hidden = true;
        });
        sourceBox.appendChild(expand);
      }
      var copyButton = doc.createElement("button");
      copyButton.type = "button";
      copyButton.setAttribute("data-copy-source", "true");
      copyButton.textContent = "Copy";
      var copyStatus = doc.createElement("span");
      copyStatus.setAttribute("role", "status");
      copyStatus.setAttribute("aria-live", "polite");
      copyStatus.className = "browse-source__copy-status";
      copyButton.addEventListener("click", function () {
        var clipboard =
          doc.defaultView && doc.defaultView.navigator && doc.defaultView.navigator.clipboard;
        var reportSuccess = function () {
          copyStatus.textContent = "Copied.";
        };
        var reportFailure = function () {
          copyStatus.textContent = "Copy failed.";
        };
        if (clipboard && typeof clipboard.writeText === "function") {
          clipboard.writeText(state.source).then(reportSuccess, reportFailure);
        } else {
          reportFailure();
        }
      });
      sourceBox.append(copyButton, copyStatus);
    } else if (state.sourceLoading) {
      // AC7 — a settled failed read is the ONLY time the "could not be
      // read" copy is honest; a read that simply hasn't resolved yet must
      // say so distinctly (Copilot #17), never present as an error.
      var loading = doc.createElement("p");
      loading.setAttribute("role", "status");
      loading.setAttribute("aria-live", "polite");
      loading.textContent = "Loading source…";
      sourceBox.appendChild(loading);
    } else {
      var unavailable = doc.createElement("p");
      unavailable.textContent = state.hostAvailable
        ? "Source could not be read."
        : "Source inspection requires an MCP-capable host bridge.";
      sourceBox.appendChild(unavailable);
    }
    container.appendChild(sourceBox);
  }

  /**
   * Render the "component removed during HMR" controlled state (AC4/product-
   * behavior: "If the selected component disappears, show a controlled
   * removed state and move focus to the nearest valid navigation control").
   * This function only renders the message; moving focus is the caller's job
   * (it owns the tree DOM and knows the nearest valid item).
   *
   * @param {Document} doc
   * @param {HTMLElement} container
   * @param {{componentName: string}} removed
   */
  function renderBrowseDetailRemoved(doc, container, removed) {
    container.replaceChildren();
    var box = doc.createElement("div");
    box.className = "browse-detail__removed";
    box.setAttribute("role", "status");
    var message = doc.createElement("p");
    message.textContent =
      (removed && removed.componentName ? removed.componentName : "This component") +
      " is no longer available in this UI kit.";
    box.appendChild(message);
    container.appendChild(box);
  }

  /**
   * Wire the tree + detail panes together against a live manifest: owns the
   * current selection (deep-link-aware — Decision #7), re-projects the tree
   * on search/manifest changes, and re-renders detail atomically on
   * selection (AC5 — "stale content from the prior selection is not shown as
   * current", satisfied because both panes are rebuilt from the SAME
   * `tree`/`selection` read on every call, never patched piecemeal).
   *
   * Used by BOTH vehicles now (Copilot #1): the fetch tier calls this with
   * `hostBridge: null` (no MCP host), and the embedded `ui://genie/grid`
   * tier calls it with the real host bridge once the handshake resolves
   * (`setHostBridge`), so Refine/source-read still route through the host
   * (AC12/AC13). Call sites are gated on `#browse-workbench` existing, which
   * only the fixture-only grid tests omit.
   *
   * @param {Document} doc
   * @param {{hostBridge?: {callTool: Function}|null, kitId?: string, kitName?: string, onRefine?: (ctx: object) => void}} opts
   * @returns {{update(manifest: object): void, setHostBridge(bridge: object|null): void, teardown(): void}}
   */
  function initBrowseController(doc, opts) {
    var options = opts || {};
    var win = doc.defaultView;
    var workbench = doc.getElementById("browse-workbench");
    var treeContainer = doc.getElementById("browse-tree");
    var detailContainer = doc.getElementById("browse-detail");
    var searchInput = doc.getElementById("q");
    if (!workbench || !treeContainer || !detailContainer) {
      return { update: function () {}, setHostBridge: function () {}, teardown: function () {} };
    }

    var manifest = { components: [], groups: [] };
    var selection = null; // {group, componentName}
    var hostBridge = options.hostBridge || null;
    // Copilot review (PR #248, AC13) — source-read capability and Refine
    // capability are NOT the same thing. `hostBridge` here may be the
    // standalone `createStandaloneSourceBridge` adapter, which only ever
    // supports `mcp__genie__read_file` and explicitly rejects everything
    // else (never Refine/Conjure — Decision #6). `refineEnabled` tracks the
    // REAL MCP-App host bridge only, and is flipped true exclusively by
    // `setHostBridge` (the embedded tier's post-handshake callback) — the
    // standalone tier never calls `setHostBridge`, so this stays false there
    // even though `hostBridge` is truthy for source reads.
    var refineEnabled = false;
    // AC3/Copilot #7 — a monotonic generation counter. Every `renderAll()`
    // call bumps it and captures its own value; an in-flight async source
    // read is only allowed to commit if the generation it captured is STILL
    // the current one when it resolves. This closes a race a pure identity
    // check (group+componentName) cannot: HMR replacing the SAME selected
    // component (identity unchanged, content/path changed) while an older
    // read for the PRIOR content is still in flight.
    var renderGeneration = 0;

    function currentSearch() {
      return searchInput ? searchInput.value || "" : "";
    }

    function writeSelectionToUrl(sel) {
      if (!win) return;
      try {
        var next = new win.URL(win.location.href);
        if (sel) {
          // Copilot #8 — serialize kitId too, so a saved/shared link
          // disambiguates across kits instead of only group+componentName
          // (which could collide with a same-named component in a
          // different kit once re-opened there).
          next.searchParams.set("kitId", options.kitId || "");
          next.searchParams.set("group", sel.group);
          next.searchParams.set("componentName", sel.componentName);
        } else {
          next.searchParams.delete("kitId");
          next.searchParams.delete("group");
          next.searchParams.delete("componentName");
        }
        win.history.replaceState({}, "", next);
      } catch {
        /* opaque/about:blank embedded origins cannot persist history */
      }
    }

    function fetchSource(component) {
      if (!hostBridge || !component) return Promise.resolve(null);
      // Copilot #4 — embedded manifests rewrite `component.path` to an
      // absolute/data transport URL for the IFRAME's `src`, but preserve the
      // kit-relative file identity in `sourcePath`. A host read-file tool
      // has a relative-path contract, so it MUST receive `sourcePath` (when
      // present) rather than the rewritten transport URL, which would
      // always fail (or worse, resolve to the wrong file) against a real
      // host.
      var readPath = component.sourcePath || component.path;
      if (!readPath) return Promise.resolve(null);
      return hostBridge
        .callTool("mcp__genie__read_file", { kitId: options.kitId || "", path: readPath })
        .then(function (result) {
          return result && typeof result.content === "string" && result.encoding !== "base64"
            ? result.content
            : null;
        })
        .catch(function () {
          return null;
        });
    }

    function detailStateFor(component, source, sourceLoading) {
      return {
        kitId: options.kitId || "",
        kitName: options.kitName || "",
        component: component,
        source: source,
        sourceLoading: sourceLoading,
        hostAvailable: Boolean(hostBridge),
        // Copilot review (PR #248, AC13) — gates the Refine button
        // separately from source-read availability; see `refineEnabled`'s
        // own comment above.
        refineAvailable: refineEnabled,
        onRefine: function (context) {
          if (win) writeRoute(win, "review", false);
          if (typeof options.onRefine === "function") options.onRefine(context);
        },
      };
    }

    function renderAll() {
      renderGeneration += 1;
      var generation = renderGeneration;

      // Copilot #6 — project the FILTERED tree only for the visible tree
      // list/counts; selection resolution below always uses the UNFILTERED
      // manifest, so typing a filter that hides the selected component never
      // conflates "filtered out" with "removed from the manifest".
      var filteredTree = projectManifestToTree(manifest, currentSearch());
      var unfilteredTree = projectManifestToTree(manifest, "");
      renderBrowseTree(doc, treeContainer, filteredTree, currentSearch(), select, selection);

      if (!selection) {
        detailContainer.replaceChildren();
        var placeholder = doc.createElement("p");
        placeholder.className = "browse-detail__placeholder";
        placeholder.textContent = filteredTree.isEmptyKit
          ? ""
          : "Select a component to see its details.";
        detailContainer.appendChild(placeholder);
        return;
      }

      var resolved = resolveSelection(unfilteredTree, selection);
      if (!resolved.found) {
        renderBrowseDetailRemoved(doc, detailContainer, { componentName: selection.componentName });
        // Move focus to the nearest valid navigation control (AC/a11y): the
        // tree itself, if it has any tabbable item, else the search input.
        var firstItem = treeContainer.querySelector('[role="treeitem"][tabindex="0"]');
        if (firstItem && typeof firstItem.focus === "function") firstItem.focus();
        else if (searchInput) searchInput.focus();
        return;
      }

      // Copilot #17 — the initial render for a host-backed selection must
      // show a distinct LOADING state, not the settled-failure copy; the
      // failure copy is reserved for when the async read below actually
      // resolves to `null`.
      renderBrowseDetail(
        doc,
        detailContainer,
        detailStateFor(resolved.component, null, Boolean(hostBridge)),
      );

      if (!hostBridge) return;

      fetchSource(resolved.component).then(function (source) {
        // Copilot #7 — stale-result guard: only the render generation that
        // is STILL current when this read resolves may commit. A plain
        // identity check (group/componentName only, the prior guard) cannot
        // catch HMR replacing the same-identity component's content/path
        // while an older read for the PRIOR content is in flight; the
        // generation counter does.
        if (generation !== renderGeneration) return;
        if (
          !selection ||
          selection.group !== resolved.component.group ||
          selection.componentName !== resolved.component.componentName
        ) {
          return;
        }
        renderBrowseDetail(doc, detailContainer, detailStateFor(resolved.component, source, false));
      });
    }

    function select(sel) {
      selection = sel;
      writeSelectionToUrl(sel);
      renderAll();
    }

    treeContainer.addEventListener("click", function (event) {
      var clear =
        event.target && event.target.closest && event.target.closest("[data-clear-filter]");
      if (clear && searchInput) {
        searchInput.value = "";
        renderAll();
      }
    });

    if (searchInput) {
      searchInput.addEventListener("input", renderAll);
    }

    // Deep-link (Decision #7): read an initial selection from the URL.
    // Copilot #8 — a link's `kitId` (when present) must match the CURRENT
    // kit; a mismatched kitId means the link was minted for a different kit
    // and a same-named component here would be the wrong one, so the
    // deep-link is rejected (falls back to no initial selection) rather
    // than silently resolving against this kit.
    if (win) {
      try {
        var initial = parseSelection(new win.URL(win.location.href).searchParams);
        if (initial && (!initial.kitId || !options.kitId || initial.kitId === options.kitId)) {
          selection = { group: initial.group, componentName: initial.componentName };
        }
      } catch {
        /* malformed URL — no initial selection */
      }
    }

    renderAll();

    return {
      update: function (nextManifest) {
        manifest = nextManifest || { components: [], groups: [] };
        // HMR-safe: an update never resets an unrelated selection or filter
        // (product-behavior requirement) — `renderAll` re-resolves the SAME
        // `selection` identity against the fresh manifest and only shows the
        // "removed" state if it genuinely no longer resolves.
        renderAll();
      },
      // Copilot #1 — the embedded tier's host bridge only exists after the
      // `ui://` MCP-App handshake resolves (asynchronously, after
      // `initBrowseController` is first called with `hostBridge: null` so
      // the workbench renders immediately rather than waiting on the host).
      // This lets the boot path hand the bridge in later without recreating
      // the whole controller (and losing the live selection/filter state).
      setHostBridge: function (nextBridge) {
        hostBridge = nextBridge || null;
        // Copilot review (PR #248, AC13) — `setHostBridge` is ONLY ever
        // called from the embedded tier's real MCP-App handshake
        // (`onReady`/`onUnavailable` in `boot()`), never by the standalone
        // tier's `createStandaloneSourceBridge` path. So this is exactly the
        // signal that a real, Refine-capable host is present.
        refineEnabled = Boolean(nextBridge);
        renderAll();
      },
      teardown: function () {
        if (searchInput) searchInput.removeEventListener("input", renderAll);
      },
    };
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
      var structureChanged = !lastManifest || manifestStructureChanged(lastManifest, next);
      var contentChangedPaths = [];
      if (structureChanged) {
        renderManifestUpdate(doc, grid, next);
        bumpReloadCounter(doc, 1);
      } else {
        contentChangedPaths = diffManifestHashes(lastManifest, next);
        var total = 0;
        for (var i = 0; i < contentChangedPaths.length; i++) {
          total += reloadCardByPath(grid, contentChangedPaths[i], ++hmrReloadToken);
        }
        if (total > 0) bumpReloadCounter(doc, total);
      }
      lastManifest = next;
      // M7-02 (#234) — HMR-safe Browse: re-project the SAME live tree/
      // selection against the fresh manifest on every update (structural or
      // content-only alike), never resetting an unrelated selection/filter
      // (see `initBrowseController`'s own doc for why re-resolving-by-
      // identity is safe here).
      //
      // Copilot review (PR #248) — but only when the manifest actually
      // changed. Standalone/localhost Browse polls every
      // `HMR_POLL_INTERVAL_MS` (2s) unconditionally (no WebSocket), and
      // every one of those ticks used to call `onManifestUpdate` even for a
      // byte-equivalent response — `initBrowseController.update()` treats
      // that as "manifest changed" unconditionally and re-renders detail
      // (which re-runs `fetchSource`), so a selected component's preview and
      // source panel silently reloaded every 2 seconds with nothing to show
      // for it. `structureChanged` (a genuinely new/removed group or
      // component) or a non-empty `contentChangedPaths` (a real per-card
      // hash diff) are the only two ways `next` can differ from
      // `lastManifest` in a way Browse should react to.
      if (
        (structureChanged || contentChangedPaths.length > 0) &&
        typeof opts.onManifestUpdate === "function"
      ) {
        opts.onManifestUpdate(next);
      }
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
  /**
   * Copilot #3 (AC13) — a minimal `HostBridge`-shaped adapter for standalone
   * Browse (`file://` / localhost, no MCP host) that still supports source
   * inspection: `mcp__genie__read_file` reads the SAME-ORIGIN kit-relative
   * path via the ordinary `fetch` already used for the manifest, rather than
   * hard-coding a null bridge that guarantees every read fails. Any other
   * tool name rejects — this adapter exists ONLY to satisfy Browse's
   * read-only source panel, never to fake Refine/Conjure (those still
   * correctly require a real MCP host and stay disabled — Decision #6).
   *
   * @param {(url: string) => Promise<Response>} fetchImpl
   * @returns {{callTool: Function, destroy(): void}}
   */
  function createStandaloneSourceBridge(fetchImpl) {
    return {
      callTool: function (name, args) {
        if (name !== "mcp__genie__read_file" || !args || typeof args.path !== "string") {
          return Promise.reject(new Error("Standalone Browse cannot call " + name + "."));
        }
        // Path containment: reject anything that isn't a plain kit-relative
        // path (no `..` segments, no scheme, no leading slash) — the same
        // boundary a real host's read-file tool would enforce server-side
        // (AC16), kept here since this adapter has no server to defer to.
        //
        // Copilot review (PR #248) — the original check only rejected a
        // literal `..` substring and a literal leading `/`, which the browser
        // URL parser doesn't treat as the only escape hatches: (1) it treats
        // backslashes as forward slashes for http(s) URLs, so
        // `\\evil.example/x` resolves same as `//evil.example/x` (protocol-
        // relative, off-origin) without ever containing a literal `/` at
        // index 0; and (2) a percent-encoded segment (`%2e%2e`, `%2E%2e`,
        // etc.) doesn't contain the literal string `..` pre-decode, but
        // normalizes to `..` once `fetchImpl` (the real `fetch`) parses it.
        // Decode first, then reject on backslashes, any leading separator,
        // and any decoded `.`/`..` segment — closing both bypasses.
        var path = args.path;
        var decodedPath;
        try {
          decodedPath = decodeURIComponent(path);
        } catch {
          return Promise.reject(new Error("Refusing to read an unsafe path."));
        }
        var segments = decodedPath.split(/[\\/]+/);
        var hasUnsafeSegment = segments.some(function (segment) {
          return segment === "." || segment === "..";
        });
        if (
          !path ||
          path.indexOf("\\") !== -1 ||
          decodedPath.indexOf("\\") !== -1 ||
          hasUnsafeSegment ||
          /^[a-z][a-z0-9+.-]*:/i.test(path) ||
          /^[a-z][a-z0-9+.-]*:/i.test(decodedPath) ||
          path.charAt(0) === "/" ||
          decodedPath.charAt(0) === "/"
        ) {
          return Promise.reject(new Error("Refusing to read an unsafe path."));
        }
        return fetchImpl(path).then(function (response) {
          if (!response || !response.ok) {
            throw new Error("HTTP " + (response ? response.status : "error"));
          }
          return response.text().then(function (text) {
            return { content: text };
          });
        });
      },
      destroy: function () {},
    };
  }

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

        // Copilot #1 (AC1/AC12/AC13) — embedded Browse must actually
        // initialize the workbench too, not just leave content in the
        // hidden `#grid`. `hostBridge` starts `null` (the handshake hasn't
        // resolved yet) and is handed to the controller once `initMcpApp`'s
        // `onReady` fires, via `setHostBridge` — never recreating the
        // controller, so any selection/filter already made survives.
        var browseController = initBrowseController(doc, {
          hostBridge: null,
          kitId: inline && inline.name,
          kitName: inline && inline.name,
          onRefine: function (context) {
            if (shellController && shellController.setRefineContext) {
              shellController.setRefineContext(context);
            }
          },
        });

        // Copilot review (PR #248) — seed the controller with the manifest
        // that's ALREADY inlined, mirroring the standalone tier's fix
        // (Copilot #2 above). `initHmr({initialManifest})` only records that
        // value as its OWN diff baseline — it never calls `onManifestUpdate`
        // for it — so without this explicit `update()`, embedded Browse
        // rendered the empty-kit placeholder until a later tool-result or
        // HMR message arrived (and stayed empty forever if neither did).
        browseController.update(inline);

        var teardownHmr = function () {};
        try {
          teardownHmr = initHmr(doc, {
            initialManifest: inline,
            onManifestUpdate: function (next) {
              browseController.update(next);
            },
          });
        } catch {
          /* live refresh is an enhancement, never a boot blocker */
        }
        // The inlined tier IS the embedded MCP-App surface, so the postMessage
        // host bridge applies to EVERY inlined resource — not only the bare
        // tool-result shell. Query-bearing `ui://` resources (e.g. the preview
        // URI carrying `kitId`) are intentionally emitted WITHOUT the
        // tool-result-shell marker (grid-resource.ts), yet still use the MCP-App
        // MIME type and still run inside a host frame. Gating the bridge on that
        // marker wrongly flagged their Generate tab "Host unavailable". Start the
        // shell in the pending state and let initMcpApp resolve ready/unavailable
        // from the actual host handshake.
        var shellController = initProductShell(doc, undefined);
        initMcpApp(doc, {
          onTeardown: teardownHmr,
          onReady: function (bridge) {
            if (shellController && shellController.setBridge) shellController.setBridge(bridge);
            browseController.setHostBridge(bridge);
          },
          onUnavailable: function () {
            if (shellController && shellController.setUnavailable) {
              shellController.setUnavailable();
            }
            browseController.setHostBridge(null);
          },
          onToolResult: function (result) {
            var nextManifest = extractToolResultManifest(result);
            if (nextManifest) browseController.update(nextManifest);
          },
          onProgress: function (message) {
            if (shellController && shellController.showProgress) {
              shellController.showProgress(message);
            }
          },
        });
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

        // M7-02 (#234) — standalone/localhost Browse workbench. Reuses the
        // SAME fetched manifest as the grid above (no parallel catalog —
        // Decision #1); a no-op when `#browse-workbench` isn't present in
        // this document (e.g. the fixture-only grid tests).
        //
        // Copilot #3 (AC13) — standalone still supports source inspection
        // via `createStandaloneSourceBridge`'s same-origin relative fetch,
        // rather than a hard-coded null bridge that made `fetchSource`
        // always resolve `null`.
        var standaloneShellController = initProductShell(doc, null);
        var browseController = initBrowseController(doc, {
          hostBridge: createStandaloneSourceBridge(fetchImpl),
          kitId: manifest && manifest.name,
          kitName: manifest && manifest.name,
          onRefine: function (context) {
            if (standaloneShellController && standaloneShellController.setRefineContext) {
              standaloneShellController.setRefineContext(context);
            }
          },
        });

        // Copilot #2 — supply the ALREADY-FETCHED manifest to the controller
        // up front. `initHmr`'s `initialManifest` is only its OWN polling/
        // diff baseline, and `onManifestUpdate` fires no earlier than the
        // first refresh — without this call, standalone Browse would render
        // the empty-kit placeholder until the first HMR tick.
        browseController.update(manifest);

        // M4-04 (DRO-266) — engage live per-card refresh AFTER the grid exists,
        // handing the just-fetched manifest in as the polling baseline so the
        // fallback's very first tick can already spot a hash change. Best-effort:
        // if it throws (an exotic embed with no window at all), the static grid
        // still stands. The teardown fn is intentionally unused here — the
        // browser page lives until navigation; tests call `initHmr` directly and
        // own their own teardown.
        try {
          initHmr(doc, {
            initialManifest: manifest,
            onManifestUpdate: function (next) {
              browseController.update(next);
            },
          });
        } catch {
          /* live refresh is an enhancement, never a boot blocker */
        }
      })
      .catch(function (err) {
        var detail = err && err.message ? err.message : String(err);
        renderError(doc, grid, detail);
        initProductShell(doc, null);
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
    window.__genieViewerTestHooks.KIT_CONTEXT_DEADLINE_MS = KIT_CONTEXT_DEADLINE_MS;
    window.__genieViewerTestHooks.parseViewport = parseViewport;
    window.__genieViewerTestHooks.groupByGroup = groupByGroup;
    window.__genieViewerTestHooks.computeGroupOrder = computeGroupOrder;
    window.__genieViewerTestHooks.accessibleName = accessibleName;
    window.__genieViewerTestHooks.createCard = createCard;
    window.__genieViewerTestHooks.renderGrid = renderGrid;
    window.__genieViewerTestHooks.filterManifestBySearch = filterManifestBySearch;
    window.__genieViewerTestHooks.renderToolResult = renderToolResult;
    window.__genieViewerTestHooks.initMcpApp = initMcpApp;
    window.__genieViewerTestHooks.normalizeRoute = normalizeRoute;
    window.__genieViewerTestHooks.writeRoute = writeRoute;
    window.__genieViewerTestHooks.canConjure = canConjure;
    window.__genieViewerTestHooks.selectInitialKit = selectInitialKit;
    window.__genieViewerTestHooks.isConjureResult = isConjureResult;
    window.__genieViewerTestHooks.createDraftStore = createDraftStore;
    window.__genieViewerTestHooks.createHostBridge = createHostBridge;
    window.__genieViewerTestHooks.initProductShell = initProductShell;
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
    // M7-02 (#234) — Browse UI-kit workbench seam.
    window.__genieViewerTestHooks.projectManifestToTree = projectManifestToTree;
    window.__genieViewerTestHooks.resolveSelection = resolveSelection;
    window.__genieViewerTestHooks.selectionForKitChange = selectionForKitChange;
    window.__genieViewerTestHooks.serializeSelection = serializeSelection;
    window.__genieViewerTestHooks.parseSelection = parseSelection;
    window.__genieViewerTestHooks.computeVariantTabs = computeVariantTabs;
    window.__genieViewerTestHooks.sanitizeSourceForDisplay = sanitizeSourceForDisplay;
    window.__genieViewerTestHooks.buildRefineContext = buildRefineContext;
    window.__genieViewerTestHooks.renderBrowseTree = renderBrowseTree;
    window.__genieViewerTestHooks.renderBrowseDetail = renderBrowseDetail;
    window.__genieViewerTestHooks.renderBrowseDetailRemoved = renderBrowseDetailRemoved;
    window.__genieViewerTestHooks.initBrowseController = initBrowseController;
    window.__genieViewerTestHooks.extractToolResultManifest = extractToolResultManifest;
    window.__genieViewerTestHooks.createStandaloneSourceBridge = createStandaloneSourceBridge;
  }
})();
