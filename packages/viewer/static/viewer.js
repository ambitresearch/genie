/**
 * genie preview viewer — grid renderer and product shell.
 *
 * The browser-native script both the standalone Vite viewer and the embedded `ui://genie/grid`
 * MCP-Apps resource boot into. It reads the kit's compiled manifest, groups cards by their
 * `@genie` group, and renders each as a sandboxed, lazy-loaded `<iframe>`; on top of that it
 * hosts Generate, Browse, and Review.
 *
 * Four constraints shape almost every decision in this file. They are explained in full, with
 * the empirical evidence behind each, in `docs/developer/architecture.md` ("Viewer script
 * constraints"). In short:
 *
 * 1. Classic script, NOT an ES module — a module's relative fetch is CORS-rejected under
 *    `file://`, which would break RFC G-5 byte-identity. `import`/`export` are unavailable;
 *    all other modern syntax is fine.
 * 2. The manifest is `{version, name, generatedAt, groups[], components[{name, group, path,
 *    viewport, hash, lastModified}]}` at `.genie/manifest.json`, with `viewport` kept as the
 *    RAW marker string. There is no `cards[]` key.
 * 3. Pure functions take their `document`/`fetch` as arguments and are exposed on
 *    `window.__genieViewerTestHooks` ONLY when a harness pre-creates that object, so shipped
 *    pages have zero footprint.
 * 4. Preview iframes are `sandbox="allow-scripts"` with NO `allow-same-origin`, card text is
 *    written via `textContent`, cards are keyboard-operable `role="link"` elements, and the
 *    iframe itself is pulled out of Tab order.
 */

(function () {
  "use strict";

  /**
   * The kit-relative manifest URL. The AC sketch says `./manifest.json`, but the shipped compiler +
   * M4-08 CLI (`MANIFEST_RELATIVE_PATH`) put it at `.genie/manifest.json`; the viewer fetches the
   * real location.
   */
  var MANIFEST_URL = ".genie/manifest.json";

  /**
   * DOM id of the inlined-manifest script the embedded `ui://genie/grid` tier (M4-06 / DRO-268)
   * injects: a `<script type="application/json" id="manifest">` data island holding the compiled
   * manifest. That tier's CSP is `default-src 'none'; … connect-src 'none'` — `fetch()` is blocked
   * outright — so the manifest MUST travel inside the document and `boot` reads it from here
   * instead of the network. The `file://` and localhost tiers carry NO such node, so they
   * transparently keep the `fetch(MANIFEST_URL)` path — the one `viewer.js` stays byte-identical
   * across all three vehicles (RFC G-5).
   */
  var MANIFEST_ELEMENT_ID = "manifest";
  // Copilot review (PR #248) — `buildGridDocument` (packages/server/src/ui/ grid-resource.ts)
  // inlines a SECOND data island under this id, carrying the full, UNFILTERED kit manifest,
  // whenever the embedded `ui://genie/ grid?...` resource's `#manifest` island was scoped down by a
  // `componentName`/`group` query param. Browse must seed itself from THIS island (falling back to
  // `#manifest` when it's absent — the common, already-full-kit case) so a deep link into one
  // component can still navigate the rest of the kit, instead of being stuck with a one- component
  // tree.
  var MANIFEST_FULL_ELEMENT_ID = "manifest-full";
  var TOOL_RESULT_EMBEDDED_MANIFEST_META_KEY = "genie/embeddedManifest";
  var MCP_APP_PROTOCOL_VERSION = "2026-01-26";
  var mcpAppRequestId = 0;
  var LIST_KITS_TOOL = "mcp__genie__list_kits";
  var CONJURE_TOOL = "mcp__genie__conjure";
  var LIST_FILES_TOOL = "mcp__genie__list_files";
  var READ_FILE_TOOL = "mcp__genie__read_file";
  var LIST_COMPONENTS_TOOL = "mcp__genie__list_components";
  var REFINE_TOOL = "mcp__genie__refine";
  var PLAN_TOOL = "mcp__genie__plan";
  var WRITE_FILES_TOOL = "mcp__genie__write_files";
  var VALIDATE_TOOL = "mcp__genie__validate";
  var DELETE_FILES_TOOL = "mcp__genie__delete_files";

  /**
   * Kit-relative path prefix that marks a file as design-token source (genie#239). `create_kit`'s
   * starter tree and every fixture/demo kit put token files under `tokens/` (see
   * `packages/viewer/test/fixtures/kit/tokens/colors.css`), so this is the same convention
   * `conjure`'s system prompt already asks the model to look for (tokens, primitives, house style)
   * — just resolved from real kit files instead of the caller inventing them.
   */
  var TOKENS_DIR_PREFIX = "tokens/";

  /**
   * Canonical root stylesheet a kit may keep its shared variables/import closure in, alongside (or
   * instead of) `tokens/**`. The viewer's own static serving (`packages/viewer/README.md:106`,
   * `packages/viewer/src/ config.ts:234`) and HMR both treat root `styles.css` as token context, so
   * `buildKitContext` must include it too — otherwise a kit that keeps its house style here (rather
   * than under `tokens/`) sends no styling context at all (Copilot review on #246).
   */
  var ROOT_STYLES_PATH = "styles.css";

  /**
   * Hard caps on how much kit context genie#239's `buildKitContext` will ever read into the
   * `conjure` call. `read_file` already caps a single file at 256 KiB (`MAX_FILE_BYTES`,
   * read_file.ts) — this bounds the *count* of token files read (a kit could have dozens) and the
   * *total* character budget handed to the model, so a token-heavy kit can't balloon the request or
   * blow past `conjure`'s own 100_000-char `kit` field cap (conjure.ts `conjureInputShape`).
   */
  var KIT_CONTEXT_MAX_TOKEN_FILES = 12;
  var KIT_CONTEXT_MAX_CHARS = 20_000;

  /**
   * How many existing components' file contents `buildKitContext` will read for
   * primitive/house-style context, beyond the bare group/name inventory (Copilot review on #246:
   * metadata alone gives the model no actual primitive code to match). Small — a handful of
   * representative components is enough context without ballooning the request.
   */
  var KIT_CONTEXT_MAX_COMPONENT_FILES = 5;

  /**
   * Overall wall-clock budget (ms) for ALL of `buildKitContext`'s tool calls combined. Each
   * individual `read_file`/`list_*` call still inherits the host bridge's normal per-call timeout
   * (60s), so serial reads could otherwise stall `conjure` by many minutes (Copilot review on
   * #246). Context-gathering is best-effort by design, so once this deadline is hit we proceed with
   * whatever partial context has resolved so far rather than waiting on slower calls.
   */
  var KIT_CONTEXT_DEADLINE_MS = 8_000;

  /**
   * Default deadline (ms) for a generic host tool call (e.g. list-kits, ping-style round trips).
   * Cheap calls that hang past this are almost certainly stuck, so a short timeout surfaces real
   * failures quickly.
   */
  var DEFAULT_HOST_TOOL_TIMEOUT_MS = 60_000;

  /**
   * Sentinel: "do not apply a client-side deadline to this request" (genie#241 / genie#243). Passed
   * as `callTool`'s `callTimeoutMs` for conjure only. See `docs/developer/architecture.md` →
   * "The conjure call takes no client deadline" for why no fixed ceiling is derivable.
   */
  var NO_CLIENT_DEADLINE = null;

  /**
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * (“iframe `src` normalization”) — viewer.js is capped at 256 KiB (#253).
   */
  var URL_TAB_OR_NEWLINE_RE = /[\t\n\r]/g;
  // eslint-disable-next-line no-control-regex
  var URL_EDGE_C0_RE = /^[\x00- ]+|[\x00- ]+$/g;
  var URL_HTML_METACHAR_RE = /[<>"'`]/g;
  /**
   * Percent-ENCODE the URL metacharacters rather than dropping them. Deleting `'` silently
   * retargets a legitimate manifest path (`.../O'Reilly/preview.html`) at a different file; the
   * escape resolves to the byte the manifest actually names. Still a global replace over a regex
   * that always matches `<`, `'` and `"`, so it remains a recognised escaping sanitizer.
   */
  var URL_METACHAR_ESCAPES = { "<": "%3C", ">": "%3E", '"': "%22", "'": "%27", "`": "%60" };
  function escapeUrlMetachar(ch) {
    return URL_METACHAR_ESCAPES[ch];
  }
  /**
   * WHATWG resolves `\\` exactly like `//` against a special (http/https/file) base, so
   * `\\evil.example/x` is protocol-relative and lands off-origin. Match on either slash.
   */
  var URL_LEADING_SLASHES_RE = /^[/\\]{2}/;
  var ANY_URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
  var SAFE_FRAME_SCHEME_RE = /^(?:https?|data):/i;
  /**
   * The one shape the card-asset broker mints. Optional port group, exact 1-65535 alternation, and
   * kept a LITERAL so CodeQL can parse it; see `docs/developer/architecture.md` —
   * "Broker-served draft previews (#257)".
   */
  // prettier-ignore
  var DRAFT_PREVIEW_SRC_RE = /^http:\/\/127\.0\.0\.1(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?\/d\/[0-9a-f]{32}$/;

  /**
   * Is an ALREADY-NORMALIZED URL safe to hand an iframe? Split out of `safeFrameSrc` and called in
   * guard position on purpose: static analysis (CodeQL) clears taint at a recognised sanitizer
   * *guard*, never at a transformer whose return value is derived from tainted input. Folding this
   * back into a single function reopens alerts 8-11. Callers must normalize first.
   *
   * @param {string} url
   * @returns {boolean}
   */
  function isSafeFrameSrc(url) {
    if (!url || URL_LEADING_SLASHES_RE.test(url)) return false;
    if (!ANY_URL_SCHEME_RE.test(url)) return true;
    return SAFE_FRAME_SCHEME_RE.test(url);
  }

  /**
   * Is this exactly a card-asset-broker draft URL? Called in GUARD position, never as a
   * transformer -- see architecture.md, "Broker-served draft previews (#257)".
   * @param {unknown} url
   * @returns {boolean}
   */
  function isDraftPreviewSrc(url) {
    return typeof url === "string" && DRAFT_PREVIEW_SRC_RE.test(url);
  }

  /**
   * @param {unknown} value
   * @returns {string} the value when safe, else "about:blank"
   */
  function safeFrameSrc(value) {
    if (typeof value !== "string") return "about:blank";
    var url = value
      .replace(URL_TAB_OR_NEWLINE_RE, "")
      .replace(URL_EDGE_C0_RE, "")
      .replace(URL_HTML_METACHAR_RE, escapeUrlMetachar);
    return isSafeFrameSrc(url) ? url : "about:blank";
  }

  /**
   * Fallback card height (px) for a named/unparseable viewport (e.g. "desktop"). A comfortable
   * 16:10-ish default so a card without an explicit WxH still reserves a sensible preview area
   * instead of collapsing to nothing.
   */
  var DEFAULT_CARD_HEIGHT = 320;

  var VIEWPORT_TOKEN_RE = /^(\d+)x(\d+)$/;

  /**
   * Parse a manifest `viewport` token into `{ width, height }`, or `null` when it is a named token
   * ("desktop"), empty, absent, or otherwise not the strict `<digits>x<digits>` shape. Mirrors the
   * server's `extractViewport` so the viewer and compiler agree on exactly which tokens are
   * dimensional.
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
    // A zero (or non-positive) dimension is degenerate — treat it like a named token and fall back
    // to the default height rather than render a 0-size, invisible iframe.
    if (width <= 0 || height <= 0) return null;
    return { width: width, height: height };
  }

  /**
   * Bucket components by `group`, preserving first-seen group order (used as the fallback order
   * when the manifest has no usable `groups[]` — see {@link computeGroupOrder}).
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
   * See architecture.md -> "Section display order".
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
    // Remainder: any group actually present in `grouped` that the declared list didn't name (or the
    // whole list was absent/empty/malformed) — appended in first-seen order, never dropped.
    for (var key of grouped.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    return order;
  }

  /**
   * Returns `value` trimmed, or `fallback` when it is missing, empty, or whitespace-only.
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * ("Guaranteeing a non-empty accessible name") — viewer.js is capped at 256 KiB (#253).
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
   * Build one card element for a component: a header (name + group pill + viewport meta) and a
   * sandboxed, lazy `<iframe>` preview.
   *
   * @param {Document} doc
   * @param {object} card
   * @returns {HTMLElement}
   */
  function createCard(doc, card) {
    var article = doc.createElement("article");
    article.className = "ds-card";
    // Lowercased once here so the search filter (AC5) is a plain substring test and never
    // re-lowercases per keystroke.
    article.setAttribute("data-name", (card.name || "").toLowerCase());

    // M4-09 AC3 — keyboard-operable card: `tabindex="0"` puts it in Tab order, `role="link"` + an
    // explicit `aria-label` give it a clean accessible name (see the module doc's "Accessibility"
    // section — without the label, a screen reader concatenates the heading + group pill + viewport
    // text with no separators), and Enter/click activate it (`role="link"` supplies semantics only,
    // never key handling — unlike a real `<a>`, so the listener below is required, not decorative).
    // There is no dedicated card-detail route yet (M4-05 leaves "per-card detail view" out of scope
    // for v1), so the placeholder destination is the component's own preview: the one real,
    // already-working URL a card carries.
    article.setAttribute("tabindex", "0");
    article.setAttribute("role", "link");
    // `accessibleName` guards against axe-core's `link-name` (critical): an empty-string aria-label
    // is worse than none (it suppresses the normal fall-back-to-content accessible-name
    // computation), so an unnamed component still gets a real label rather than an empty one.
    article.setAttribute("aria-label", accessibleName(card.name, "Untitled component"));
    var openDetail = function () {
      var view = doc.defaultView;
      if (view && card.path) view.location.assign(card.path);
    };
    article.addEventListener("click", openDetail);
    article.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        // Prevent a default action (e.g. a native scroll-on-Enter in some ATs) before navigating —
        // mirrors how a real `<a>` suppresses it too.
        event.preventDefault();
        openDetail();
      }
    });

    var header = doc.createElement("header");
    header.className = "ds-card__head";

    var title = doc.createElement("h3");
    title.className = "ds-card__name";
    // textContent, never innerHTML — a hostile component name must not inject markup into the
    // viewer chrome.
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
    // AC3 — allow-scripts ONLY. No allow-same-origin: a compromised preview stays walled off from
    // the viewer's origin (defence in depth; M4-07 adds the full CSP layer).
    iframe.setAttribute("sandbox", "allow-scripts");
    // AC4 — never eagerly load offscreen previews.
    iframe.setAttribute("loading", "lazy");
    var cardSrc = card.path || "";
    var cardIdentity = card.sourcePath || cardSrc;
    iframe.setAttribute("src", safeFrameSrc(cardSrc));
    // M4-09 AC5 — the accessible name axe-core's `frame-title` rule checks for. `accessibleName`
    // guards the same empty-string trap as the card's own aria-label above: `title=""` is
    // indistinguishable from a missing title to `frame-title`, so a nameless component still gets a
    // real fallback string.
    iframe.setAttribute("title", accessibleName(card.name, "preview"));
    // M4-09 AC3 — a sandboxed iframe is still natively focusable, so pull it out of Tab order
    // or it interleaves: search → card → iframe → card. See architecture.md.
    iframe.setAttribute("tabindex", "-1");
    // M4-04 (DRO-266) — the canonical, kit-root-relative preview path, kept verbatim (never
    // cache-busted) so the HMR bridge can match a `card.changed` message's `path` against exactly
    // this attribute. The live `src` may later carry an `?__genie_hmr=N` cache-bust (see
    // reloadIframeEl); `data-path` stays the stable identity.
    iframe.setAttribute("data-path", cardIdentity);
    // Embedded manifests replace `path` with an absolute/data transport URL. Keep that source
    // separate from the kit-relative identity above so a host can target the card by sourcePath and
    // replace its bytes safely.
    iframe.setAttribute("data-src", cardSrc);

    // AC2 — size from the viewport when it is a real WxH; otherwise reserve a sane default height
    // and let CSS own the width (responsive column).
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
   * Render the whole manifest into `grid`: one `<section>` per group (labelled, with a heading),
   * each holding its cards, in the order {@link computeGroupOrder} resolves. An empty manifest
   * renders a single visible empty state and zero iframes (AC6). Idempotent: clears any prior
   * render first, so a re-render (e.g. future HMR, M4-04) never doubles cards.
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
      // A declared-but-now-empty group (stale `groups[]` entry) is skipped — an empty section would
      // render a heading over nothing.
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
    // Copilot review (PR #248) — `grid` is hidden once Browse is the visible surface; mirror this
    // into the workbench so the error is actually seen.
    renderBrowseWorkbenchError(doc, detail);
  }

  /**
   * Copilot #1 — extract the embedded manifest a `ui/notifications/tool- result` payload carries,
   * using the SAME resolution order `renderToolResult` itself uses (`_meta` key first, then
   * `structuredContent.embeddedManifest`), so the Browse workbench and the hidden `#grid` are
   * always kept in sync from one source of truth.
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
    iframe.setAttribute("src", safeFrameSrc(parsed.toString()));
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
      // No host frame to hand-shake with. Resolve the shell out of its pending state so a caller
      // that started it as `undefined` (the inline tier) can't get stranded showing a spinner
      // forever — mirrors the old non-host path that went straight to `initProductShell(doc, null)`
      // (immediate unavailable). Embedded frames never reach here (parent !== win).
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
        // A host can complete the `ui/initialize` handshake without actually advertising tool-proxy
        // support. MCP Apps signals that support via `hostCapabilities.serverTools` in the
        // InitializeResult — gate on it explicitly instead of treating any successful reply as
        // "ready", otherwise a handshake-only host still enables Conjure and only fails later at
        // `tools/call` time.
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
          // Copilot #1 — keep the Browse workbench (not just the hidden `#grid`) in sync with every
          // live tool-result update, the same manifest source `renderToolResult` just wrote into
          // `#grid`.
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

  /**
   * DRO-242 (fail closed) — validates a single `list_kits` reply entry against its canonical output
   * shape (`{ id, name, owner, updatedAt, canEdit }`, `packages/server/src/tools/list_kits.ts`).
   * Both `owner` and `updatedAt` are required strings in that schema (not optional), so a host
   * reply missing either — or supplying a non-string value — is rejected here rather than silently
   * coerced or ignored. `owner` is
   * rendered directly into the kit `<option>` label (`kits[i].owner ||
   * "local"`), so a non-string owner (e.g. an object) would otherwise reach `textContent`
   * interpolation as `[object Object]`.
   */
  function isKitEntry(kit) {
    return Boolean(
      isPlainObject(kit) &&
      hasOnlyKeys(kit, ["id", "name", "owner", "updatedAt", "canEdit"]) &&
      typeof kit.id === "string" &&
      kit.id &&
      typeof kit.name === "string" &&
      typeof kit.owner === "string" &&
      typeof kit.updatedAt === "string" &&
      typeof kit.canEdit === "boolean",
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

  /**
   * DRO-242 — a "plain object" for schema-validation purposes: not `null`, not an array, and not
   * any other non-object primitive. Both `isConjureResult` and `loadKits`' reply/entry checks use
   * this so a host that swaps an expected object for an array (or vice versa) fails closed instead
   * of accidentally satisfying a loose `typeof x === "object"` check (which is also `true` for
   * arrays and `null` is falsy but worth being explicit about).
   */
  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * Reject any key outside a known set, so the server's `.strict()` shapes are really enforced.
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * ("Enforcing strict object shapes in the viewer") — viewer.js is capped at 256 KiB (#253).
   */
  function hasOnlyKeys(value, allowedKeys) {
    return Object.keys(value).every(function (key) {
      return allowedKeys.indexOf(key) !== -1;
    });
  }

  /**
   * DRO-242 (fail closed, Copilot review round 4) — the `<Name>` segment pattern `COMPONENT_SCHEMA`
   * (`packages/server/src/llm/schema.ts`) reuses across `componentName`, `files[].path`'s directory
   * segment, and the `<Name>.html` `contains` backreference: `[A-Z][A-Za-z0-9]{1,63}` (PascalCase,
   * 2-64 chars total).
   */
  var COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{1,63}$/;

  /** DRO-242 — kebab-case `group`, `[a-z0-9-]{1,32}` (COMPONENT_SCHEMA). */
  var GROUP_PATTERN = /^[a-z0-9-]{1,32}$/;

  /**
   * DRO-242 — `files[].path` must land under `components/<group>/<Name>/` (AC4 in
   * `packages/server/src/llm/schema.ts`): `<group>` is kebab-case, `<Name>` is PascalCase, and the
   * basename allows the broader `[A-Za-z0-9._-]+` (covers `<Name>.tsx`, `<Name>.d.ts`,
   * `<Name>.prompt.md`, `<Name>.html`, `meta.json`).
   */
  var FILE_PATH_PATTERN = /^components\/[a-z0-9-]+\/[A-Z][A-Za-z0-9]+\/[A-Za-z0-9._-]+$/;

  /**
   * DRO-242 — `mimeType` pattern lifted verbatim from `COMPONENT_SCHEMA`'s `files[].mimeType`
   * (`type/subtype` per RFC 6838's token grammar).
   */
  var MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

  /**
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * (“`files[]` entry validation”) — viewer.js is capped at 256 KiB (#253).
   */
  function isCodePointLengthWithinBounds(value, min, max) {
    var count = 0;
    // Iterated purely for its code-point-aware stepping; the yielded character itself isn't needed.
    for (var _ of value) {
      count += 1;
      if (count > max) return false;
    }
    return count >= min;
  }

  /**
   * DRO-242 (fail closed, Copilot review round 5) — `files[].content`'s canonical bounds
   * (`packages/server/src/llm/schema.ts`'s `minLength: 1, maxLength: 65536`). Previously only the
   * empty string was rejected; an oversized (>64KiB) `content` string still passed. Round 6: bounds
   * are checked in Unicode code points via `isCodePointLengthWithinBounds`, not UTF-16 code units,
   * so astral characters (e.g. many emoji) are counted correctly.
   */
  var CONTENT_MAX_LENGTH = 65536;

  /**
   * Copilot (round 6) — mirrors `isValidBase64Content` in `packages/server/src/store/kit-files.ts`.
   * Without it a draft carrying malformed base64 sails through Review (Apply enabled, byte counts
   * nonsense) and only dies inside `write_files`, after the user has already consented.
   */
  var BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

  function isValidBase64(data) {
    if (data.length === 0) return true;
    return BASE64_PATTERN.test(data) && data.length % 4 === 0;
  }

  function isConjureFileEntry(value) {
    return Boolean(
      isPlainObject(value) &&
      hasOnlyKeys(value, ["path", "content", "mimeType", "encoding"]) &&
      typeof value.path === "string" &&
      FILE_PATH_PATTERN.test(value.path) &&
      typeof value.content === "string" &&
      isCodePointLengthWithinBounds(value.content, 1, CONTENT_MAX_LENGTH) &&
      (value.encoding !== "base64" || isValidBase64(value.content)) &&
      typeof value.mimeType === "string" &&
      MIME_TYPE_PATTERN.test(value.mimeType) &&
      (value.encoding === "utf-8" || value.encoding === "base64"),
    );
  }

  /**
   * DRO-242 (fail closed, Copilot review round 4) — AC5's `contains` rule: at least one `files[]`
   * entry must be a `<Name>.html` file whose `<Name>` matches the containing directory's `<Name>`
   * segment (self-consistent `Button/Button.html`, not `Button/Wrong.html`) — mirrors
   * `HTML_FILE_CONTAINS` in `packages/server/src/llm/schema.ts`.
   */
  function isHtmlFileEntry(file) {
    return /\.html$/.test(file.path);
  }

  function hasMatchingHtmlPreview(files) {
    return files.some(function (file) {
      var match = /^components\/[a-z0-9-]+\/([A-Z][A-Za-z0-9]{1,63})\/([^/]+)$/.exec(file.path);
      return Boolean(match && match[2] === match[1] + ".html");
    });
  }

  /**
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * (“`manifestEntry` validation”) — viewer.js is capped at 256 KiB (#253).
   */
  var VIEWPORT_DIMENSION_MIN = 1;
  var VIEWPORT_DIMENSION_MAX = 4096;
  var SUBTITLE_MAX_LENGTH = 256;
  var TAGS_MAX_ITEMS = 16;

  function isViewportDimension(value) {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= VIEWPORT_DIMENSION_MIN &&
      value <= VIEWPORT_DIMENSION_MAX
    );
  }

  function isManifestEntry(value) {
    if (!isPlainObject(value) || !hasOnlyKeys(value, ["viewport", "subtitle", "tags"])) {
      return false;
    }
    if (!isPlainObject(value.viewport) || !hasOnlyKeys(value.viewport, ["width", "height"])) {
      return false;
    }
    if (!isViewportDimension(value.viewport.width) || !isViewportDimension(value.viewport.height)) {
      return false;
    }
    if (
      value.subtitle !== undefined &&
      (typeof value.subtitle !== "string" ||
        !isCodePointLengthWithinBounds(value.subtitle, 0, SUBTITLE_MAX_LENGTH))
    ) {
      return false;
    }
    if (
      value.tags !== undefined &&
      !(
        Array.isArray(value.tags) &&
        value.tags.length <= TAGS_MAX_ITEMS &&
        value.tags.every(function (tag) {
          return typeof tag === "string";
        })
      )
    ) {
      return false;
    }
    return true;
  }

  /**
   * DRO-242 (fail closed) — validates `usage` against conjure's canonical output schema:
   * `promptTokens`, `completionTokens`, and `totalTokens` must each be non-negative integers, and
   * no other key is allowed (`.strict()`). An object-like-but-empty `usage: {}` must be rejected
   * rather than accepted as "truthy object".
   */
  function isConjureUsage(value) {
    return Boolean(
      isPlainObject(value) &&
      hasOnlyKeys(value, ["promptTokens", "completionTokens", "totalTokens"]) &&
      isNonNegativeInteger(value.promptTokens) &&
      isNonNegativeInteger(value.completionTokens) &&
      isNonNegativeInteger(value.totalTokens),
    );
  }

  function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }

  /**
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * (“`conjure` reply validation”) — viewer.js is capped at 256 KiB (#253).
   */
  /**
   * Copilot (round 7) — `write_files` rejects a repeated `path` with `DuplicatePathError`, so a
   * payload the reviewer approves here would fail only AFTER confirmation. Fail closed at the
   * gate. `files` is capped at 12, so the pairwise scan is cheaper than building a Set.
   */
  function hasUniquePaths(files) {
    for (var i = 0; i < files.length; i++) {
      for (var j = i + 1; j < files.length; j++) {
        if (files[i].path === files[j].path) return false;
      }
    }
    return true;
  }

  /**
   * The payload shape every reviewable draft shares, whatever produced it. Rationale relocated
   * verbatim to `docs/developer/architecture.md` (“Validating a Browse baseline on its own
   * terms”) — viewer.js is capped at 256 KiB (#253).
   *
   * @param {unknown} value
   * @returns {boolean}
   */
  function hasReviewableCore(value) {
    return Boolean(
      isPlainObject(value) &&
      typeof value.componentName === "string" &&
      COMPONENT_NAME_PATTERN.test(value.componentName) &&
      typeof value.group === "string" &&
      GROUP_PATTERN.test(value.group) &&
      Array.isArray(value.files) &&
      value.files.length >= 1 &&
      value.files.length <= 12 &&
      value.files.every(isConjureFileEntry) &&
      hasUniquePaths(value.files),
    );
  }

  /**
   * Type-check ONLY; the frame-aiming decision belongs to `isDraftPreviewSrc` at render time. The
   * key survives `Object.keys` because tweaks clear it by assigning `undefined`. See
   * architecture.md, "Broker-served draft previews (#257)".
   */
  function isOptionalPreviewUrl(value) {
    return value === undefined || typeof value === "string";
  }

  /** The broker's eviction notice (#257): absent, or a list of URLs it stopped serving. */
  function isOptionalPreviewUrlList(value) {
    if (value === undefined) return true;
    if (!Array.isArray(value)) return false;
    for (var i = 0; i < value.length; i++) {
      if (typeof value[i] !== "string") return false;
    }
    return true;
  }

  function isConjureResult(value) {
    return Boolean(
      hasReviewableCore(value) &&
      hasOnlyKeys(value, [
        "componentName",
        "group",
        "files",
        "manifestEntry",
        "usage",
        "previewUrl",
        "expiredPreviewUrls",
      ]) &&
      isOptionalPreviewUrl(value.previewUrl) &&
      isOptionalPreviewUrlList(value.expiredPreviewUrls) &&
      hasMatchingHtmlPreview(value.files) &&
      isManifestEntry(value.manifestEntry) &&
      isConjureUsage(value.usage),
    );
  }

  /**
   * Copilot (round 9) — a Browse handoff, and any deterministic tweak of one, never made a
   * model call: it has no `usage` and no conjure `manifestEntry`. Forcing it through
   * `isConjureResult` failed the `schema` row forever and pinned Apply shut. Fabricating a
   * zero-token `usage` would put a lie in the summary’s Tokens row, so validate what the
   * payload actually is. `diff` is optional: `applyDeterministicTweak` copies every own key and
   * adds a recomputed one.
   *
   * @param {unknown} value
   * @returns {boolean}
   */
  function isBrowseBaseline(value) {
    if (!hasReviewableCore(value)) return false;
    if (!hasOnlyKeys(value, ["componentName", "group", "files", "diff"])) return false;
    // The preview pane still needs something to render, but `Card/preview.html` is a legitimate
    // kit entry point, so the canonical `<Name>/<Name>.html` rule cannot apply here.
    if (!value.files.some(isHtmlFileEntry)) return false;
    if (value.diff === undefined) return true;
    return typeof value.diff === "string" && value.diff.length <= DIFF_MAX_LENGTH;
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

  /* ------------------------------------------------------------------ *
   * M7-03 (#235) — Review → Refine → Approve → Apply.
   *
   * Everything below is deliberately pure: the reducer, the gates and the
   * checks take plain values and return plain values, so the safety rules
   * that matter (nothing writes without an explicit, confirmed Apply; any
   * change to the draft drops approval) are testable without a DOM or a
   * host. The DOM layer further down only reads these results.
   * ------------------------------------------------------------------ */

  /**
   * Mirror of `packages/server/src/validate/marker.ts`. Kept byte-compatible on purpose: the
   * viewer's marker check must agree with the server's, or a draft could look green here and be
   * rejected on write.
   */
  var MARKER_REGEX = /^<!--\s*@genie\s+group="[^"]*"[^>]*-->/;

  /** A refine diff is display-only, but it is still untrusted host text. */
  var DIFF_MAX_LENGTH = 262144;

  /**
   * Refine returns the conjure payload plus a unified diff. Validating it through `isConjureResult`
   * (rather than a parallel implementation) keeps the two paths from drifting apart.
   */
  function isRefineResult(value) {
    if (!isPlainObject(value)) return false;
    if (
      !hasOnlyKeys(value, [
        "componentName",
        "group",
        "files",
        "manifestEntry",
        "usage",
        "diff",
        "previewUrl",
        "expiredPreviewUrls",
      ])
    ) {
      return false;
    }
    // Copilot (round 5) — an EMPTY diff is a valid answer: `buildUnifiedDiff` returns "" when the
    // model returns a byte-identical file set, and `refineOutputShape.diff` is a bare `z.string()`.
    // Only the type and size guards protect anything here.
    if (typeof value.diff !== "string") return false;
    if (value.diff.length > DIFF_MAX_LENGTH) return false;
    return isConjureResult({
      componentName: value.componentName,
      group: value.group,
      files: value.files,
      manifestEntry: value.manifestEntry,
      usage: value.usage,
      previewUrl: value.previewUrl,
      expiredPreviewUrls: value.expiredPreviewUrls,
    });
  }

  /**
   * Count the real changed lines in a unified diff. AC5 forbids cosmetic statistics, so `+++`/`---`
   * file headers are excluded and the file list is taken from the diff itself rather than from the
   * draft's file array.
   */
  function parseUnifiedDiff(diff) {
    var stats = { additions: 0, deletions: 0, files: [] };
    if (typeof diff !== "string" || !diff) return stats;
    var lines = diff.split("\n");
    var seen = Object.create(null);
    function noteFile(path) {
      if (!path || path === "/dev/null") return;
      if (seen[path]) return;
      seen[path] = true;
      stats.files.push(path);
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("diff --git ") === 0) {
        var parts = line.slice("diff --git ".length).split(" ");
        noteFile(stripDiffPathPrefix(parts[parts.length - 1]));
        continue;
      }
      // Header checks must run before the +/- counters, and must be exact: an ADDED line whose
      // content starts `++ ` is not a `+++ ` header.
      if (line.indexOf("+++ ") === 0 && line.indexOf("++++") !== 0) {
        noteFile(stripDiffPathPrefix(line.slice(4).split("\t")[0]));
        continue;
      }
      if (line.indexOf("--- ") === 0 && line.indexOf("----") !== 0) continue;
      if (line.charAt(0) === "+") stats.additions += 1;
      else if (line.charAt(0) === "-") stats.deletions += 1;
    }
    return stats;
  }

  function stripDiffPathPrefix(path) {
    if (typeof path !== "string") return "";
    var trimmed = path.trim();
    if (trimmed.indexOf("a/") === 0 || trimmed.indexOf("b/") === 0) return trimmed.slice(2);
    return trimmed;
  }

  /*
   * Embedded-tier CSP is `default-src 'none'` with no web fonts (RFC G-5), so
   * a draft that reaches for the network cannot render in the host and must
   * never be written. These patterns are intentionally broad — a false
   * positive costs the user one refine; a false negative ships a broken card.
   */
  // Copilot (round 2) — matching only `//` let RELATIVE subresources through, and those break just
  // as hard: the card CSP has no `style-src`, so a `<link rel=stylesheet href="x.css">` falls to
  // `default-src 'none'`; `font-src 'none'` kills `url(./f.woff2)`; and the review preview's
  // sandbox has no `allow-same-origin`, so `img-src 'self'` matches nothing. A path that is not in
  // the draft's own `files` is dangling by construction. Only inline forms (`data:`, `#`) can ever
  // resolve.
  var LOCAL_REF = "(?!\\s*(?:data:|#))";
  var EXTERNAL_ATTR_URL_PATTERN = new RegExp(
    '\\b(?:src|href|srcset|data|poster)\\s*=\\s*(?:"' +
      LOCAL_REF +
      '[^"]+"' +
      "|'" +
      LOCAL_REF +
      "[^']+'" +
      "|(?![\"'])" +
      LOCAL_REF +
      "[^\\s>]+)",
    "i",
  );
  var EXTERNAL_CSS_URL_PATTERN = new RegExp("url\\(\\s*[\"']?" + LOCAL_REF + "[^)]+\\)", "i");
  // Copilot (round 10) — the `data:` exemption above is only correct for IMAGE-bearing attributes.
  // Rationale relocated verbatim to `docs/developer/architecture.md`
  // ("A `data:` URL is only inert on an image attribute") — viewer.js is capped at 256 KiB (#253).
  var BLOCKED_DATA_URL_RE =
    /<(?:video|audio|source|track|object|embed|iframe)\b[^>]*\b(?:src|data)\s*=\s*["']?\s*data:/i;
  var REMOTE_IMPORT_PATTERN = /@import\s/i;
  var SCRIPT_TAG_PATTERN = /<script\b/i;
  var FONT_FACE_PATTERN = /@font-face/i;
  // Copilot #10 (PR #250) — inline handlers are script; `default-src 'none'` blocks them like a
  // <script> tag. Anchored on a tag-internal boundary so prose such as "turn it on click" cannot
  // trip it.
  var INLINE_HANDLER_PATTERN = /<[a-z][^>]*\son[a-z]+\s*=/i;

  // Copilot (round 7) — `srcset` is a COMMA-SEPARATED candidate list, so the attribute check above
  // (a negative lookahead anchored at the value's start) cleared the whole list on the strength of
  // its first entry: `srcset="data:… 1x, https://cdn/x.png 2x"` passed while the 2x candidate was
  // a live remote fetch. Parse it the way HTML does — split on WHITESPACE, not commas, because a
  // base64 `data:` URL legitimately contains a comma and never a space. Anything that is not a
  // width/pixel-density descriptor is a URL, and an unrecognised token is treated as one.
  var SRCSET_ATTR_RE = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  var SRCSET_DESCRIPTOR_RE = /^\d+(?:\.\d+)?[wx]$/i;
  var LOCAL_URL_RE = /^(?:data:|#)/i;

  function srcsetReachesNetwork(content) {
    SRCSET_ATTR_RE.lastIndex = 0;
    var match;
    while ((match = SRCSET_ATTR_RE.exec(content))) {
      var parts = (match[1] || match[2] || match[3] || "").split(/\s+/);
      for (var i = 0; i < parts.length; i++) {
        var token = parts[i].replace(/^,+/, "").replace(/,+$/, "");
        if (!token || SRCSET_DESCRIPTOR_RE.test(token)) continue;
        if (!LOCAL_URL_RE.test(token)) return true;
      }
    }
    return false;
  }

  // Copilot (round 7) — `default-src 'none'` does not govern document NAVIGATION, so a
  // `<meta http-equiv="refresh" content="0;url=…">` still leaves the card blank and, on a remote
  // target, still makes the request. Browsers decode character references inside attribute values
  // before matching `http-equiv`, so decode numeric ones first; no NAMED reference spells a bare
  // ASCII letter, which is why decimal + hex is the complete set for this attack.
  var NUMERIC_CHAR_REF_RE = /&#(?:(\d+)|[xX]([\dA-Fa-f]+));?/g;
  var META_REFRESH_PATTERN = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b/i;

  function declaresMetaRefresh(content) {
    var decoded = content.replace(NUMERIC_CHAR_REF_RE, function (whole, dec, hex) {
      var code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
    return META_REFRESH_PATTERN.test(decoded);
  }

  function violatesEmbeddedCsp(content) {
    if (typeof content !== "string") return false;
    return (
      EXTERNAL_ATTR_URL_PATTERN.test(content) ||
      BLOCKED_DATA_URL_RE.test(content) ||
      srcsetReachesNetwork(content) ||
      declaresMetaRefresh(content) ||
      EXTERNAL_CSS_URL_PATTERN.test(content) ||
      REMOTE_IMPORT_PATTERN.test(content) ||
      SCRIPT_TAG_PATTERN.test(content) ||
      INLINE_HANDLER_PATTERN.test(content) ||
      FONT_FACE_PATTERN.test(content)
    );
  }

  /** The canonical `components/<group>/<Name>/<Name>.html` preview entry. */
  function findPreviewFile(result) {
    if (!result || !Array.isArray(result.files)) return null;
    var expected =
      "components/" +
      result.group +
      "/" +
      result.componentName +
      "/" +
      result.componentName +
      ".html";
    for (var i = 0; i < result.files.length; i++) {
      if (result.files[i] && result.files[i].path === expected) return result.files[i];
    }
    return null;
  }

  /** See architecture.md -> "Resolving the preview file to render". */
  function resolvePreviewFile(result) {
    var canonical = findPreviewFile(result);
    if (canonical) return canonical;
    if (!result || !Array.isArray(result.files)) return null;
    var only = null;
    for (var i = 0; i < result.files.length; i++) {
      var file = result.files[i];
      if (!file || typeof file.path !== "string" || !/\.html$/i.test(file.path)) continue;
      if (only) return null;
      only = file;
    }
    return only;
  }

  function componentPrefix(result) {
    var group = (result && result.group) || "";
    var name = (result && result.componentName) || "";
    return "components/" + group + "/" + name + "/";
  }

  function isInsidePrefix(path, prefix) {
    return (
      typeof path === "string" &&
      FILE_PATH_PATTERN.test(path) &&
      path.indexOf(prefix) === 0 &&
      path.indexOf("..") === -1
    );
  }

  /**
   * Copilot (round 4) — ONE containment predicate for both the proposed writes and the deletions
   * the diff implies. Deletes are derived from untrusted model output, so checking only `files`
   * let a malformed reply name any path in the kit; `plan` would then authorise that exact path
   * and `delete_files` would honour it.
   */
  function isContained(result) {
    if (!result || !Array.isArray(result.files) || !result.files.length) return false;
    var prefix = componentPrefix(result);
    var writesOk = result.files.every(function (file) {
      return Boolean(file) && isInsidePrefix(file.path, prefix);
    });
    return (
      writesOk &&
      deletedPathsFromDiff(result.diff).every(function (path) {
        return isInsidePrefix(path, prefix);
      })
    );
  }

  /**
   * The review checklist. Every entry is backed by a real result — nothing is decorative. `kind`
   * drives the gate: `auto` must pass, `manual` needs an explicit acknowledgement, and `deferred`
   * can never be green before the write because its source (`validate`'s full scan) is kit-wide and
   * only meaningful once the bytes are on disk.
   */
  function computeChecklist(input) {
    var result = input && input.result;
    if (!result) return [];
    var renderState = (input && input.renderState) || "pending";
    var acks = (input && input.manualAcks) || {};

    var preview = resolvePreviewFile(result);
    var schemaOk = isConjureResult(result) || isRefineResult(result) || isBrowseBaseline(result);
    var cspOk =
      Array.isArray(result.files) &&
      result.files.every(function (file) {
        return !violatesEmbeddedCsp(file && file.content);
      });
    var markerOk = Boolean(
      preview &&
      typeof preview.content === "string" &&
      MARKER_REGEX.test(preview.content.split("\n", 1)[0]),
    );

    function auto(id, label, ok, detail) {
      return { id: id, label: label, kind: "auto", state: ok ? "pass" : "fail", detail: detail };
    }
    function manual(id, label, detail) {
      return {
        id: id,
        label: label,
        kind: "manual",
        state: acks[id] ? "pass" : "pending",
        detail: detail,
      };
    }

    return [
      auto("schema", "Structured output matches the component schema", schemaOk),
      auto("marker", "@genie marker on the preview's first line", markerOk),
      auto(
        "preview-file",
        "Self-consistent " + result.componentName + "/" + result.componentName + ".html",
        Boolean(preview) && hasMatchingHtmlPreview(result.files),
      ),
      auto("containment", "Every path stays inside this component's folder", isContained(result)),
      auto("csp", "Embedded CSP safe — no remote assets, fonts or script", cspOk),
      {
        id: "render",
        label: "Preview rendered a document",
        kind: "auto",
        state: renderState === "pass" ? "pass" : renderState === "fail" ? "fail" : "pending",
        // Copilot (round 2) — `load` fires for a blank or subresource-starved frame too, so this
        // proves the document PARSED and nothing more. Whether its assets can resolve is the CSP
        // row's job, above.
        detail: "The sandboxed frame parsed this document.",
      },
      {
        id: "kit-validate",
        label: "Kit-wide validation",
        kind: "deferred",
        state: "pending",
        detail: "Runs against your kit after Apply — a draft is not on disk yet.",
      },
      manual("visual-intent", "Matches your visual intent"),
      manual("a11y-spot", "Keyboard and contrast spot-check"),
    ];
  }

  /**
   * The review reducer. Drafts are append-only and immutable; approval is bound to a specific
   * draft's identity, so AC9's rule ("any change drops approval") is structural rather than a thing
   * we must remember to do.
   */
  function createReviewStore() {
    var drafts = [];
    var currentNumber = 0;
    var approvedDraftId = null;
    var decision = "none";
    var manualAcks = {};
    var renderState = "pending";
    var appliedDraftId = null;
    var writtenPaths = [];
    var sequence = 0;

    function findCurrent() {
      for (var i = 0; i < drafts.length; i++) {
        if (drafts[i].number === currentNumber) return drafts[i];
      }
      return null;
    }

    function findById(id) {
      for (var i = 0; i < drafts.length; i++) {
        if (drafts[i].id === id) return drafts[i];
      }
      return null;
    }

    function dropApproval() {
      approvedDraftId = null;
      if (decision === "approved") decision = "none";
    }

    // The broker evicts; this history does not. Forget the URLs it names so the draft falls back
    // to `srcdoc`. See architecture.md, "Broker-served draft previews (#257)".
    function retireExpiredPreviews(result) {
      var gone = result && result.expiredPreviewUrls;
      if (!gone || !gone.length) return;
      for (var i = 0; i < drafts.length; i++) {
        var previous = drafts[i].result;
        if (!previous || typeof previous.previewUrl !== "string") continue;
        for (var j = 0; j < gone.length; j++) {
          if (gone[j] !== previous.previewUrl) continue;
          // Assigning `undefined` rather than deleting keeps the key enumerable, which is
          // what the strict validators already accept for a locally cleared preview.
          previous.previewUrl = undefined;
          break;
        }
      }
    }

    return {
      addDraft: function (result, source) {
        retireExpiredPreviews(result);
        sequence += 1;
        var number = drafts.length + 1;
        var draft = {
          id: "draft-" + sequence,
          number: number,
          label: "draft #" + number,
          result: result,
          source: source || "generate",
        };
        drafts.push(draft);
        currentNumber = number;
        // A new draft is a new thing to look at: acknowledgements, render state and any prior
        // decision all belong to the draft they were made against, never to its successor.
        manualAcks = {};
        renderState = "pending";
        decision = "none";
        approvedDraftId = null;
        return draft;
      },
      select: function (number) {
        for (var i = 0; i < drafts.length; i++) {
          if (drafts[i].number === number) {
            currentNumber = number;
            manualAcks = {};
            renderState = "pending";
            decision = "none";
            dropApproval();
            return drafts[i];
          }
        }
        return null;
      },
      approve: function () {
        var current = findCurrent();
        if (!current) return false;
        approvedDraftId = current.id;
        decision = "approved";
        return true;
      },
      requestChanges: function () {
        if (!findCurrent()) return false;
        dropApproval();
        decision = "changes-requested";
        return true;
      },
      acknowledge: function (id, value) {
        if (value) manualAcks[id] = true;
        else delete manualAcks[id];
        // Changing what you have vouched for changes what you approved.
        dropApproval();
      },
      setRenderState: function (state) {
        renderState = state;
      },
      /**
       * Stamp the applied marker onto a SPECIFIC draft (`draftId`), never "whatever is current when
       * the write resolves". Apply is async and the deterministic-tweak sliders stay live during
       * flight, so `current()` can have moved on to a brand-new, unwritten draft by the time this
       * runs — which would both block that draft forever and leave the draft that was actually
       * written still applyable (duplicate write).
       */
      markApplied: function (paths, draftId) {
        var target = draftId ? findById(draftId) : findCurrent();
        if (!target) return false;
        appliedDraftId = target.id;
        writtenPaths = Array.isArray(paths) ? paths.slice() : [];
        return true;
      },
      reset: function () {
        drafts = [];
        currentNumber = 0;
        approvedDraftId = null;
        decision = "none";
        manualAcks = {};
        renderState = "pending";
        appliedDraftId = null;
        writtenPaths = [];
      },
      current: findCurrent,
      isApproved: function () {
        var current = findCurrent();
        return Boolean(current && approvedDraftId === current.id);
      },
      state: function () {
        var current = findCurrent();
        return {
          drafts: drafts.slice(),
          currentNumber: currentNumber,
          currentId: current ? current.id : null,
          approvedDraftId: approvedDraftId,
          decision: decision,
          manualAcks: manualAcks,
          renderState: renderState,
          appliedDraftId: appliedDraftId,
          writtenPaths: writtenPaths.slice(),
        };
      },
    };
  }

  /**
   * Enumerate every reason Apply is unavailable. Returning the list (rather than just a boolean) is
   * the point: AC10 requires the UI to say what is missing instead of showing a dead button.
   */
  function computeApplyGate(input) {
    var state = (input && input.state) || {};
    var checklist = (input && input.checklist) || [];
    var blockers = [];
    var current = null;
    var drafts = state.drafts || [];
    for (var i = 0; i < drafts.length; i++) {
      if (drafts[i].number === state.currentNumber) current = drafts[i];
    }

    if (!current) {
      blockers.push("Generate or refine a draft before applying.");
    } else {
      if (state.appliedDraftId === current.id) {
        blockers.push("This draft is already applied to your kit.");
      }
      if (state.approvedDraftId !== current.id) {
        blockers.push("Approve this draft before applying.");
      }
    }

    for (var j = 0; j < checklist.length; j++) {
      var entry = checklist[j];
      if (!entry || entry.kind === "deferred") continue;
      if (entry.state === "fail") {
        blockers.push(entry.label + " — this check is failing.");
      } else if (entry.state === "pending") {
        blockers.push(
          entry.kind === "manual"
            ? "Confirm: " + entry.label + "."
            : entry.label + " — this check has not finished.",
        );
      }
    }

    if (!(input && input.hostCanWrite)) {
      blockers.push("Applying needs an MCP-capable host that can write to your kit.");
    }
    if (input && input.inFlight) {
      blockers.push("An apply is already in progress.");
    }

    return { enabled: blockers.length === 0, blockers: blockers };
  }

  /**
   * Refine reads a component's *current source from the kit*, so it cannot touch a draft that has
   * never been written (the server answers `ERR_COMPONENT_NOT_FOUND`). Rather than simulate a
   * refine client-side, we disable it and say why.
   */
  function canRefine(input) {
    var options = input || {};
    if (!options.hostAvailable) {
      return {
        enabled: false,
        reason: "Refine needs an MCP-capable host. Standalone review stays read-only.",
      };
    }
    if (!options.componentInKit) {
      return {
        enabled: false,
        reason: "Refine edits a component in your UI kit. Apply this draft first, then refine it.",
      };
    }
    if (options.inFlight) {
      return { enabled: false, reason: "A refine is already running." };
    }
    if (!String(options.instruction == null ? "" : options.instruction).trim()) {
      return { enabled: false, reason: "Describe the change you want." };
    }
    return { enabled: true, reason: "" };
  }

  /** Scope the write plan to exactly this draft's paths — nothing wider. */
  /**
   * Paths the diff marks as removed (`+++ /dev/null`). `refine` drops them from `files`, so without
   * this an Apply reports success while the stale file survives on disk.
   */
  function deletedPathsFromDiff(diff) {
    if (typeof diff !== "string") return [];
    var lines = diff.split("\n");
    var out = [];
    var from = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.slice(0, 4) === "--- ") {
        from = line.slice(4).trim();
        if (from.slice(0, 2) === "a/") from = from.slice(2);
      } else if (line.slice(0, 4) === "+++ ") {
        var to = line.slice(4).trim();
        if (to === "/dev/null" && from && from !== "/dev/null" && out.indexOf(from) === -1) {
          out.push(from);
        }
        from = null;
      }
    }
    return out;
  }

  /**
   * Bytes this entry occupies on disk. Binary files arrive base64-encoded, so measuring the TEXT
   * overstates the write by ~4/3. Mirrors `byteLengthOf` in the server's `write_files`.
   */
  function entryByteLength(entry) {
    var data = (entry && entry.content) || "";
    if (!entry || entry.encoding !== "base64") return utf8ByteLength(data);
    var padding = data.slice(-2) === "==" ? 2 : data.slice(-1) === "=" ? 1 : 0;
    // Malformed base64 ("=") otherwise yields a NEGATIVE count that renders as "-1 bytes".
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
  }

  function buildPlanArgs(draft, kitId) {
    var result = (draft && draft.result) || {};
    var files = result.files || [];
    var writes = files.map(function (file) {
      return file.path;
    });
    var args = { kitId: kitId, writes: writes };
    // Copilot (round 2) — AC7/AC11 require the DELETE paths too. A path the draft also rewrites is
    // not a deletion, so it never enters `deletes`.
    // Copilot (round 4) — the plan IS the authorisation boundary, so it never names a path outside
    // this component's folder even though the checklist above already blocks such a draft.
    var prefix = componentPrefix(result);
    var deletes = deletedPathsFromDiff(result.diff).filter(function (path) {
      return writes.indexOf(path) === -1 && isInsidePrefix(path, prefix);
    });
    if (deletes.length) args.deletes = deletes;
    return args;
  }

  /**
   * Map conjure/refine file entries onto `write_files`' input. The server accepts exactly one of
   * `data` or `localPath`; the viewer only ever holds in-memory content, so `localPath` is never
   * emitted.
   */
  function buildWriteFilesArgs(planId, draft) {
    var files = (draft && draft.result && draft.result.files) || [];
    return {
      planId: planId,
      files: files.map(function (file) {
        return {
          path: file.path,
          data: file.content,
          mimeType: file.mimeType,
          encoding: file.encoding,
        };
      }),
    };
  }

  /*
   * Deterministic tweaks (AC8) are capability-detected, not assumed: a control
   * only appears when the component actually declares a matching numeric
   * custom property. The allowlist keeps the tweak to values that cannot
   * smuggle a URL or an expression into the card.
   */
  var DETERMINISTIC_CONTROL_SPECS = [
    { pattern: /(?:^|-)radius(?:-|$)/i, label: "Corner radius", min: 0, max: 64, step: 1 },
    {
      pattern: /(?:^|-)(?:padding|gap|spacing|inset)(?:-|$)/i,
      label: "Spacing",
      min: 0,
      max: 96,
      step: 1,
    },
    { pattern: /(?:^|-)font-size(?:-|$)/i, label: "Font size", min: 8, max: 72, step: 1 },
    { pattern: /(?:^|-)border-width(?:-|$)/i, label: "Border width", min: 0, max: 16, step: 1 },
  ];
  var CUSTOM_PROPERTY_DECLARATION =
    /(--[a-z0-9-]+)\s*:\s*(-?\d+(?:\.\d+)?)(px|rem|em)\s*(?=[;}])/gi;

  function detectDeterministicControls(files) {
    var controls = [];
    if (!Array.isArray(files)) return controls;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file || typeof file.content !== "string") continue;
      CUSTOM_PROPERTY_DECLARATION.lastIndex = 0;
      var match;
      while ((match = CUSTOM_PROPERTY_DECLARATION.exec(file.content)) !== null) {
        var property = match[1];
        var spec = null;
        for (var s = 0; s < DETERMINISTIC_CONTROL_SPECS.length; s++) {
          if (DETERMINISTIC_CONTROL_SPECS[s].pattern.test(property.slice(2))) {
            spec = DETERMINISTIC_CONTROL_SPECS[s];
            break;
          }
        }
        if (!spec) continue;
        controls.push({
          // Occurrence-unique: a property declared twice in one file would share an id, so the
          // slider and `.replace` could target different declarations.
          id: i + ":" + match.index + ":" + property,
          fileIndex: i,
          offset: match.index,
          property: property,
          label: spec.label,
          value: Number(match[2]),
          unit: match[3],
          min: spec.min,
          max: spec.max,
          step: spec.step,
          declaration: match[0],
        });
      }
    }
    return controls;
  }

  /**
   * Apply a tweak by rewriting only the declared value, returning a fresh result. Drafts are
   * immutable, so the caller records the outcome as a new draft — which, per AC9, drops any
   * approval.
   */
  function applyDeterministicTweak(result, controlId, value) {
    if (!result || !Array.isArray(result.files)) return null;
    var controls = detectDeterministicControls(result.files);
    var control = null;
    for (var i = 0; i < controls.length; i++) {
      if (controls[i].id === controlId) {
        control = controls[i];
        break;
      }
    }
    if (!control) return null;
    var numeric = Number(value);
    if (!isFinite(numeric) || numeric < control.min || numeric > control.max) return null;

    var replacement = control.property + ":" + numeric + control.unit;
    var files = result.files.map(function (file, index) {
      if (index !== control.fileIndex) return file;
      return {
        path: file.path,
        // Slice-replace at the recorded offset, never a string `.replace` — that rewrites the first
        // textual match, which is a different declaration whenever the property appears more than
        // once.
        content:
          file.content.slice(0, control.offset) +
          replacement +
          file.content.slice(control.offset + control.declaration.length),
        mimeType: file.mimeType,
        encoding: file.encoding,
      };
    });
    var next = {};
    for (var key in result) {
      if (Object.prototype.hasOwnProperty.call(result, key)) next[key] = result[key];
    }
    next.files = files;
    // The broker published the PARENT's bytes; a tweak never reaches it. See architecture.md.
    next.previewUrl = undefined;
    // Copilot #5 (PR #250) — AC8 promises a RECOMPUTED diff. Inheriting `result.diff` shows nothing
    // (parent was a generation) or the previous edit's stale counts (parent was a refine). Both
    // misreport the write.
    next.diff = buildUnifiedDiff(result.files, files);
    return next;
  }

  /**
   * A real unified diff between two file lists, used for locally-derived drafts (deterministic
   * tweaks) where no server diff exists. Line-based with a common prefix/suffix trim, which is
   * exact for the single- declaration edits `applyDeterministicTweak` performs and never invents
   * changes it cannot see.
   */
  function buildUnifiedDiff(prevFiles, nextFiles) {
    var previous = Object.create(null);
    for (var i = 0; i < (prevFiles || []).length; i++) {
      if (prevFiles[i]) previous[prevFiles[i].path] = prevFiles[i].content;
    }
    var out = [];
    for (var j = 0; j < (nextFiles || []).length; j++) {
      var file = nextFiles[j];
      if (!file) continue;
      var before = previous[file.path];
      if (typeof before !== "string" || before === file.content) continue;
      var a = before.split("\n");
      var b = String(file.content).split("\n");
      var head = 0;
      while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
      var tail = 0;
      while (
        tail < a.length - head &&
        tail < b.length - head &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]
      ) {
        tail += 1;
      }
      var removed = a.slice(head, a.length - tail);
      var added = b.slice(head, b.length - tail);
      out.push("diff --git a/" + file.path + " b/" + file.path);
      out.push("--- a/" + file.path);
      out.push("+++ b/" + file.path);
      out.push(
        "@@ -" + (head + 1) + "," + removed.length + " +" + (head + 1) + "," + added.length + " @@",
      );
      for (var r = 0; r < removed.length; r++) out.push("-" + removed[r]);
      for (var d = 0; d < added.length; d++) out.push("+" + added[d]);
    }
    return out.join("\n");
  }

  /**
   * UTF-8 byte length, computed without `TextEncoder` so the embedded tier never depends on a
   * global the host might not expose. Used to state the exact byte scope of a write before consent
   * is asked for (AC11).
   */
  function utf8ByteLength(value) {
    var text = typeof value === "string" ? value : "";
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          bytes += 4;
          i += 1;
          continue;
        }
        bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  function isPlanResult(value) {
    return Boolean(isPlainObject(value) && typeof value.planId === "string" && value.planId);
  }

  function isWriteFilesResult(value) {
    return Boolean(
      isPlainObject(value) &&
      Array.isArray(value.writtenPaths) &&
      value.writtenPaths.every(function (path) {
        return typeof path === "string";
      }),
    );
  }

  /**
   * Render diff statistics. Every value comes from `parseUnifiedDiff`, and every path is written as
   * text — a diff is host-supplied, untrusted data.
   */
  function renderDiffFiles(doc, target, stats) {
    if (!target) return;
    target.replaceChildren();
    var files = (stats && stats.files) || [];
    for (var i = 0; i < files.length; i++) {
      var item = doc.createElement("li");
      item.className = "review-diff__file";
      item.textContent = files[i];
      target.append(item);
    }
  }

  function renderDiffStats(doc, target, stats) {
    if (!target) return;
    target.replaceChildren();
    var additions = doc.createElement("span");
    additions.className = "diff-stat diff-stat--add";
    additions.textContent = "+" + ((stats && stats.additions) || 0);
    var deletions = doc.createElement("span");
    deletions.className = "diff-stat diff-stat--del";
    deletions.textContent = "-" + ((stats && stats.deletions) || 0);
    target.append(additions, deletions);
  }

  /** Blockers are plain sentences; render them as data, never as markup. */
  function renderBlockers(doc, target, blockers) {
    if (!target) return;
    target.replaceChildren();
    var list = blockers || [];
    for (var i = 0; i < list.length; i++) {
      var item = doc.createElement("li");
      item.className = "apply-blockers__item";
      item.textContent = list[i];
      target.append(item);
    }
    target.hidden = list.length === 0;
  }

  var CHECK_ICONS = { pass: "✓", fail: "✕", pending: "…" };
  // Copilot (round 7) — the glyph is aria-hidden, so an automated row announced its name and
  // nothing else. Manual rows already expose state through their checkbox, so only the automated
  // branch gets this; adding it to both would make AT say the state twice.
  var CHECK_STATE_TEXT = { pass: "passed", fail: "failed", pending: "pending" };

  function renderChecklist(doc, target, checklist, onToggle) {
    if (!target) return;
    target.replaceChildren();
    var entries = checklist || [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var item = doc.createElement("li");
      item.className =
        "check-item check-item--" +
        entry.state +
        (entry.kind === "manual" ? " check-item--manual" : "");
      item.setAttribute("data-check-id", entry.id);
      item.setAttribute("data-check-kind", entry.kind);

      var icon = doc.createElement("span");
      icon.className = "check-item__icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent =
        entry.kind === "manual" && entry.state !== "pass" ? "○" : CHECK_ICONS[entry.state];

      if (entry.kind === "manual" && typeof onToggle === "function") {
        var label = doc.createElement("label");
        label.className = "check-item__label";
        var box = doc.createElement("input");
        box.type = "checkbox";
        box.checked = entry.state === "pass";
        box.setAttribute("data-check-toggle", entry.id);
        box.addEventListener("change", createCheckToggleHandler(onToggle, entry.id, box));
        var text = doc.createElement("span");
        text.textContent = entry.label;
        label.append(box, text);
        item.append(icon, label);
      } else {
        var span = doc.createElement("span");
        span.className = "check-item__label";
        span.textContent = entry.label;
        var state = doc.createElement("span");
        state.className = "visually-hidden";
        state.textContent = " — " + (CHECK_STATE_TEXT[entry.state] || entry.state);
        span.append(state);
        item.append(icon, span);
      }

      if (entry.detail) {
        var detail = doc.createElement("span");
        detail.className = "check-item__detail";
        detail.textContent = entry.detail;
        item.append(detail);
      }
      target.append(item);
    }
  }

  function createCheckToggleHandler(onToggle, id, box) {
    return function () {
      onToggle(id, box.checked);
    };
  }

  /**
   * M7-03 (#235) — the review workspace controller. Owns every DOM mutation in `#review-view` and
   * delegates every decision to the pure helpers above, so the gating rules stay testable without a
   * DOM. Nothing here writes to the kit: `runApply` is the only path to disk, and it is reachable
   * only through an explicit confirmation dialog behind a fully-satisfied gate.
   *
   * @param {Document} doc
   * @param {{
   *   getBridge: () => object|null|undefined,
   * announce?: (message: string) => void, }} opts
   */
  function initReviewController(doc, opts) {
    var el = {
      view: doc.getElementById("review-view"),
      layout: doc.getElementById("review-layout"),
      segmented: doc.getElementById("review-segmented"),
      log: doc.getElementById("review-conversation-log"),
      stageLabel: doc.getElementById("review-stage-label"),
      empty: doc.getElementById("review-empty"),
      preview: doc.getElementById("review-preview"),
      previewNote: doc.getElementById("review-preview-note"),
      draft: doc.getElementById("draft-review"),
      draftLabel: doc.getElementById("draft-label"),
      persistenceNote: doc.getElementById("draft-persistence-note"),
      draftName: doc.getElementById("draft-name"),
      summary: doc.getElementById("draft-summary"),
      switcher: doc.getElementById("review-draft-switcher"),
      diff: doc.getElementById("review-diff"),
      diffStats: doc.getElementById("review-diff-stats"),
      diffFiles: doc.getElementById("review-diff-files"),
      checklist: doc.getElementById("review-checklist"),
      controls: doc.getElementById("review-controls"),
      refineInput: doc.getElementById("refine-input"),
      refineSubmit: doc.getElementById("refine-submit"),
      refineStatus: doc.getElementById("refine-status"),
      approve: doc.getElementById("decision-approve"),
      requestChanges: doc.getElementById("decision-request-changes"),
      apply: doc.getElementById("apply-button"),
      blockers: doc.getElementById("apply-blockers"),
      status: doc.getElementById("review-status"),
      live: doc.getElementById("review-live"),
      dialog: doc.getElementById("apply-confirm"),
      dialogHeading: doc.getElementById("apply-confirm-heading"),
      dialogFiles: doc.getElementById("apply-confirm-files"),
      dialogDetail: doc.getElementById("apply-confirm-detail"),
      dialogCancel: doc.getElementById("apply-confirm-cancel"),
      dialogAccept: doc.getElementById("apply-confirm-accept"),
      railToggle: doc.getElementById("review-rail-toggle"),
      rail: doc.getElementById("review-conversation"),
      panel: doc.getElementById("review-panel"),
      segments: doc.querySelectorAll("[data-review-pane]"),
    };
    if (!el.view || !el.checklist || !el.apply) return null;

    var store = createReviewStore();
    // Per-draft presentation state, keyed by draft id: the kit each draft belongs to, whether
    // refine can target it (it must exist in the kit) and its rendered preview outcome.
    var meta = Object.create(null);
    var inFlight = false;
    // Monotonic ticket claimed before every await so a superseded async reply can be discarded
    // instead of landing on a draft the user has moved past.
    var generation = 0;
    var dialogReturnFocus = null;

    function currentMeta() {
      var draft = store.current();
      return (draft && meta[draft.id]) || null;
    }

    function announce(message) {
      if (el.live) el.live.textContent = message;
      if (opts && typeof opts.announce === "function") opts.announce(message);
    }

    function log(role, text) {
      if (!el.log || !text) return;
      var item = doc.createElement("li");
      item.className = "chat-bubble chat-bubble--" + role;
      var body = doc.createElement("p");
      body.className = "chat-bubble__body";
      body.textContent = text;
      var stamp = doc.createElement("time");
      stamp.className = "chat-timestamp";
      var now = new Date();
      stamp.dateTime = now.toISOString();
      stamp.textContent = now.toLocaleTimeString();
      item.append(body, stamp);
      el.log.append(item);
    }

    /** Render the draft into a sandboxed, same-origin-less preview frame. */
    function renderPreview(draft) {
      if (!el.preview) return;
      el.preview.replaceChildren();
      var file = resolvePreviewFile(draft.result);
      if (!file) {
        store.setRenderState("fail");
        el.preview.hidden = true;
        return;
      }
      store.setRenderState("pending");
      // A `load`/`error` from a REPLACED frame must not stamp render state onto whatever draft is
      // current by the time it fires.
      var owner = draft.id;
      var frame = doc.createElement("iframe");
      frame.className = "review-preview__frame";
      // No `allow-same-origin`: an untrusted draft can never reach the viewer's origin, storage or
      // the host bridge.
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("title", presentName(draft) + " preview");
      frame.setAttribute("loading", "eager");
      frame.addEventListener("load", function () {
        var current = store.current();
        if (!current || current.id !== owner) return;
        store.setRenderState("pass");
        render();
      });
      frame.addEventListener("error", function () {
        var current = store.current();
        if (!current || current.id !== owner) return;
        store.setRenderState("fail");
        render();
      });
      // FETCH a broker-published draft so it gets the broker's own response-header CSP; guard in
      // barrier position. See architecture.md, "Broker-served draft previews (#257)".
      var candidate = draft.result ? draft.result.previewUrl : null;
      var served = isDraftPreviewSrc(candidate) ? candidate : null;
      if (served) frame.src = served;
      else frame.srcdoc = file.content;
      el.preview.append(frame);
      el.preview.hidden = false;
      // Copilot (round 7) — a `srcdoc` frame INHERITS the embedding document's CSP (no local
      // scheme escapes it). Where the host pins `style-src` to build-time sha256 hashes, an
      // unwritten draft's inline <style> cannot match one that was minted before it existed, so a
      // green render row would over-promise. Detect the policy itself rather than guess the tier.
      // A served draft carries its own policy, so the warning would be untrue.
      if (el.previewNote) el.previewNote.hidden = Boolean(served) || !inheritsStyleHashPolicy();
    }

    function inheritsStyleHashPolicy() {
      var meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
      var content = meta && meta.getAttribute("content");
      return typeof content === "string" && /style-src[^;]*sha256-/i.test(content);
    }

    function renderSummary(draft) {
      if (!el.summary) return;
      el.summary.replaceChildren();
      var info = meta[draft.id] || {};
      var rows = [
        ["UI kit", info.kitLabel || info.kitId || "Unknown"],
        ["Group", draft.result.group],
        ["Origin", draft.source === "browse" ? "Browse" : "Generate"],
        ["Proposed files", String(draft.result.files.length)],
      ];
      if (info.model) rows.push(["Model", info.model]);
      // Copilot (round 7) — S1 asks for provenance. `usage` is already validated on the way in;
      // Browse baselines carry none, so the row is conditional rather than a bare "0".
      var usage = draft.result.usage;
      if (usage)
        rows.push([
          "Tokens",
          usage.promptTokens +
            " prompt + " +
            usage.completionTokens +
            " completion = " +
            usage.totalTokens +
            " total",
        ]);
      for (var i = 0; i < rows.length; i++) {
        var dt = doc.createElement("dt");
        dt.textContent = rows[i][0];
        var dd = doc.createElement("dd");
        dd.textContent = rows[i][1];
        el.summary.append(dt, dd);
      }
    }

    function renderSwitcher() {
      if (!el.switcher) return;
      var drafts = store.state().drafts;
      el.switcher.replaceChildren();
      el.switcher.hidden = drafts.length < 2;
      if (drafts.length < 2) return;
      var current = store.current();
      for (var i = 0; i < drafts.length; i++) {
        var button = doc.createElement("button");
        button.type = "button";
        button.className = "review-draft-switcher__option";
        button.textContent = drafts[i].label;
        button.setAttribute(
          "aria-pressed",
          String(Boolean(current && current.id === drafts[i].id)),
        );
        button.addEventListener("click", createSelectHandler(drafts[i].number));
        el.switcher.append(button);
      }
    }

    function createSelectHandler(number) {
      return function () {
        var draft = store.select(number);
        if (!draft) return;
        // Claim the generation: an in-flight Refine was issued against the draft we just left, and
        // without this its late reply still satisfies `ticket === generation` and lands on the
        // wrong draft.
        generation += 1;
        renderPreview(draft);
        render();
        announce("Reviewing " + draft.label + ".");
      };
    }

    function renderControls(draft) {
      if (!el.controls) return;
      el.controls.replaceChildren();
      var controls = detectDeterministicControls(draft.result.files);
      el.controls.hidden = controls.length === 0;
      if (controls.length === 0) return;
      var heading = doc.createElement("p");
      heading.className = "review-controls__heading";
      heading.textContent = "Deterministic tweaks";
      el.controls.append(heading);
      for (var i = 0; i < controls.length; i++) {
        var control = controls[i];
        var row = doc.createElement("div");
        row.className = "review-controls__row";
        var label = doc.createElement("label");
        var inputId = "control-" + i;
        label.setAttribute("for", inputId);
        label.textContent = control.label;
        var input = doc.createElement("input");
        input.type = "range";
        input.id = inputId;
        input.min = String(control.min);
        input.max = String(control.max);
        input.step = String(control.step);
        input.value = String(control.value);
        // Frozen during flight: a slider dragged mid-apply spawns a new draft and moves `current`
        // off the draft actually being written.
        input.disabled = inFlight;
        input.addEventListener("change", createControlHandler(control.id, input));
        row.append(label, input);
        el.controls.append(row);
      }
    }

    function createControlHandler(controlId, input) {
      return function () {
        var draft = store.current();
        if (!draft) return;
        var next = applyDeterministicTweak(draft.result, controlId, Number(input.value));
        if (!next) return;
        var info = meta[draft.id] || {};
        // id is `fileIndex:offset:--property`.
        var property = controlId.split(":").slice(2).join(":");
        // A tweaked draft is new bytes NOT in the kit, even if its parent was applied. Inheriting
        // `componentInKit` would re-enable Refine, which reads the kit's older source and silently
        // discards the tweak.
        addDraft(next, derivedInfo(info), "Adjusted " + property + ".");
      };
    }

    /**
     * Metadata for a draft DERIVED from another (a refine reply or a deterministic tweak). Both
     * produce PROPOSED bytes that are not on disk, so `componentInKit` must be cleared however the
     * parent was flagged — otherwise Refine stays unlocked and its next call reloads the older
     * on-disk source, silently discarding this draft.
     */
    function derivedInfo(info) {
      var source = info || {};
      return {
        kitId: source.kitId,
        kitLabel: source.kitLabel,
        // Copilot (round 7) — a refine of a kit component is still that component. Dropping
        // `source` relabelled a Browse-opened card "Generate" the moment it was refined.
        source: source.source,
        model: source.model,
        displayName: source.displayName || "",
        componentInKit: false,
      };
    }

    /**
     * Copilot (round 4) — `buildRefineContext` carries the UI kit's own user-facing name, which
     * need not equal the directory the component lives in. Everything the reviewer READS uses it;
     * every tool argument keeps `result.componentName`, which is what the server addresses.
     */
    function presentName(draft) {
      var info = meta[draft.id];
      return (info && info.displayName) || draft.result.componentName;
    }

    function onAcknowledge(id, value) {
      store.acknowledge(id, value);
      render();
      announce(value ? "Checked off " + id + "." : "Cleared " + id + ".");
    }

    function render() {
      var draft = store.current();
      var state = store.state();
      var bridge = opts.getBridge();
      var hostAvailable = Boolean(bridge);

      if (!draft) {
        if (el.empty) el.empty.hidden = false;
        if (el.draft) el.draft.hidden = true;
        if (el.preview) el.preview.hidden = true;
        if (el.stageLabel) el.stageLabel.textContent = "Nothing to preview yet";
        renderBlockers(doc, el.blockers, ["No draft is loaded yet."]);
        el.apply.disabled = true;
        if (el.approve) el.approve.disabled = true;
        if (el.requestChanges) el.requestChanges.disabled = true;
        if (el.refineSubmit) el.refineSubmit.disabled = true;
        if (el.checklist) el.checklist.replaceChildren();
        return;
      }

      var info = meta[draft.id] || {};
      if (el.empty) el.empty.hidden = true;
      if (el.draft) el.draft.hidden = false;
      if (el.stageLabel) {
        el.stageLabel.textContent = presentName(draft) + " — " + draft.label;
      }
      if (el.draftLabel) el.draftLabel.textContent = draft.label;
      if (el.persistenceNote) {
        // Copilot (round 2) — a static "nothing has been written" survived `markApplied`, so the
        // panel claimed both at once.
        el.persistenceNote.textContent =
          state.appliedDraftId === draft.id
            ? "Written to your kit. Later drafts stay in this session until you apply them."
            : "This draft is held only in this viewer session. Nothing has been written to your kit.";
      }
      if (el.draftName) el.draftName.textContent = presentName(draft);
      renderSummary(draft);
      renderSwitcher();

      var stats = parseUnifiedDiff(draft.result.diff);
      var hasDiff = stats.files.length > 0 || stats.additions > 0 || stats.deletions > 0;
      if (el.diff) el.diff.hidden = !hasDiff;
      renderDiffStats(doc, el.diffStats, stats);
      renderDiffFiles(doc, el.diffFiles, stats);

      var checklist = computeChecklist({
        result: draft.result,
        renderState: state.renderState,
        manualAcks: state.manualAcks,
      });
      renderChecklist(doc, el.checklist, checklist, onAcknowledge);
      renderControls(draft);

      var gate = computeApplyGate({
        state: state,
        checklist: checklist,
        hostCanWrite: hostAvailable,
        inFlight: inFlight,
      });
      el.apply.disabled = !gate.enabled;
      renderBlockers(doc, el.blockers, gate.blockers);

      var approved = store.isApproved();
      if (el.approve) {
        el.approve.disabled = inFlight || approved;
        el.approve.setAttribute("aria-pressed", String(approved));
      }
      if (el.requestChanges) {
        el.requestChanges.disabled = inFlight || state.decision === "changes-requested";
      }

      var refine = canRefine({
        hostAvailable: hostAvailable,
        componentInKit: Boolean(info.componentInKit),
        inFlight: inFlight,
        instruction: el.refineInput ? el.refineInput.value : "",
      });
      if (el.refineSubmit) el.refineSubmit.disabled = !refine.enabled;
      if (el.refineStatus && !inFlight) {
        el.refineStatus.textContent = refine.enabled ? "" : refine.reason || "";
      }
    }

    /**
     * Record a draft (from Generate, from Refine, or from a deterministic tweak) and make it the
     * one under review.
     */
    function addDraft(result, info, note) {
      // Copilot (round 2) — a new draft moves the question on. Without this bump an older refine's
      // reply still satisfies `ticket === generation` and lands on top of the draft the user is now
      // looking at.
      generation += 1;
      var draft = store.addDraft(result, info.source);
      meta[draft.id] = {
        kitId: info.kitId || "",
        kitLabel: info.kitLabel || "",
        model: info.model || "",
        displayName: info.displayName || "",
        componentInKit: Boolean(info.componentInKit),
        source: draft.source,
      };
      log("genie", note || "Drafted " + presentName(draft) + " — " + draft.label + ".");
      renderPreview(draft);
      render();
      announce(draft.label + " ready for review. Nothing has been written to your kit.");
      return draft;
    }

    async function submitRefine() {
      var draft = store.current();
      var info = currentMeta();
      var bridge = opts.getBridge();
      if (!draft || !info || !bridge || inFlight) return;
      var instruction = el.refineInput ? el.refineInput.value.trim() : "";
      var gate = canRefine({
        hostAvailable: true,
        componentInKit: info.componentInKit,
        inFlight: false,
        instruction: instruction,
      });
      if (!gate.enabled) return;

      // Claim the generation BEFORE the await: sliders, switcher and nav all stay live in flight,
      // so a superseded reply must never land.
      generation += 1;
      var ticket = generation;
      inFlight = true;
      render();
      if (el.refineStatus) el.refineStatus.textContent = "Refining…";
      log("user", instruction);
      var outcome;
      try {
        outcome = await runRefine({
          bridge: bridge,
          kitId: info.kitId,
          componentName: draft.result.componentName,
          instruction: instruction,
          model: info.model,
        });
      } finally {
        // Copilot #7 (PR #250) — `inFlight` is the LOCK; `ticket` only decides if the RESULT is
        // wanted. Conflating them strands the lock forever when the user switches drafts
        // mid-flight. Release; discard below.
        inFlight = false;
      }
      // Copilot (round 2) — the draft switch that invalidated this reply repainted while `inFlight`
      // was still true, so every control rendered disabled. Returning without a repaint strands
      // them there.
      if (ticket !== generation) {
        render();
        return;
      }
      if (!outcome.ok) {
        var failure = outcome.message || "Refine failed.";
        announce(failure);
        // Copilot #3 (PR #250) — `render()` blanks `#refine-status`, so the reason must be written
        // AFTER it or AC7's message never survives.
        render();
        if (el.refineStatus) el.refineStatus.textContent = failure;
        return;
      }
      if (el.refineStatus) el.refineStatus.textContent = "";
      if (el.refineInput) el.refineInput.value = "";
      // Copilot #4 (PR #250) — `refine` persists nothing, so a refined draft is NOT in the kit;
      // marking it so re-opens Refine, whose next call reloads the older on-disk bytes and loses
      // this work.
      addDraft(outcome.result, derivedInfo(info), "Refined: " + instruction);
    }

    function openApplyConfirm() {
      var draft = store.current();
      if (!draft || !el.dialog) return;
      // Copilot #8 (PR #250) — AC11 wants informed consent: name the kit, the component and the
      // byte scope, read off the draft actually being applied.
      var confirmInfo = meta[draft.id] || {};
      var totalBytes = 0;
      if (el.dialogFiles) {
        el.dialogFiles.replaceChildren();
        for (var i = 0; i < draft.result.files.length; i++) {
          var entry = draft.result.files[i];
          var size = entryByteLength(entry);
          totalBytes += size;
          var item = doc.createElement("li");
          var path = doc.createElement("code");
          path.textContent = entry.path;
          var scope = doc.createElement("span");
          scope.className = "review-dialog__bytes";
          scope.textContent = size + (size === 1 ? " byte" : " bytes");
          item.append(path, scope);
          el.dialogFiles.append(item);
        }
      }
      var pendingDeletes = deletedPathsFromDiff(draft.result.diff).filter(function (path) {
        return !draft.result.files.some(function (file) {
          return file.path === path;
        });
      });
      if (el.dialogFiles) {
        for (var d = 0; d < pendingDeletes.length; d++) {
          var del = doc.createElement("li");
          var delPath = doc.createElement("code");
          delPath.textContent = pendingDeletes[d];
          var delTag = doc.createElement("span");
          delTag.className = "review-dialog__bytes";
          delTag.textContent = "delete";
          del.append(delPath, delTag);
          el.dialogFiles.append(del);
        }
      }
      if (el.dialogDetail) {
        var count = draft.result.files.length;
        el.dialogDetail.textContent =
          "Writing " +
          presentName(draft) +
          " into " +
          (confirmInfo.kitLabel || confirmInfo.kitId || "your UI kit") +
          " — " +
          count +
          (count === 1 ? " file, " : " files, ") +
          totalBytes +
          (totalBytes === 1 ? " byte" : " bytes") +
          " in total." +
          (pendingDeletes.length
            ? " " +
              pendingDeletes.length +
              (pendingDeletes.length === 1 ? " file is deleted: " : " files are deleted: ") +
              pendingDeletes.join(", ") +
              "."
            : "") +
          (confirmInfo.bytesWritten
            ? // Copilot (round 6) — a stuck delete keeps the draft retryable, so this dialog can
              // reopen AFTER `write_files` succeeded. Claiming "first time" there is simply false.
              " These files were already written once; applying again rewrites them and retries" +
              " the removal."
            : " This is the first time anything leaves this viewer session.");
      }
      dialogReturnFocus = doc.activeElement;
      el.dialog.hidden = false;
      // `aria-modal="true"` promises focus cannot leave. `inert` removes the background from the
      // tab order AND the a11y tree; keydown is fallback.
      setBackgroundInert(true);
      if (el.dialogHeading) el.dialogHeading.focus();
    }

    /** Take the review workspace out of the tab order while the dialog is up. */
    function setBackgroundInert(on) {
      var nodes = [el.layout, el.segmented, doc.querySelector(".app-header")];
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i]) continue;
        if (on) {
          nodes[i].setAttribute("inert", "");
          nodes[i].setAttribute("aria-hidden", "true");
        } else {
          nodes[i].removeAttribute("inert");
          nodes[i].removeAttribute("aria-hidden");
        }
      }
    }

    /** Cycle Tab within the dialog so focus can never land behind the overlay. */
    function trapDialogFocus(event) {
      if (event.key !== "Tab" || !el.dialog || el.dialog.hidden) return;
      var focusable = [el.dialogCancel, el.dialogAccept].filter(function (node) {
        return node && !node.disabled;
      });
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      var active = doc.activeElement;
      if (event.shiftKey && (active === first || active === el.dialogHeading)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (focusable.indexOf(active) === -1 && active !== el.dialogHeading) {
        event.preventDefault();
        first.focus();
      }
    }

    // `viewIsClosing` must be an explicit `true`: this is also used directly as a click listener,
    // so the first argument is otherwise an Event.
    function closeApplyConfirm(viewIsClosing) {
      if (!el.dialog || el.dialog.hidden) return false;
      el.dialog.hidden = true;
      setBackgroundInert(false);
      var active = doc.activeElement;
      if (viewIsClosing === true) {
        // The return target lives inside the view that is being hidden, so restoring it would
        // strand focus in a hidden subtree. Browsers blur out of a subtree that becomes hidden;
        // do it explicitly so jsdom and assistive tech agree.
        if (active && el.dialog.contains(active) && typeof active.blur === "function") {
          active.blur();
        }
      } else if (dialogReturnFocus && typeof dialogReturnFocus.focus === "function") {
        dialogReturnFocus.focus();
      }
      dialogReturnFocus = null;
      return true;
    }

    async function confirmApply() {
      var draft = store.current();
      var info = currentMeta();
      var bridge = opts.getBridge();
      closeApplyConfirm();
      if (!draft || !info || !bridge || inFlight) return;

      // Bumping `generation` invalidates any in-flight REFINE — but an apply keeps no ticket: its
      // side effect reaches the kit, so its outcome must always be processed or the draft is left
      // unstamped.
      generation += 1;
      inFlight = true;
      render();
      if (el.status) el.status.textContent = "Writing files to your kit…";
      var outcome;
      try {
        outcome = await runApply({
          bridge: bridge,
          kitId: info.kitId,
          draft: draft,
          approved: store.isApproved(),
        });
      } finally {
        // Copilot #7 (PR #250) — see `submitRefine`. This one is stricter still: an apply's side
        // effect has ALREADY reached the kit, so its lock can never be treated as discardable.
        inFlight = false;
      }

      // Copilot (round 7) — a PARTIAL write returns ok:false with a non-empty `writtenPaths`.
      // Recording this below the early return let the retry dialog claim, falsely, that nothing
      // had ever left the session. Same class as the stuck-delete bug in round 6.
      if (outcome.writtenPaths.length && meta[draft.id]) meta[draft.id].bytesWritten = true;
      if (!outcome.ok) {
        if (el.status) el.status.textContent = outcome.message || "Apply failed.";
        announce(outcome.message || "Apply failed. Nothing was written.");
        render();
        return;
      }

      // Stamp the draft that was ACTUALLY written, not `current()` — a tweak slider dragged
      // mid-flight moves `current` to a new, unwritten draft.
      //
      // Copilot round 3 #1 — and ONLY when the apply finished. Stamping a draft with stranded
      // deletes raises the "already applied" blocker, removing the one control that could finish
      // the job; `write_files` is idempotent, so a retry is safe. See architecture.md.
      var stuckDeletes = outcome.stuckDeletes || [];
      if (!stuckDeletes.length) store.markApplied(outcome.writtenPaths, draft.id);
      meta[draft.id].componentInKit = true;

      // AC13 — report success only once the refresh lands. AC14 — a failed refresh is a STALE VIEW,
      // not a failed apply: the bytes are on disk.
      var refreshFailed = false;
      if (typeof opts.onApplied === "function") {
        if (el.status) el.status.textContent = "Refreshing your kit…";
        try {
          await opts.onApplied({
            kitId: info.kitId,
            group: draft.result.group,
            componentName: draft.result.componentName,
            writtenPaths: outcome.writtenPaths,
          });
        } catch {
          // The bytes are already on disk; only the view is stale. The reason is surfaced as a
          // stale-view note, not as a failed Apply.
          refreshFailed = true;
        }
      }

      var written = outcome.writtenPaths.length;
      var message = "Applied " + presentName(draft) + " — " + written + " file";
      message += written === 1 ? " written." : "s written.";
      // Copilot #9 (PR #250) — the bytes ARE on disk (never written twice), but an apply whose
      // post-write scan did not complete, or came back dirty, is not a VERIFIED success.
      if (outcome.deleteWarning) {
        // The writes DID land. Only the removal did not, so the kit is stale, not unwritten —
        // saying otherwise pushes the user to write twice.
        message += " Your kit is stale: " + outcome.deleteWarning + ".";
        if (stuckDeletes.length) message += " Apply again to retry the removal.";
      }
      if (outcome.validation === null) {
        message += " The post-write check could not run, so this write is unverified.";
      } else if (outcome.validation && outcome.validation.bad > 0) {
        message +=
          " The post-write check flagged " +
          outcome.validation.bad +
          " component(s), so this write is unverified.";
      }
      if (refreshFailed) {
        message += " The kit view could not be refreshed — reload to see it in Browse.";
      }
      if (el.status) el.status.textContent = message;
      log("genie", message);
      announce(message);
      render();
    }

    function setPane(pane) {
      for (var i = 0; i < el.segments.length; i++) {
        var button = el.segments[i];
        var active = button.getAttribute("data-review-pane") === pane;
        button.setAttribute("aria-selected", String(active));
        // Roving tabindex: a tablist is one Tab stop, arrows move within it.
        button.tabIndex = active ? 0 : -1;
      }
      if (el.view) el.view.setAttribute("data-active-pane", pane);
    }

    function createPaneHandler(button) {
      return function () {
        setPane(button.getAttribute("data-review-pane"));
      };
    }

    function focusPane(index) {
      var count = el.segments.length;
      if (!count) return;
      var next = ((index % count) + count) % count;
      var button = el.segments[next];
      setPane(button.getAttribute("data-review-pane"));
      // Selection follows focus, so the newly-active tab is the one Tab stop and must actually
      // receive focus for the change to be perceivable.
      button.focus();
    }

    function createPaneKeyHandler(index) {
      return function (event) {
        var key = event.key;
        var target;
        if (key === "ArrowRight" || key === "ArrowDown") target = index + 1;
        else if (key === "ArrowLeft" || key === "ArrowUp") target = index - 1;
        else if (key === "Home") target = 0;
        else if (key === "End") target = el.segments.length - 1;
        else return;
        event.preventDefault();
        focusPane(target);
      };
    }

    if (el.refineSubmit) el.refineSubmit.addEventListener("click", submitRefine);
    if (el.refineInput) el.refineInput.addEventListener("input", render);
    if (el.approve) {
      el.approve.addEventListener("click", function () {
        store.approve();
        render();
        announce("Draft approved. Apply to kit is now available.");
      });
    }
    if (el.requestChanges) {
      el.requestChanges.addEventListener("click", function () {
        store.requestChanges();
        render();
        announce("Changes requested. Approval cleared.");
        if (el.refineInput) el.refineInput.focus();
      });
    }
    el.apply.addEventListener("click", openApplyConfirm);
    if (el.dialogCancel) el.dialogCancel.addEventListener("click", closeApplyConfirm);
    if (el.dialogAccept) el.dialogAccept.addEventListener("click", confirmApply);
    if (el.dialog) {
      el.dialog.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          closeApplyConfirm();
          return;
        }
        trapDialogFocus(event);
      });
    }
    if (el.railToggle && el.rail) {
      el.railToggle.addEventListener("click", function () {
        var open = el.railToggle.getAttribute("aria-expanded") === "true";
        el.railToggle.setAttribute("aria-expanded", String(!open));
        el.rail.classList.toggle("review-conversation--open", !open);
      });
    }
    for (var s = 0; s < el.segments.length; s++) {
      el.segments[s].addEventListener("click", createPaneHandler(el.segments[s]));
      // AC19 / Design 6 §14 — the roving tabindex makes this tablist ONE Tab stop, so without
      // arrows the inactive tab is unreachable (WAI-ARIA).
      el.segments[s].addEventListener("keydown", createPaneKeyHandler(s));
    }
    setPane("preview");
    render();

    return {
      addDraft: addDraft,
      // Copilot (round 12) — the shell owns routing, so it is the only thing that can know the
      // review view is about to be hidden out from under an open dialog.
      dismissApplyConfirm: function () {
        return closeApplyConfirm(true);
      },
      logUser: function (text) {
        log("user", text);
      },
      refresh: render,
      state: store.state,
    };
  }

  /**
   * Refine: one tool call, no writes, fail closed on a malformed reply.
   */
  async function runRefine(options) {
    var args = {
      kitId: options.kitId,
      componentName: options.componentName,
      instruction: options.instruction,
    };
    // Copilot #1 (PR #250) — server declares `model: z.string().min(1) .default(DEFAULT_MODEL)`.
    // `""` is not "absent": it fails `.min(1)` and rejects the call, while omitting the key lets
    // the default apply.
    if (typeof options.model === "string" && options.model) args.model = options.model;
    if (options.region) args.region = options.region;
    var reply;
    try {
      reply = await options.bridge.callTool(REFINE_TOOL, args, NO_CLIENT_DEADLINE);
    } catch (error) {
      return {
        ok: false,
        message: safeHostMessage(
          error && error.message,
          "The host could not refine this component.",
        ),
      };
    }
    if (!isRefineResult(reply)) {
      return { ok: false, message: "The host returned a refine result this viewer cannot verify." };
    }
    return { ok: true, result: reply };
  }

  /**
   * The one and only path in the viewer that may write. Order is a contract: `plan` (scoped to this
   * draft's paths) → `write_files` (with that plan) → `validate` (advisory, post-write). A failure
   * before the write leaves the kit untouched; a failure after it is reported honestly rather than
   * retroactively "un-applied".
   */
  async function runApply(options) {
    var draft = options && options.draft;
    if (!draft || !draft.result) {
      return { ok: false, message: "There is no draft to apply.", writtenPaths: [] };
    }
    // Fail closed: only an explicit `true` may reach `plan`/`write_files`. A missing or undefined
    // `approved` is an omission, never consent.
    if (options.approved !== true) {
      return { ok: false, message: "Approve this draft before applying.", writtenPaths: [] };
    }

    var planArgs = buildPlanArgs(draft, options.kitId);
    var planReply;
    try {
      // Copilot (round 6) — `plan` runs BEFORE any side effect, so a client-side timeout is
      // unambiguous: nothing was written. Leaving it unbounded let a silent host wedge `inFlight`
      // forever, and the only escape (reload) drops the draft. Only the write tools below, whose
      // outcome a timeout genuinely cannot determine, stay unbounded.
      planReply = await options.bridge.callTool(PLAN_TOOL, planArgs, DEFAULT_HOST_TOOL_TIMEOUT_MS);
    } catch (error) {
      return {
        ok: false,
        message: safeHostMessage(
          error && error.message,
          "The host could not prepare a write plan. Nothing was written.",
        ),
        writtenPaths: [],
      };
    }
    if (!isPlanResult(planReply)) {
      return {
        ok: false,
        message: "The host returned a write plan this viewer cannot verify. Nothing was written.",
        writtenPaths: [],
      };
    }

    var writeReply;
    try {
      writeReply = await options.bridge.callTool(
        WRITE_FILES_TOOL,
        buildWriteFilesArgs(planReply.planId, draft),
        NO_CLIENT_DEADLINE,
      );
    } catch (error) {
      return {
        ok: false,
        message: safeHostMessage(error && error.message, "The host could not write these files."),
        writtenPaths: [],
      };
    }
    if (!isWriteFilesResult(writeReply)) {
      return {
        ok: false,
        message: "The host returned a write result this viewer cannot verify.",
        writtenPaths: [],
      };
    }

    var expected = planArgs.writes;
    var written = writeReply.writtenPaths;
    var missing = expected.filter(function (path) {
      return written.indexOf(path) === -1;
    });
    if (missing.length) {
      return {
        ok: false,
        message:
          "Partial write: " +
          written.length +
          " of " +
          expected.length +
          " files reached your kit. Re-check the component before applying again.",
        writtenPaths: written,
        missingPaths: missing,
      };
    }

    // Deletes run AFTER the writes, against the same plan, so a rejected delete can never strand
    // the component without its new bytes. A path the server reports in `notFoundPaths` was already
    // gone — not a failure.
    var deletes = planArgs.deletes || [];
    var deleteWarning = null;
    var deletedPaths = [];
    // Copilot round 3 #1 — the stranded paths, not just a warning: only this can keep a
    // partially applied draft retryable.
    var stuckDeletes = [];
    if (deletes.length) {
      try {
        var deleteReply = await options.bridge.callTool(
          DELETE_FILES_TOOL,
          { planId: planReply.planId, paths: deletes },
          NO_CLIENT_DEADLINE,
        );
        var reply = isPlainObject(deleteReply) ? deleteReply : {};
        deletedPaths = Array.isArray(reply.deletedPaths) ? reply.deletedPaths : [];
        var absent = Array.isArray(reply.notFoundPaths) ? reply.notFoundPaths : [];
        stuckDeletes = deletes.filter(function (path) {
          return deletedPaths.indexOf(path) === -1 && absent.indexOf(path) === -1;
        });
        if (stuckDeletes.length) deleteWarning = "could not remove " + stuckDeletes.join(", ");
      } catch (error) {
        // The call itself failed, so NOTHING was removed.
        stuckDeletes = deletes.slice();
        deleteWarning = safeHostMessage(
          error && error.message,
          "could not remove " + deletes.join(", "),
        );
      }
    }

    // Post-write scan is advisory. The bytes are already on disk, so a scan failure must not be
    // reported as a failed apply — that would be a lie that pushes the user toward a redundant
    // second write.
    var validation = null;
    try {
      // Copilot (round 6) — advisory and AFTER the write, so timing it out only costs the scan.
      var validateReply = await options.bridge.callTool(
        VALIDATE_TOOL,
        { kitId: options.kitId },
        DEFAULT_HOST_TOOL_TIMEOUT_MS,
      );
      if (isPlainObject(validateReply)) validation = validateReply;
    } catch {
      validation = null;
    }

    return {
      ok: true,
      writtenPaths: written,
      deletedPaths: deletedPaths,
      stuckDeletes: stuckDeletes,
      deleteWarning: deleteWarning,
      validation: validation,
      planId: planReply.planId,
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
   * Payload of the first `content[]` entry whose text parses to a JSON object.
   *
   * A tool that declares no `outputSchema` is spec-correct in omitting
   * `structuredContent` and returning its payload only as JSON text, which is
   * what kit-wide `validate` and `create_kit` do. Treating those as failures
   * made their results unreadable to the viewer (genie#251).
   *
   * Non-text entries, unparseable text, and JSON primitives are skipped: a
   * number or string is valid JSON but never a tool payload, and resolving one
   * would hand callers a value they immediately destructure fields from.
   *
   * @param {object|undefined} result Raw `tools/call` result from the host.
   * @returns {object|undefined} Parsed payload, or `undefined` when none applies.
   */
  function textResultPayload(result) {
    var content = result && result.content;
    if (!Array.isArray(content)) return undefined;
    for (var i = 0; i < content.length; i++) {
      var entry = content[i];
      if (!entry || entry.type !== "text" || typeof entry.text !== "string") continue;
      try {
        var parsed = JSON.parse(entry.text);
        if (isPlainObject(parsed)) return parsed;
      } catch {
        // A human-readable line rather than a payload. Keep scanning.
      }
    }
    return undefined;
  }

  /**
   * @typedef {{callTool(name:string,args:object,callTimeoutMs?:number|null):Promise<object>,destroy():void}} HostBridge
   */
  function createHostBridge(win, host, onProgress, timeoutMs) {
    var pending = new Map();
    var timeout = typeof timeoutMs === "number" ? timeoutMs : DEFAULT_HOST_TOOL_TIMEOUT_MS;
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
      if (!isPlainObject(structured)) {
        // genie#251 — `structuredContent` is only guaranteed for tools that
        // declare an `outputSchema`. Read the text payload before failing.
        // `isPlainObject` rather than a bare `typeof`: MCP constrains
        // `outputSchema` to an object root, so an array would pass `typeof`
        // while handing field-based callers an unusable shape.
        structured = textResultPayload(data.result);
      }
      if (!isPlainObject(structured)) {
        request.reject(new Error("The host returned a malformed tool result."));
        return;
      }
      request.resolve(structured);
    }
    win.addEventListener("message", onMessage);
    return {
      callTool: function (name, args, callTimeoutMs) {
        var id = ++mcpAppRequestId;
        // `callTimeoutMs === NO_CLIENT_DEADLINE` (null) means "never time out client-side for this
        // call" — used by the conjure call site, since no fixed constant can outlast every
        // operator-configured timeout/retry combination on the server (genie#241 / #243 Copilot
        // review; see NO_CLIENT_DEADLINE's doc comment above).
        var hasClientDeadline = callTimeoutMs !== NO_CLIENT_DEADLINE;
        var effectiveTimeout = typeof callTimeoutMs === "number" ? callTimeoutMs : timeout;
        return new Promise(function (resolve, reject) {
          var timer = hasClientDeadline
            ? win.setTimeout(function () {
                pending.delete(id);
                reject(new Error("The host tool request timed out. Try again."));
              }, effectiveTimeout)
            : null;
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

  function initProductShell(doc, bridge, opts) {
    opts = opts || {};
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
    // DRO-242 (fail closed, Copilot review round 5/6) — a monotonic "discovery generation" counter.
    // `loadKits()` captures the current value on entry; if a NEWER call has started (bridge swapped
    // via `setBridge`/`setUnavailable`, or a fresh refresh triggered) by the time an OLDER call's
    // `await bridge.callTool(...)` resolves — in either order, since network replies can complete
    // out of order — the older call's resolution/rejection must not mutate `kits`/the DOM at all.
    // Without this, a stale in-flight discovery whose reply finally arrives after a newer (possibly
    // malformed-and-already-failed-closed) one could resurrect trusted `kits` state and silently
    // re-enable Conjure/Retry on data a subsequent call had already invalidated.
    var kitDiscoveryGeneration = 0;
    var inFlight = false;
    var hostAvailable = Boolean(bridge);
    var hostPending = bridge === undefined;

    function renderRoute(route, focusView) {
      var selected = normalizeRoute(route);
      // Copilot (round 12) — a route change must never strand the apply dialog's `inert`. See
      // `docs/developer/architecture.md` ("A route change must never strand the apply dialog").
      if (selected !== "review" && review) review.dismissApplyConfirm();
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
      // On an explicit route change, move keyboard focus into the newly shown view so the next
      // action starts predictably there — and, critically, so focus is never left inside a
      // now-hidden subtree (e.g. the Conjure button after routing to Review on success). Skipped on
      // initial load/popstate so we don't steal focus the user didn't ask to move.
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
     * True when a kit-relative path is design-token/house-style source: either inside `tokens/**`
     * or the canonical root `styles.css` (Copilot review on #246 — the root file carries a kit's
     * shared variables/import closure just as much as `tokens/**` does; see `ROOT_STYLES_PATH`'s
     * doc comment).
     */
    function isKitStyleContextFile(path) {
      return path === ROOT_STYLES_PATH || path.indexOf(TOKENS_DIR_PREFIX) === 0;
    }

    /**
     * Resolve `promise` but never wait longer than `ms` for it: resolves to `null` (rather than
     * rejecting) on timeout OR on the wrapped promise's own rejection, so callers can `Promise.all`
     * a batch of these without any one slow/failing call sinking the others or the overall deadline
     * (Copilot review on #246 — `buildKitContext`'s tool calls used to run serially, each
     * inheriting the host bridge's full 60s per-call timeout).
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
     * See architecture.md -> "Building the kit context".
     *
     * @param {{callTool(name:string,args:object):Promise<object>}} hostBridge
     * @param {string} kitId
     * @param {string} kitName
     * @param {number} [deadlineMs] Overall wall-clock budget in ms; defaults to
     * `KIT_CONTEXT_DEADLINE_MS`. Overridable so tests need not wait on the real value.
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
      // Root `styles.css` is prioritized ahead of `tokens/**` entries so it survives
      // KIT_CONTEXT_MAX_TOKEN_FILES truncation on token-heavy kits.
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

      // Read every style file and the bounded component sample concurrently — each individually
      // capped by the SAME shared deadline — rather than in series, so one slow file can't crowd
      // out the rest of the budget.
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
          // The heading itself counts against `budget` too — slicing only the file content and then
          // prepending the heading on top of that slice let the assembled chunk exceed `budget`
          // (Copilot review on #246).
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
        // Same accounting bug as above: this line was appended unconditionally AFTER the
        // budget-tracked loop, so it could push the assembled context past KIT_CONTEXT_MAX_CHARS
        // (and conjure's own kit-schema cap) regardless of how much budget remained. Truncate to
        // what's left.
        var namesBudget = budget - namesPrefix.length;
        if (namesBudget > 0) {
          sections.push(namesPrefix + names.slice(0, namesBudget));
        }
      }

      // Belt-and-suspenders: the per-chunk budget accounting above should already keep the
      // assembled string within KIT_CONTEXT_MAX_CHARS, but the "\n\n" join separators between
      // sections aren't accounted for in `budget`, so hard-cap the final string as a last line of
      // defense (Copilot review on #246).
      var assembled = sections.join("\n\n");
      return assembled.length > KIT_CONTEXT_MAX_CHARS
        ? assembled.slice(0, KIT_CONTEXT_MAX_CHARS)
        : assembled;
    }

    // M7-03 (#235) — the review workspace owns draft presentation. `initProductShell` hands it only
    // the draft plus its kit/model context; gating, checklist and apply behaviour live in
    // `initReviewController`.
    var review = initReviewController(doc, {
      getBridge: function () {
        return bridge;
      },
      announce: function (message) {
        status.textContent = message;
      },
      // Supplied by the boot path, which owns the Browse controller and the manifest. Absent in
      // unit tests that drive the review controller alone.
      onApplied: function (applied) {
        if (typeof opts.onApplied !== "function") return undefined;
        return Promise.resolve(opts.onApplied(applied)).then(function () {
          // AC13 — route only once Browse actually holds the component. Navigating first flashes a
          // stale panel; navigating on failure strands the user on a view that cannot show what
          // they wrote.
          navigate("browse", false, true);
        });
      },
    });

    function renderDraft(draft) {
      if (!review) return;
      var option = kitSelect.options[kitSelect.selectedIndex];
      review.addDraft(draft.result, {
        kitId: kitSelect.value,
        kitLabel: option ? option.textContent : kitSelect.value,
        model: modelSelect.value,
        // A fresh Conjure draft is not in the kit yet, so Refine (which reads the component's
        // current source from the kit) cannot target it until it has been applied.
        componentInKit: false,
      });
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
        // genie#239 — resolve the real kit context (tokens/primitives), not just the display name.
        // Best-effort: falls back to `selectedKit.name` alone if context-gathering throws (see
        // buildKitContext's header).
        var kitContext = selectedKit.name;
        try {
          kitContext = await buildKitContext(bridge, selectedKit.id, selectedKit.name);
        } catch {
          /* fall back to the display name — generation must still proceed. */
        }
        var result = await bridge.callTool(
          CONJURE_TOOL,
          {
            kitId: selectedKit.id,
            kit: kitContext,
            prompt: prompt.value.trim(),
            model: modelSelect.value,
          },
          NO_CLIENT_DEADLINE,
        );
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
      // DRO-242 (fail closed, Copilot review round 6) — claim this call's generation BEFORE any
      // `await`, so any call already in flight is immediately superseded and every check below can
      // tell whether IT is still the latest.
      kitDiscoveryGeneration += 1;
      var myGeneration = kitDiscoveryGeneration;
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
      // DRO-242 (fail closed, Copilot review round 4) — clear the previously trusted kit state
      // BEFORE validating the replacement reply. If kit discovery previously succeeded and a
      // subsequent refresh returns a malformed reply, leaving the old `kits` array/`<select>`
      // intact would let `updateGate()` keep Conjure enabled with stale data, and Retry would
      // invoke generation instead of reloading (because `kits.length !== 0`). Resetting here —
      // before any validation can throw — guarantees a malformed refresh always lands in the
      // zero-kits state, regardless of what came before it.
      kits = [];
      try {
        var reply = await bridge.callTool(LIST_KITS_TOOL, {});
        // DRO-242 (fail closed, Copilot review round 6) — a NEWER discovery (triggered by
        // `setBridge`/`setUnavailable` racing ahead of this `await`) has already claimed the
        // generation counter. Replies can resolve out of order — an older call's `callTool` promise
        // may settle AFTER a newer one's, in either success or failure — so this stale call must
        // not mutate `kits` or the DOM at all; whatever the newer call decided (or is still
        // deciding) must win.
        if (myGeneration !== kitDiscoveryGeneration) return;
        // DRO-242 (fail closed, Copilot review round 4) — the canonical `list_kits` output schema
        // is strict at the reply level (`additionalProperties: false`,
        // `packages/server/src/tools/list_kits.test.ts:174-178`): the only allowed key is `kits`.
        // `hasOnlyKeys` here (in addition to the existing `Array.isArray(reply.kits)` check)
        // rejects any reply that supplies extra top-level keys, e.g. `{ kits: [], unexpected: true
        // }`.
        if (!isPlainObject(reply) || !hasOnlyKeys(reply, ["kits"]) || !Array.isArray(reply.kits)) {
          throw new Error("The host returned malformed UI-kit data.");
        }
        // DRO-242 (fail closed) — every entry must be structurally valid (list_kits' own `{ id,
        // name, owner, updatedAt, canEdit }` output schema) before it is trusted at all; a single
        // malformed entry rejects the whole reply rather than being silently dropped. Only AFTER
        // that structural check does the existing `canEdit === true` gating filter down to the
        // editable subset.
        if (!reply.kits.every(isKitEntry)) {
          throw new Error("The host returned malformed UI-kit data.");
        }
        kits = reply.kits.filter(function (kit) {
          return kit.canEdit === true;
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
        // DRO-242 (fail closed, Copilot review round 6) — a stale call's rejection must not clobber
        // a newer call's (possibly already successful) state either.
        if (myGeneration !== kitDiscoveryGeneration) return;
        // `kits` was already reset to `[]` above, before validation ran, so it can never retain a
        // previously-successful discovery here. Clear the `<select>` DOM to match — otherwise a
        // stale `<option>` list (and a stale `kitSelect.value`) would survive a malformed refresh
        // even though the in-memory `kits` array no longer backs it.
        kitSelect.replaceChildren();
        kitSelect.disabled = true;
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
      // The one retry button covers two distinct failures. If kit discovery is what failed, no kit
      // is selected and submitGenerate() early-returns — leaving the user stuck without a reload.
      // So when the host is present but no kits loaded, retry discovery; otherwise retry the
      // generation.
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

    // M7-02 (#234) AC11 — persist the exact Refine handoff context Browse hands off, and render it
    // into the Review empty-state (no consumer beyond that existed before this issue; full
    // refine/apply is M7-03).
    function renderRefineContext(context) {
      var dl = doc.getElementById("review-refine-context");
      // Copilot review (PR #248) — when a Refine handoff context IS present, "Conjure a component
      // first" is misleading: the user just came FROM a component (via Browse's Refine action), not
      // from a blank state. Swap the empty-state heading/detail copy to reflect that a refine
      // target was supplied, while still noting full refine/apply is M7-03.
      var heading = doc.getElementById("review-empty-heading");
      var detail = doc.getElementById("review-empty-detail");
      if (heading && detail) {
        if (context) {
          heading.textContent = "Could not open this component for review";
          detail.textContent =
            "Browse could not read this component's current source, so there is nothing to review yet. Reopen it from Browse once its source loads.";
        } else {
          heading.textContent = "No draft to review";
          detail.textContent = "Conjure a component, or open one from Browse to refine it.";
        }
      }
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
        // Copilot (round 2) — Review only recomputes host availability inside its own render, so
        // without this its Refine/Apply affordances keep whatever the bridge was at first paint.
        review.refresh();
        void loadKits();
      },
      setUnavailable: function () {
        bridge = null;
        hostAvailable = false;
        hostPending = false;
        review.refresh();
        void loadKits();
      },
      showProgress: function (message) {
        if (inFlight) showProgress(message);
      },
      // Copilot review (PR #248) — `writeRoute` alone only updates the URL; it never renders the
      // newly-active view or fires `popstate`, so a Refine handoff left the Browse view visible
      // with `?route=review` in the address bar. Route through the shell's own `navigate`, which
      // both calls `writeRoute` AND `renderRoute` (moving focus into Review), so Refine actually
      // lands the user in Review instead of a stale Browse.
      setRefineContext: function (context) {
        // AC2/S2 — a Browse handoff lands a REAL reviewable draft: the bytes Browse already read
        // become the review baseline, so it renders, runs the checklist, and (being in the kit)
        // unlocks Refine.
        var seeded = false;
        if (review && context && context.source && context.path && context.componentName) {
          review.addDraft(
            {
              componentName: context.componentName,
              group: context.group,
              files: [
                {
                  path: context.path,
                  content: context.source,
                  mimeType: "text/html",
                  encoding: "utf-8",
                },
              ],
            },
            {
              kitId: context.kitId,
              kitLabel: context.kitId,
              model: "",
              displayName: context.displayName || "",
              // It came OUT of the kit, so `refine` can load it as its source.
              componentInKit: true,
              source: "browse",
            },
            "Opened " +
              (context.displayName || context.componentName) +
              " from Browse — current kit source.",
          );
          seeded = true;
        }
        // Only fall back to the context card when no draft could be seeded; otherwise it would sit
        // under a populated review as dead metadata.
        renderRefineContext(seeded ? null : context);
        navigate("review", false, true);
      },
      // Exposed for direct unit testing of context-gathering behavior (token files, root
      // styles.css, component sampling, deadline handling) without having to drive the full
      // submitGenerate flow end to end. `deadlineMs` lets tests override KIT_CONTEXT_DEADLINE_MS so
      // the "deadline elapses" case doesn't have to wait on the real 8s value.
      buildKitContext: function (hostBridge, kitId, kitName, deadlineMs) {
        return buildKitContext(hostBridge, kitId, kitName, deadlineMs);
      },
    };
  }

  /**
   * AC5 — filter rendered cards by a case-insensitive substring of the component `name`. Hides
   * non-matching cards, and hides a whole group section when none of its cards match (so an empty
   * group header doesn't linger). An empty query reveals everything.
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
   * Copilot review (PR #248) — `#grid` is `hidden` in the shipped `index.html` (Browse workbench is
   * the visible surface now); both `renderError` and `renderToolResultError` wrote ONLY into that
   * hidden element, so a failed manifest fetch or a `ui/notifications/tool-result` error left
   * Browse showing its ordinary "Select a component…" placeholder forever — the user had no visible
   * signal anything failed. Mirror the same message into the visible `#browse-detail` pane (a
   * no-op, like the rest of Browse wiring, when that element isn't present — e.g. the fixture-only
   * grid tests).
   *
   * @param {Document} doc
   * @param {string} detail
   */
  function renderBrowseWorkbenchError(doc, detail) {
    var detailContainer = doc.getElementById("browse-detail");
    if (!detailContainer) return;
    detailContainer.replaceChildren();
    var box = doc.createElement("div");
    box.className = "ds-error";
    box.setAttribute("role", "alert");
    box.textContent = detail;
    detailContainer.appendChild(box);
  }

  /**
   * Render a visible error state in the grid (never throw out of `boot`) — a failed manifest fetch
   * should tell the developer what to do, not blow up the page.
   *
   * @param {Document} doc
   * @param {HTMLElement} grid
   * @param {string} detail
   */
  function renderError(doc, grid, detail) {
    grid.replaceChildren();
    var box = doc.createElement("div");
    box.className = "ds-error";
    var message =
      "Could not load the preview manifest (" +
      detail +
      "). Run the genie MCP server against this kit first.";
    box.textContent = message;
    grid.appendChild(box);
    // Copilot review (PR #248) — `grid` is hidden once Browse is the visible surface; mirror this
    // into the workbench so the error is actually seen.
    renderBrowseWorkbenchError(doc, message);
  }

  // ── HMR: per-card live refresh (M4-04 / DRO-266) ────
  // Two transports (a `/__genie_hmr` WebSocket and host `postMessage`) feeding one pure
  // dispatcher (`applyHmrMessage`), and why a refresh is src-reassignment rather than
  // `contentWindow.location.reload()`: see `docs/developer/architecture.md` →
  // "Per-card HMR refresh".

  /** AC1's WebSocket endpoint path — must match `GENIE_HMR_PATH` server-side. */
  var HMR_PATH = "/__genie_hmr";

  /** Cache-bust query param appended to a reloaded iframe's live `src`. */
  var HMR_CACHE_BUST_PARAM = "__genie_hmr";

  /** AC4 — polling-fallback cadence when the WebSocket is unavailable. */
  var HMR_POLL_INTERVAL_MS = 2000;

  /** Monotonic cache-bust token source (never `Date.now`, so tests are pure). */
  var hmrReloadToken = 0;

  /**
   * Normalise a raw WS frame (a JSON string) or a `postMessage` payload (a string or already-parsed
   * object) into an internal reload command, or `null` for anything unrecognised (so unrelated
   * `postMessage`s from other libraries are silently ignored). Accepts both wire shapes:
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
   * Reassign one iframe's `src` to its stable `data-src` plus a fresh cache-bust token, or install
   * `freshSrc` from the embedded host for a data-backed card. Returns `true` when a navigation was
   * started.
   *
   * @param {HTMLIFrameElement} iframe
   * @param {number|string} token
   * @param {string=} freshSrc
   * @returns {boolean}
   */
  function reloadIframeEl(iframe, token, freshSrc) {
    // The embedded refresh channel only ever carries a base64 `data:text/html` document (see
    // `normalizeHmrMessage`); the standalone dev-server plugin sends no `src` at all. Pinning the
    // prefix means a compromised or misconfigured host cannot steer the frame at another origin --
    // anything else falls through to the ordinary `data-src` reload below.
    if (freshSrc && freshSrc.indexOf("data:text/html;base64,") === 0) {
      iframe.setAttribute("data-src", freshSrc);
      iframe.setAttribute("src", safeFrameSrc(freshSrc));
      return true;
    }

    var src =
      iframe.getAttribute("data-src") ||
      iframe.getAttribute("src") ||
      iframe.getAttribute("data-path");
    if (!src || /^data:/i.test(src)) return false;
    var sep = src.indexOf("?") === -1 ? "?" : "&";
    iframe.setAttribute("src", safeFrameSrc(src + sep + HMR_CACHE_BUST_PARAM + "=" + token));
    return true;
  }

  /**
   * AC2 — reload ONLY the card(s) whose `data-path` equals `path`. Iterates (rather than a
   * `[data-path="…"]` selector) so a path with selector-special characters can't break matching.
   * Returns how many iframes were reloaded.
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
   * AC5 — reload EVERY card iframe (a tokens/styles change repaints them all). One shared token for
   * the batch is fine: each iframe has a distinct path, so the token only needs to differ from that
   * iframe's previous `src`.
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
   * Pure dispatcher: normalise a message and apply it to the grid, returning the number of iframes
   * reloaded (0 for an unrecognised or no-match message). A caller may pin `token` for determinism;
   * otherwise a monotonic token is used so each dispatch actually changes every affected `src`.
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
   * AC4 (polling fallback) — pure diff of two manifests: the kit-relative paths of components
   * PRESENT in both whose `hash` changed. Structural and rendered metadata changes are detected
   * separately by `manifestStructureChanged` and trigger a full re-render; this helper
   * intentionally reports only in-place content edits. Never throws on a partial/absent manifest.
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
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * (“Structural manifest changes”) — viewer.js is capped at 256 KiB (#253).
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

  /**
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * (“Browse metadata-only manifest changes”) — viewer.js is capped at 256 KiB (#253).
   *
   * @param {object} prev
   * @param {object} next
   * @returns {boolean}
   */
  function manifestBrowseMetadataChanged(prev, next) {
    function projection(manifest) {
      var components = (manifest && manifest.components) || [];
      var cards = [];
      for (var i = 0; i < components.length; i++) {
        var component = components[i] || {};
        var key = component.sourcePath || component.path || String(i);
        cards.push({
          key: key,
          subtitle: component.subtitle || "",
          lastModified: component.lastModified || "",
          tags: Array.isArray(component.tags) ? component.tags : [],
        });
      }
      return JSON.stringify(cards);
    }
    return projection(prev) !== projection(next);
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
   * AC6 — increment the header's reload counter by `n` (a no-op when `n<=0` or the counter element
   * is absent, e.g. the embedded shell). The count is mirrored in a `data-count` attribute so a
   * test can read it without parsing display text.
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
   * The `ws(s)://…/__genie_hmr` URL for the current location, or `null` when there is no dev server
   * to connect to — a `file://` open or an opaque/`ui://` embedded origin. That `null` is what
   * makes the script byte-identical across vehicles (RFC G-5): the SAME `viewer.js` simply skips
   * the live socket where one can't exist and leans on the `postMessage` bridge instead.
   *
   * @param {Location|{protocol?:string,host?:string}} loc
   * @returns {string|null}
   */
  function hmrSocketUrl(loc) {
    if (!loc || (loc.protocol !== "http:" && loc.protocol !== "https:") || !loc.host) return null;
    return (loc.protocol === "https:" ? "wss:" : "ws:") + "//" + loc.host + HMR_PATH;
  }

  /**
   * See architecture.md -> "The HMR reload protocol".
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
    // a test can DISABLE a capability by passing it as `undefined`/`null` — e.g. `WebSocketImpl:
    // undefined` to exercise the no-WebSocket polling path even though the ambient jsdom `window`
    // provides a real one. Production callers omit the key entirely and get the ambient default.
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
      // Copilot review (PR #248) — checked against the PRE-update `lastManifest` (below reassigns
      // it), independent of `structureChanged`/ `contentChangedPaths`, so a metadata-only edit
      // (tags/subtitle/ lastModified, with no path/name/group/viewport/hash change) still notifies
      // Browse even though it's invisible to the grid-rebuild decision above.
      var metadataChanged =
        Boolean(lastManifest) && manifestBrowseMetadataChanged(lastManifest, next);
      lastManifest = next;
      // M7-02 (#234) — HMR-safe Browse: re-project the SAME live tree/ selection against the fresh
      // manifest on every update (structural or content-only alike), never resetting an unrelated
      // selection/filter (see `initBrowseController`'s own doc for why re-resolving-by- identity is
      // safe here).
      //
      // Copilot review (PR #248) — but only when the manifest actually changed.
      // Standalone/localhost Browse polls every `HMR_POLL_INTERVAL_MS` (2s) unconditionally (no
      // WebSocket), and every one of those ticks used to call `onManifestUpdate` even for a
      // byte-equivalent response — `initBrowseController.update()` treats that as "manifest
      // changed" unconditionally and re-renders detail (which re-runs `fetchSource`), so a selected
      // component's preview and source panel silently reloaded every 2 seconds with nothing to show
      // for it. `structureChanged` (a genuinely new/removed group or component), a non-empty
      // `contentChangedPaths` (a real per-card hash diff), or `metadataChanged` (a Browse-visible
      // metadata-only edit) are the only ways `next` can differ from `lastManifest` in a way Browse
      // should react to.
      if (
        (structureChanged || contentChangedPaths.length > 0 || metadataChanged) &&
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
      // Copilot review (PR #248) — `card.changed`/`tokens.changed` (and the legacy `refresh`
      // message normalizing to the same commands) previously reloaded ONLY the hidden `#grid`'s
      // iframes via `applyHmrMessage` above. Neither `onManifestUpdate` (fired only by the
      // fetch-manifest path in `applyFetchedManifest`) nor anything else told Browse's selected
      // detail iframe to refresh, so it stayed visibly stale on a live per-card/token push even
      // though the grid updated correctly. `onCardOrTokensChanged` lets the boot() call sites force
      // a Browse detail re-render (bypassing the identity-selection dedup) on these normalized
      // commands specifically.
      if (
        command &&
        (command.kind === "card" || command.kind === "tokens") &&
        typeof opts.onCardOrTokensChanged === "function"
      ) {
        opts.onCardOrTokensChanged(command);
      }
    }

    // ── Transport 2: the postMessage bridge (embedded ui:// tier) ────
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
      // Sandboxed cards can call parent.postMessage despite lacking allow-same-origin. Only the
      // embedding host may issue refresh commands.
      if (!event || !win || event.source !== win.parent) return;
      if (parentOrigin && event.origin !== parentOrigin) return;
      handle(event && "data" in event ? event.data : event);
    }
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("message", onMessage);
    }

    // ── AC4: polling fallback ────
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
          // A transient fetch failure must not kill the poll loop — try again next tick.
        })
        .then(finishManifestFetch);
    }

    function startPolling() {
      if (torn || pollTimer || !setIntervalImpl || !fetchImpl) return;
      pollTimer = setIntervalImpl(poll, pollIntervalMs);
    }

    // ── Transport 1: the WebSocket (primary, dev-server only) ────
    var url = hmrSocketUrl(location);
    if (url && WebSocketImpl) {
      try {
        socket = new WebSocketImpl(url);
        socket.onmessage = function (event) {
          handle(event && "data" in event ? event.data : event);
        };
        // A socket error or close (server gone, CSP block, network drop) falls back to polling —
        // but only once (guarded inside startPolling).
        socket.onerror = startPolling;
        socket.onclose = startPolling;
      } catch {
        // Constructing the socket threw (e.g. a CSP `connect-src` block) — go straight to the
        // polling fallback.
        startPolling();
      }
    } else if (url && !WebSocketImpl) {
      // A dev server is present but this environment has no WebSocket at all — poll from the start.
      startPolling();
    }
    // else (url === null): file:// / ui:// — no dev server to reach; the postMessage bridge above
    // is the only live channel, by design.

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
   * See architecture.md -> "Reading the inline manifest".
   *
   * @param {Document} doc
   * @param {string=} elementId defaults to {@link MANIFEST_ELEMENT_ID}; pass
   * {@link MANIFEST_FULL_ELEMENT_ID} to read the full-kit island instead.
   * @returns {object | null}
   */
  function readInlineManifest(doc, elementId) {
    var el = doc.getElementById(elementId || MANIFEST_ELEMENT_ID);
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
   * Wire the `#q` search box to live-filter the rendered grid (AC5). Shared by both boot paths
   * (inline + fetch) so the two vehicles behave identically.
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
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * (“Viewer boot and manifest source”) — viewer.js is capped at 256 KiB (#253).
   *
   * @param {Document} doc
   * @param {typeof fetch} fetchImpl
   * @returns {Promise<void>}
   */
  /**
   * Copilot #3 (AC13) — a minimal `HostBridge`-shaped adapter for standalone Browse (`file://` /
   * localhost, no MCP host) that still supports source inspection: `mcp__genie__read_file` reads
   * the SAME-ORIGIN kit-relative path via the ordinary `fetch` already used for the manifest,
   * rather than hard-coding a null bridge that guarantees every read fails. Any other tool name
   * rejects — this adapter exists ONLY to satisfy Browse's read-only source panel, never to fake
   * Refine/Conjure (those still correctly require a real MCP host and stay disabled — Decision #6).
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
        // Path containment: reject anything that isn't a plain kit-relative path (no `..` segments,
        // no scheme, no leading slash) — the same boundary a real host's read-file tool would
        // enforce server-side (AC16), kept here since this adapter has no server to defer to.
        //
        // Copilot review (PR #248) — the original check only rejected a literal `..` substring and
        // a literal leading `/`, which the browser URL parser doesn't treat as the only escape
        // hatches: (1) it treats backslashes as forward slashes for http(s) URLs, so
        // `\\evil.example/x` resolves same as `//evil.example/x` (protocol- relative, off-origin)
        // without ever containing a literal `/` at index 0; and (2) a percent-encoded segment
        // (`%2e%2e`, `%2E%2e`, etc.) doesn't contain the literal string `..` pre-decode, but
        // normalizes to `..` once `fetchImpl` (the real `fetch`) parses it. Decode first, then
        // reject on backslashes, any leading separator, and any decoded `.`/`..` segment — closing
        // both bypasses.
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
        // Copilot review (PR #248) — the WHATWG URL parser (and therefore `fetch`) strips
        // leading/trailing "C0 control or space" characters (tabs, newlines, plain spaces, etc.)
        // BEFORE scheme detection, so a value like "\nhttps://evil.example/x" has no leading scheme
        // letter by the raw-string checks below yet is still parsed as an absolute, cross-origin
        // URL once handed to `fetchImpl`. Reject any leading or trailing character in that stripped
        // set up front so the scheme/ separator checks below can't be bypassed by hiding them
        // behind whitespace the parser would normalize away. Intentional: \x00-\x20 is the WHATWG
        // "C0 control or space" set the URL parser trims first; that is the bypass being closed.
        // eslint-disable-next-line no-control-regex
        var URL_C0_OR_SPACE_RE = /^[\x00- ]|[\x00- ]$/;
        if (
          !path ||
          URL_C0_OR_SPACE_RE.test(path) ||
          URL_C0_OR_SPACE_RE.test(decodedPath) ||
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
        // M4-04 (DRO-266) — this tier is EXACTLY who the postMessage bridge exists for (its strict
        // CSP, connect-src 'none', blocks fetch AND a direct WebSocket alike — see initHmr's own
        // header). hmrSocketUrl resolves to null here (no http(s) origin with a host — see its own
        // doc), so initHmr transparently skips the WS + polling paths and wires ONLY the `message`
        // listener: no network access is attempted, satisfying the CSP without special-casing this
        // branch. Omitting this call (as an earlier revision did) left the bridge dead code in the
        // one tier it was built for. Best-effort, like the fetch path below: a throw here must
        // never take down an otherwise-good render.

        // Copilot review (PR #248) — Browse must navigate the WHOLE kit even when this embedded
        // resource's PRIMARY `#manifest` island (`inline`, used for the grid view above and the HMR
        // diff baseline below) was pre-filtered to one `componentName`/`group` by
        // `buildGridDocument`. `#manifest-full` (only emitted when the request WAS filtered — see
        // `MANIFEST_FULL_ELEMENT_ID`'s own doc) carries the same kit, unfiltered; fall back to
        // `inline` when it's absent, the common already-full-kit case where there's nothing to
        // widen.
        var browseSeedManifest = readInlineManifest(doc, MANIFEST_FULL_ELEMENT_ID) || inline;

        // Copilot #1 (AC1/AC12/AC13) — embedded Browse must actually initialize the workbench too,
        // not just leave content in the hidden `#grid`. `hostBridge` starts `null` (the handshake
        // hasn't resolved yet) and is handed to the controller once `initMcpApp`'s `onReady` fires,
        // via `setHostBridge` — never recreating the controller, so any selection/filter already
        // made survives.
        var browseController = initBrowse(doc, {
          hostBridge: null,
          kitId: browseSeedManifest && browseSeedManifest.name,
          kitName: browseSeedManifest && browseSeedManifest.name,
          onRefine: function (context) {
            if (shellController && shellController.setRefineContext) {
              shellController.setRefineContext(context);
            }
          },
        });

        // Copilot review (PR #248) — seed the controller with the FULL kit manifest (falling back
        // to whatever's inlined as `#manifest` when there's no separate full island), mirroring the
        // standalone tier's fix (Copilot #2 above). `initHmr({initialManifest})` only records
        // `inline` as its OWN diff baseline — it never calls `onManifestUpdate` for it — so without
        // this explicit `update()`, embedded Browse rendered the empty-kit placeholder until a
        // later tool-result or HMR message arrived (and stayed empty forever if neither did).
        browseController.update(browseSeedManifest);

        var teardownHmr = function () {};
        try {
          teardownHmr = initHmr(doc, {
            initialManifest: inline,
            onManifestUpdate: function (next) {
              browseController.update(next);
            },
            // Copilot review (PR #248) — see `onCardOrTokensChanged`'s doc comment in `initHmr` and
            // `refresh`'s in `initBrowseController`: a per-card/token HMR push carries no new
            // manifest, so only a forced re-render of the currently selected detail (against the
            // manifest already on file) picks it up.
            onCardOrTokensChanged: function () {
              browseController.refresh();
            },
          });
        } catch {
          /* live refresh is an enhancement, never a boot blocker */
        }
        // The inlined tier IS the embedded MCP-App surface, so the postMessage host bridge applies
        // to EVERY inlined resource — not only the bare tool-result shell. Query-bearing `ui://`
        // resources (e.g. the preview URI carrying `kitId`) are intentionally emitted WITHOUT the
        // tool-result-shell marker (grid-resource.ts), yet still use the MCP-App MIME type and
        // still run inside a host frame. Gating the bridge on that marker wrongly flagged their
        // Generate tab "Host unavailable". Start the shell in the pending state and let initMcpApp
        // resolve ready/unavailable from the actual host handshake.
        var shellController = initProductShell(doc, undefined, {
          // AC13 — close the loop into Browse and re-read the bytes. A throw surfaces as the
          // truthful "written, but the view is stale" state.
          onApplied: function (applied) {
            // `return` is load-bearing — `confirmApply` awaits it (see architecture.md).
            return browseController.openComponent(applied.group, applied.componentName);
          },
        });
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

        // M7-02 (#234) — standalone/localhost Browse workbench. Reuses the SAME fetched manifest as
        // the grid above (no parallel catalog — Decision #1); a no-op when `#browse-workbench`
        // isn't present in this document (e.g. the fixture-only grid tests).
        //
        // Copilot #3 (AC13) — standalone still supports source inspection via
        // `createStandaloneSourceBridge`'s same-origin relative fetch, rather than a hard-coded
        // null bridge that made `fetchSource` always resolve `null`.
        var standaloneShellController = initProductShell(doc, null, {
          // AC13 — same close-the-loop contract as the embedded tier. `browseController` is
          // assigned immediately below; this closure only ever runs long after boot, so the
          // reference is safe.
          onApplied: function (applied) {
            // `return` is load-bearing — `confirmApply` awaits it (see architecture.md).
            return browseController.openComponent(applied.group, applied.componentName);
          },
        });
        var browseController = initBrowse(doc, {
          hostBridge: createStandaloneSourceBridge(fetchImpl),
          kitId: manifest && manifest.name,
          kitName: manifest && manifest.name,
          onRefine: function (context) {
            if (standaloneShellController && standaloneShellController.setRefineContext) {
              standaloneShellController.setRefineContext(context);
            }
          },
        });

        // Copilot #2 — supply the ALREADY-FETCHED manifest to the controller up front. `initHmr`'s
        // `initialManifest` is only its OWN polling/ diff baseline, and `onManifestUpdate` fires no
        // earlier than the first refresh — without this call, standalone Browse would render the
        // empty-kit placeholder until the first HMR tick.
        browseController.update(manifest);

        // M4-04 (DRO-266) — engage live per-card refresh AFTER the grid exists, handing the
        // just-fetched manifest in as the polling baseline so the fallback's very first tick can
        // already spot a hash change. Best-effort: if it throws (an exotic embed with no window at
        // all), the static grid still stands. The teardown fn is intentionally unused here — the
        // browser page lives until navigation; tests call `initHmr` directly and own their own
        // teardown.
        try {
          initHmr(doc, {
            initialManifest: manifest,
            onManifestUpdate: function (next) {
              browseController.update(next);
            },
            // Copilot review (PR #248) — same gap as the embedded tier
            // above: a per-card/token HMR push carries no new manifest.
            onCardOrTokensChanged: function () {
              browseController.refresh();
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

  // ── Cross-script seam: Browse workbench (#253) ────
  // `viewer.js` had grown to within 356 B of the 256 KiB store read cap — still
  // servable, but one edit from not being — so the Browse workbench lives in
  // `viewer-browse.js`, loaded as an ordered classic script BEFORE this one.
  // Both directions resolve lazily at call time, so neither script depends on
  // the other having finished evaluating.

  /**
   * @returns {object} the Browse seam, or `{}` if that script was not loaded.
   */
  function browse() {
    return (typeof window !== "undefined" && window.__genieViewerBrowse) || {};
  }

  /**
   * Initialise the Browse workbench, degrading to an inert controller when
   * `viewer-browse.js` is not present.
   *
   * The grid is the PRIMARY surface and boots on the same path as Browse. If
   * that script 404s or is blocked, calling `browse().initBrowseController`
   * directly throws a `TypeError` from inside `boot`, so the GRID dies too and
   * the page shows "Could not load the preview manifest" — blaming a manifest
   * that parsed fine. Falling back keeps the grid rendering and names the real
   * cause. Both files ship together in every vehicle, so reaching the fallback
   * is a packaging bug; `static-index.test.ts` and the server's
   * `VIEWER_STATIC_FILES` conformance tests keep that a hard test failure.
   *
   * @param {Document} doc
   * @param {object} options passed straight through to the real controller.
   * @returns {object} the Browse controller, or an inert stand-in.
   */
  function initBrowse(doc, options) {
    var seam = browse();
    if (seam && typeof seam.initBrowseController === "function") {
      return seam.initBrowseController(doc, options);
    }
    if (typeof console !== "undefined" && console.error) {
      console.error(
        "genie viewer: viewer-browse.js did not load — the Browse workbench is " +
          "unavailable. The grid still renders. Check that viewer-browse.js is " +
          "served alongside viewer.js and loaded BEFORE it.",
      );
    }
    // The shipped shell hides `#grid` and shows `#browse-workbench` (Browse
    // re-projects the grid into the workbench on every update), so a
    // rendered-but-hidden grid is invisible: without this swap "the grid still
    // renders" degrades to an EMPTY workbench — strictly worse than the grid
    // we just rendered successfully. Idempotent; `initBrowse` may run twice.
    var gridEl = doc && doc.getElementById && doc.getElementById("grid");
    if (gridEl) gridEl.hidden = false;
    var workbenchEl = doc && doc.getElementById && doc.getElementById("browse-workbench");
    if (workbenchEl) workbenchEl.hidden = true;
    // Same inert shape `initBrowseController` itself returns when the workbench
    // DOM is absent, so every core call site stays total.
    return {
      update: function () {},
      setHostBridge: function () {},
      refresh: function () {},
      openComponent: function () {},
      teardown: function () {},
    };
  }

  // Published for `viewer-browse.js`'s `core()`. Kept to the symbols Browse
  // actually calls — widening this is widening a public-ish surface.
  if (typeof window !== "undefined") {
    window.__genieViewerCore = {
      writeRoute: writeRoute,
      computeGroupOrder: computeGroupOrder,
      groupByGroup: groupByGroup,
      safeFrameSrc: safeFrameSrc,
      parseViewport: parseViewport,
      accessibleName: accessibleName,
      DEFAULT_CARD_HEIGHT: DEFAULT_CARD_HEIGHT,
    };
  }

  // ── Browser auto-boot ────
  // The ONLY side-effecting line. Guarded so evaluating this script under a test harness that
  // hasn't triggered a real navigation still behaves, and so the auto-boot never fires twice. In
  // the browser, `fetch` and `document` are ambient globals.
  if (typeof document !== "undefined" && typeof fetch !== "undefined") {
    void boot(document, fetch);
  }

  // Test-only seam — see file header. No-op (and no global write at all) unless a test harness
  // pre-defines the hook object before this script runs.
  if (typeof window !== "undefined" && window.__genieViewerTestHooks) {
    window.__genieViewerTestHooks.MANIFEST_URL = MANIFEST_URL;
    window.__genieViewerTestHooks.DEFAULT_CARD_HEIGHT = DEFAULT_CARD_HEIGHT;
    window.__genieViewerTestHooks.KIT_CONTEXT_DEADLINE_MS = KIT_CONTEXT_DEADLINE_MS;
    window.__genieViewerTestHooks.DEFAULT_HOST_TOOL_TIMEOUT_MS = DEFAULT_HOST_TOOL_TIMEOUT_MS;
    window.__genieViewerTestHooks.NO_CLIENT_DEADLINE = NO_CLIENT_DEADLINE;
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
    window.__genieViewerTestHooks.isConjureFileEntry = isConjureFileEntry;
    window.__genieViewerTestHooks.isManifestEntry = isManifestEntry;
    window.__genieViewerTestHooks.isConjureUsage = isConjureUsage;
    window.__genieViewerTestHooks.isKitEntry = isKitEntry;
    window.__genieViewerTestHooks.isPlainObject = isPlainObject;
    window.__genieViewerTestHooks.createDraftStore = createDraftStore;
    window.__genieViewerTestHooks.createHostBridge = createHostBridge;
    window.__genieViewerTestHooks.initProductShell = initProductShell;
    window.__genieViewerTestHooks.applyFilter = applyFilter;
    window.__genieViewerTestHooks.readInlineManifest = readInlineManifest;
    window.__genieViewerTestHooks.wireSearch = wireSearch;
    window.__genieViewerTestHooks.MANIFEST_ELEMENT_ID = MANIFEST_ELEMENT_ID;
    window.__genieViewerTestHooks.MANIFEST_FULL_ELEMENT_ID = MANIFEST_FULL_ELEMENT_ID;
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
    window.__genieViewerTestHooks.manifestBrowseMetadataChanged = manifestBrowseMetadataChanged;
    window.__genieViewerTestHooks.renderManifestUpdate = renderManifestUpdate;
    window.__genieViewerTestHooks.bumpReloadCounter = bumpReloadCounter;
    window.__genieViewerTestHooks.hmrSocketUrl = hmrSocketUrl;
    window.__genieViewerTestHooks.initHmr = initHmr;
    // M7-02 (#234) — Browse UI-kit workbench seam.
    window.__genieViewerTestHooks.extractToolResultManifest = extractToolResultManifest;
    window.__genieViewerTestHooks.createStandaloneSourceBridge = createStandaloneSourceBridge;

    // M7-03 (#235) — review → refine → approve → apply.
    window.__genieViewerTestHooks.isRefineResult = isRefineResult;
    window.__genieViewerTestHooks.safeFrameSrc = safeFrameSrc;
    window.__genieViewerTestHooks.isSafeFrameSrc = isSafeFrameSrc;
    window.__genieViewerTestHooks.entryByteLength = entryByteLength;
    window.__genieViewerTestHooks.parseUnifiedDiff = parseUnifiedDiff;
    window.__genieViewerTestHooks.computeChecklist = computeChecklist;
    window.__genieViewerTestHooks.createReviewStore = createReviewStore;
    window.__genieViewerTestHooks.computeApplyGate = computeApplyGate;
    window.__genieViewerTestHooks.canRefine = canRefine;
    window.__genieViewerTestHooks.buildPlanArgs = buildPlanArgs;
    window.__genieViewerTestHooks.deletedPathsFromDiff = deletedPathsFromDiff;
    window.__genieViewerTestHooks.violatesEmbeddedCsp = violatesEmbeddedCsp;
    window.__genieViewerTestHooks.buildWriteFilesArgs = buildWriteFilesArgs;
    window.__genieViewerTestHooks.detectDeterministicControls = detectDeterministicControls;
    window.__genieViewerTestHooks.applyDeterministicTweak = applyDeterministicTweak;
    window.__genieViewerTestHooks.runRefine = runRefine;
    window.__genieViewerTestHooks.runApply = runApply;
    window.__genieViewerTestHooks.renderDiffFiles = renderDiffFiles;
    window.__genieViewerTestHooks.renderDiffStats = renderDiffStats;
    window.__genieViewerTestHooks.renderBlockers = renderBlockers;
    window.__genieViewerTestHooks.renderChecklist = renderChecklist;
    window.__genieViewerTestHooks.initReviewController = initReviewController;
  }
})();
