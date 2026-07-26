/**
 * genie viewer — Browse UI-kit workbench (M7-02 / #234).
 *
 * Split out of `viewer.js` (#253): that file reached 261,788 B against the
 * 256 KiB store read cap, so `create_kit` scaffolded a kit whose own viewer
 * the server could no longer serve over `read_file`. The cut follows the
 * product's own seam — CLAUDE.md describes two surfaces, the preview grid and
 * the UI-kit file browser — and this is the second one.
 *
 * Loaded as an ORDERED CLASSIC SCRIPT, never an ES module: a module script's
 * relative `src` is rejected under `file://` (opaque origin), and RFC G-5
 * requires byte-identical behaviour across `file://` / `localhost` / `ui://`.
 * See `static/index.html` for the full rationale (DRO-749).
 *
 * This script loads BEFORE `viewer.js`, because `viewer.js` auto-boots
 * synchronously on parse and its boot path calls `initBrowseController`.
 * The two directions of the seam are both resolved lazily at call time, so
 * neither script depends on the other having finished evaluating:
 *
 *   - Browse → core: `core()` reads `window.__genieViewerCore`.
 *   - core → Browse: `browse()` reads `window.__genieViewerBrowse`.
 *
 * Turns the M4 grid into a navigable tree + component-detail workbench, reusing
 * the same manifest, iframe sandbox, and HMR machinery. Everything here is
 * additive: `renderGrid`/`applyFilter`/HMR are untouched, and this module only
 * reads the manifest — it never mutates it (AC2/AC3).
 *
 * Design reference: `docs/designs/design-6/01-ui-kit-browser.svg` + `design.md`
 * §§7, 11-14. Decision #5 (issue #234): the shipped manifest carries NO variant
 * concept (`store/manifest.ts` / `manifest/compiler.ts` have no `variant`
 * field) — so `computeVariantTabs` below deliberately renders Default-only with
 * Hover/Focus/Disabled declared-but-disabled, rather than inventing a new schema.
 */

(function () {
  "use strict";

  /**
   * Shared internals published by `viewer.js`. Resolved on every call rather
   * than destructured once: this script is evaluated first, so the namespace
   * does not exist yet at parse time.
   *
   * @returns {object} the core seam, or `{}` before `viewer.js` has run.
   */
  function core() {
    return (typeof window !== "undefined" && window.__genieViewerCore) || {};
  }

  /**
   * Case-insensitive substring match against a component's name AND group — the same "supported
   * metadata" search scope the product-behavior section of #234 describes. Pure; never mutates its
   * inputs.
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
   * Project a compiled manifest into the Browse tree shape: groups (in the manifest's own
   * deterministic order, via {@link computeGroupOrder}), each holding its matching components, plus
   * overall counts and the two distinct "nothing to show" flags AC4 requires:
   *   - `isEmptyKit`  — the KIT itself has zero components (no search applied
   * or not — an empty kit is empty regardless of the query).
   *   - `isNoMatch`   — the kit has components, but the current `search`
   * matched none of them. Never mutates `manifest`.
   *
   * @param {object} manifest
   * @param {string=} search
   * @returns {{ groups: Array<{name:string,count:number,components:Array<object>}>, totalCount: number, isEmptyKit: boolean, isNoMatch: boolean }}
   */
  function projectManifestToTree(manifest, search) {
    var components = (manifest && manifest.components) || [];
    var isEmptyKit = components.length === 0;
    var needle = (search || "").trim().toLowerCase();

    var grouped = core().groupByGroup(components);
    var order = core().computeGroupOrder(manifest && manifest.groups, grouped);

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
      // A kit with data but a query that hid everything is a distinct state from "the kit is empty"
      // (AC4) — never true when the kit itself is empty (that's `isEmptyKit`'s job) or when there
      // is no active query.
      isNoMatch: !isEmptyKit && totalCount === 0 && needle !== "",
    };
  }

  /**
   * Resolve a `{kitId, group, componentName}` selection against a projected tree by STABLE IDENTITY
   * (never DOM/array index — AC3/Decision #7). `kitId` is accepted for the caller's bookkeeping (a
   * future multi-kit host) but the current single-kit tree only disambiguates on `group +
   * componentName`, matching the compiled manifest's own identity.
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
   * A UI-kit change always invalidates a prior selection's identity (AC/ product-behavior:
   * "changing UI kit clears an invalid prior component selection"). Returns `null` unconditionally
   * — callers choose the new default (first valid component, or none) deterministically themselves;
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
   * Serialize a selection into `URLSearchParams`-compatible query params — the deep-link contract
   * (Decision #7): `kitId`, `group`, `componentName` all survive refresh without relying on array
   * position.
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
   * Parse a deep-link's `URLSearchParams` back into a selection, or `null` when
   * `group`/`componentName` (the two identity-bearing fields) are not BOTH present — a partial link
   * is not a valid selection (AC4's "unknown selection falls back to a controlled not-found
   * state").
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
   * Decision #5 — the compiled manifest carries no variant concept today. Returns the four Design-6
   * tabs with ONLY `default` marked available; the rest are declared-but-disabled with an
   * accessible reason, never a fabricated rendered state (AC8). If a future manifest version adds a
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
   * Prepare raw source text for safe, plain-text display: never executed, never `innerHTML`'d
   * (callers must use `textContent`), and truncated progressively for large files rather than
   * rendering megabytes inline. Non-string input (a failed/absent read) degrades to an empty, non-
   * truncated result rather than throwing (AC16 — a hostile/malformed read must not take the panel
   * down).
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
   * Build the exact context object Refine hands to Review (AC11): the selected
   * kit/group/component/variant, and nothing else — no mutation, no write. `viewer.js` has no
   * Review-side consumer yet beyond the M7-01 shell's empty-draft view (M7-03 is the actual apply
   * workflow); this is a pure, independently-testable data-shaping step so that wiring is a small
   * final piece rather than an untested one.
   *
   * @param {string} kitId
   * @param {object} component
   * @param {string} variant
   * @returns {{kitId: string, group: string, componentName: string, variant: string}}
   */
  /**
   * The kit-relative file a Browse component's bytes were read from. `sourcePath` is authoritative
   * because the embedded manifest rewrites `path` to an absolute/data transport URL for the preview
   * iframe; an absolute URL is never a kit-relative write target, so it is rejected.
   */
  function browseSourcePath(component) {
    if (!component) return "";
    var candidate = component.sourcePath || component.path;
    if (typeof candidate !== "string" || !candidate) return "";
    return /^[a-z][a-z0-9+.-]*:/i.test(candidate) || candidate.indexOf("//") === 0 ? "" : candidate;
  }

  /**
   * Mirror the server's `parseComponentPath`: `refine` matches on path segment 3 — the component
   * DIRECTORY. A manifest `name` is only the preview file's basename, so `Button/preview.html` is
   * named e.g. "Primary buttons" and sending that yields `ERR_COMPONENT_NOT_FOUND`.
   */
  function componentDirFromPath(path) {
    if (typeof path !== "string") return "";
    var parts = path.split("/");
    return parts.length >= 4 && parts[0] === "components" ? parts[2] : "";
  }

  function buildRefineContext(kitId, component, variant, source) {
    var group = (component && component.group) || "";
    var displayName = (component && component.componentName) || "";
    var path =
      browseSourcePath(component) ||
      (group && displayName
        ? "components/" + group + "/" + displayName + "/" + displayName + ".html"
        : "");
    return {
      kitId: kitId || "",
      group: group,
      componentName: componentDirFromPath(path) || displayName,
      // Kept for the UI: what Browse shows the user is not what the server resolves a refine
      // against.
      displayName: displayName,
      variant: variant || "default",
      // AC2/S2 — Browse already read these bytes; carrying them seeds a REAL draft. `null` (read
      // failed / source-less) means "context, no draft".
      source: typeof source === "string" && source ? source : null,
      // Copilot #2 (PR #250) — Browse reads bytes from `sourcePath || path`;
      // fabricating `<Name>/<Name>.html` would plan a write to a DIFFERENT file than the one whose
      // bytes we hold. (Embedded rewrites `path`.)
      path: path,
    };
  }

  /**
   * Render the 240px Browse tree: kit header, one labelled section per group with a live count, and
   * keyboard-operable `role="treeitem"` rows (AC/a11y: arrow-key roving tabindex, Home/End,
   * Enter/Space to select). Distinguishes the three "nothing selected yet" states (AC4): empty kit
   * (CTA to Generate), no-filter-match (scoped Clear-filter action), and the normal populated tree.
   *
   * @param {Document} doc
   * @param {HTMLElement} container
   * @param {ReturnType<typeof projectManifestToTree>} tree
   * @param {string|null} activeSearch — current query, for the no-match Clear action.
   * @param {(selection: {group:string, componentName:string}) => void=} onSelect
   * @param {{group:string, componentName:string}|null=} selected
   */
  function isElementVisible(doc, el) {
    if (!el) return false;
    var win = doc.defaultView;
    if (!win || typeof win.getComputedStyle !== "function") return true;
    var style = win.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  /**
   * Focus the first navigation control that is both present AND visible at the current breakpoint.
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * ("Focusing the right Browse navigation control at every breakpoint") — viewer.js is capped at
   * 256 KiB (#253).
   *
   * @param {Document} doc
   * @param {HTMLElement} treeContainer
   * @param {HTMLElement|null} searchInput
   */
  function focusVisibleBrowseNavControl(doc, treeContainer, searchInput) {
    var candidates = [
      treeContainer.querySelector('[role="treeitem"][tabindex="0"]'),
      treeContainer.querySelector(".browse-tree__rail-toggle"),
      treeContainer.querySelector(".browse-tree__compact-select"),
      searchInput,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el && typeof el.focus === "function" && isElementVisible(doc, el)) {
        el.focus();
        return;
      }
    }
  }

  function renderBrowseTree(doc, container, tree, activeSearch, onSelect, selected) {
    container.replaceChildren();
    var select = typeof onSelect === "function" ? onSelect : function () {};

    var treeEl = doc.createElement("div");
    // Copilot review (PR #248, a11y) — `role="tree"` requires ARIA `treeitem` children
    // (`aria-required-children`); it's only set once we know we're building the REAL tree branch
    // below. The empty-kit and no-match states render a plain message/action instead, so `treeEl`
    // stays a plain unlabeled `div` for those (still gets the rail-toggle/ overlay/compact-nav
    // responsive treatment — just not the `tree` role it doesn't structurally satisfy).
    treeEl.className = "browse-tree";
    treeEl.id = "browse-tree-nav";

    // The 44px group rail, its overlay tree, and the <720px `compactNav` are ALWAYS built — including
    // for the empty-kit and no-match states: see `docs/developer/architecture.md` → "Browse
    // responsive navigation".
    var railToggle = doc.createElement("button");
    railToggle.type = "button";
    railToggle.className = "browse-tree__rail-toggle";
    railToggle.setAttribute("aria-haspopup", "tree");
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

    // Copilot #14 (AC14, <720px) — the <720px band collapses into a breadcrumb + `<select>`
    // dropdown compact nav, rather than only stacking the full tree into a 40vh scrolling sidebar
    // (which offered no breadcrumb and no dropdown). `.tree-sidebar`'s CSS shows only this element
    // at that breakpoint.
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
      // Copilot review (PR #248) — <720px hides `treeEl` entirely (CSS) and shows only
      // `compactNav`, so the message needs its OWN copy there too, not just inside the (now
      // off-canvas-at-this-width) tree.
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
      // Copilot review (PR #248) — same <720px rationale as isEmptyKit above: give the compact nav
      // its own live copy of the Clear-filter action rather than one hidden inside the off-canvas
      // tree. The `container`-level click handler on `[data-clear-filter]` (below) matches by
      // attribute, not by node identity, so either copy works.
      compactNav.appendChild(noMatchBox.cloneNode(true));
      container.append(railToggle, treeEl, compactNav);
      return;
    }

    // Real tree branch — now safe to declare the ARIA `tree` role, since only `treeitem` children
    // (built below) get appended to `treeEl`.
    treeEl.setAttribute("role", "tree");
    treeEl.setAttribute("aria-label", "UI kit components");

    var compactSelect = doc.createElement("select");
    compactSelect.className = "browse-tree__compact-select";
    compactSelect.setAttribute("aria-label", "Jump to a component");
    var placeholderOption = doc.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = "Choose a component…";
    placeholderOption.disabled = true;
    compactSelect.appendChild(placeholderOption);
    // Tracks whether `selected` (if any) actually matched a component that survived the current
    // filter. If the selected component was filtered out of the tree, no <option> below will carry
    // `selected = true`, so the placeholder is selected instead — otherwise the browser silently
    // falls back to selecting the FIRST real option, misrepresenting the compact <select> as
    // pointing at a component that isn't actually the detail pane/breadcrumb's selection (Copilot
    // review: bug #21).
    var selectedOptionFound = false;

    var allItems = [];
    // Parallel lookup for the compact <select>'s options — see the option construction below for
    // why this replaced a delimited `value` string.
    var compactOptionEntries = [];
    // Roving tabindex (a11y): exactly ONE item is in Tab order at a time. `tabbableCandidate`
    // tracks that single item as we walk the tree so a LATER-discovered selected row can demote an
    // EARLIER first-row candidate that already received tabindex="0" — otherwise both stay "0" and
    // produce two Tab stops (Copilot review: bug #9).
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
          // A selected row always wins the single tab stop, demoting whatever candidate (e.g. the
          // first row) was previously chosen.
          if (tabbableCandidate) tabbableCandidate.setAttribute("tabindex", "-1");
          item.setAttribute("tabindex", "0");
          tabbableCandidate = item;
        } else if (!tabbableCandidate) {
          // No selection yet encountered — the first row is the provisional candidate until/unless
          // a selected row later demotes it.
          item.setAttribute("tabindex", "0");
          tabbableCandidate = item;
        } else {
          item.setAttribute("tabindex", "-1");
        }
        section.appendChild(item);
        allItems.push(item);

        var option = doc.createElement("option");
        // Encode (group, componentName) as the option's index into a parallel lookup array rather
        // than packing both into `value` as a delimited string. A delimiter character (even a NUL,
        // which is NOT a valid XML/HTML character and gets replaced with U+FFFD by the HTML
        // parser's tokenizer during the CSP-hashed embedded-tier inlining — silently corrupting
        // this exact inline <script> and invalidating its SHA-256 CSP hash, which is what caused
        // every card to fail to render under the `ui://` vehicle) can never safely round-trip
        // through a re-parsed HTML document. Group/component names may themselves contain any
        // character (including spaces or the delimiter candidate), so no delimiter is truly safe —
        // only an out-of-band index is.
        option.value = String(compactOptionEntries.length);
        compactOptionEntries.push({ group: group.name, componentName: component.componentName });
        option.textContent = group.name + " / " + component.componentName;
        if (isSelected) {
          option.selected = true;
          selectedOptionFound = true;
        }
        compactSelect.appendChild(option);
      }
      treeEl.appendChild(section);
    }

    if (!selectedOptionFound) placeholderOption.selected = true;

    compactSelect.addEventListener("change", function () {
      var index = Number(compactSelect.value);
      var entry = compactOptionEntries[index];
      if (!entry) return;
      select({ group: entry.group, componentName: entry.componentName });
    });
    compactNav.appendChild(compactSelect);

    function activate(item) {
      select({ group: item.dataset.group, componentName: item.dataset.componentName });
      // Closing the overlay on activation returns focus predictably (a11y requirement: "Focus
      // remains visible and returns predictably when an overlay tree closes").
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
   * Render the component detail stage: breadcrumb, heading (with `@genie` marker ONLY when
   * `registered`/`validated` is a proven fact, never fabricated — AC9), variant tabs (Default-only
   * per Decision #5), the reused sandboxed preview iframe (same sandbox/lazy/CSP contract as the
   * grid's own `createCard`), a metadata panel, a sanitized source panel, and the Refine action
   * (disabled + explained when no MCP host bridge is present — AC13).
   *
   * @param {Document} doc
   * @param {HTMLElement} container
   * @param {{kitId: string, kitName?: string, component: object, source: string|null|undefined, sourceLoading?: boolean, hostAvailable: boolean, refineAvailable?: boolean, registered?: boolean, validated?: boolean, onRefine?: (ctx: object) => void}} state
   */
  function renderBrowseDetail(doc, container, state) {
    container.replaceChildren();
    var component = state.component;
    // A stable-ish id derived from group/component identity — safe for use as an element id (no `[`
    // `]` `.` etc. survive real component names, but even if one did,
    // `id`/`aria-controls`/`aria-labelledby` only need to agree with EACH OTHER, not be a valid CSS
    // selector).
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
      marker.setAttribute("aria-label", "Genie registered");
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
    // Copilot review (PR #248, AC13) — gated on `refineAvailable` (a real MCP-App host bridge), NOT
    // `hostAvailable` (which is also true for the standalone source-read-only adapter and would
    // wrongly enable Refine for browser-only users — see `refineEnabled`'s comment in
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
        // AC2/S2 — resolve LAZILY: the pane paints before `read_file` lands and only the source
        // subpanel is repainted, so a captured `state.source` would stay `null` forever. Copilot
        // (round 5) — lazy is still too EARLY while that read is in flight: the button is live from
        // first paint, so an eager click handed Review a null baseline and reported a component the
        // host could read perfectly well as unreadable. Await the pending read instead.
        function handoff(source) {
          state.onRefine(buildRefineContext(state.kitId, component, "default", source));
        }
        var live = typeof state.resolveSource === "function" ? state.resolveSource() : state.source;
        var pending =
          typeof state.resolvePendingSource === "function" ? state.resolvePendingSource() : null;
        if (live !== null && live !== undefined) return handoff(live);
        if (!pending || typeof pending.then !== "function") return handoff(live);
        // Say so, rather than looking dead — and make a second click a no-op.
        refineButton.disabled = true;
        refineButton.setAttribute("aria-disabled", "true");
        function release(source) {
          refineButton.disabled = false;
          refineButton.removeAttribute("aria-disabled");
          // A full re-render during the await detaches this button; the user moved on.
          if (refineButton.isConnected === false) return;
          handoff(source === undefined ? null : source);
        }
        pending.then(release, function () {
          release(null);
        });
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
      // AC15 — wire every rendered tab (available or declared-but-disabled) to the single preview
      // stage `tabpanel` it controls, so assistive tech can determine the tab-to-panel relationship
      // (Copilot #18).
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
        // Copilot review (PR #248) — with only Default enabled (Decision #5), a single step always
        // landed on a disabled declared-but- unavailable tab, which cannot receive focus:
        // `tabButtons[next]` kept `tabindex=-1` and `.focus()` was a no-op, so the roving tabindex
        // silently stuck (ArrowRight then did nothing on repeat, since focus never actually left
        // Default). Step past every disabled tab in the arrow's direction; if every OTHER tab is
        // disabled, this converges back on the current index and is a harmless no-op, matching a
        // single real tab in the tablist.
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
    // AC15/AC18 — the stage is the panel every variant tab's `aria-controls` points at;
    // `aria-labelledby` the active (Default) tab so its accessible name tracks whichever variant is
    // selected.
    stage.id = previewPanelId;
    stage.setAttribute("role", "tabpanel");
    stage.setAttribute("aria-labelledby", idBase + "-tab-default");
    stage.setAttribute("tabindex", "0");
    var label = doc.createElement("span");
    label.className = "stage-label";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    // AC7 — a distinct loading state: the label starts as "Preview · Loading…" and only becomes
    // "Preview · Default" once the iframe's `load` event actually fires, so a slow/stalled preview
    // isn't silently presented as already-rendered (Copilot #16).
    label.textContent = "Preview · Loading…";
    stage.appendChild(label);

    var iframe = doc.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("src", core().safeFrameSrc(component.path || ""));
    iframe.setAttribute("title", core().accessibleName(component.componentName, "preview"));
    // Mirror `createCard` (Copilot #10): a sandboxed iframe is still natively focusable, so Tab
    // would otherwise land inside the frame after the variant tabs.
    iframe.setAttribute("tabindex", "-1");
    var size = core().parseViewport(component.viewport);
    if (size) {
      iframe.setAttribute("width", String(size.width));
      iframe.setAttribute("height", String(size.height));
      iframe.style.aspectRatio = size.width + " / " + size.height;
    } else {
      iframe.setAttribute("height", String(core().DEFAULT_CARD_HEIGHT));
    }
    // An `<iframe>` does not reliably emit `error` for a failed navigation, so probe the same-origin
    // `component.path` with `fetch` first. Rationale and residual limits:
    // `docs/developer/architecture.md` → "Browse preview failure detection".
    var probeFetch =
      doc.defaultView && typeof doc.defaultView.fetch === "function" ? doc.defaultView.fetch : null;
    var markBroken = function () {
      if (stage.classList.contains("browse-preview--broken")) return;
      stage.classList.add("browse-preview--broken");
      stage.replaceChildren();
      var broken = doc.createElement("p");
      broken.textContent = "Preview unavailable.";
      stage.appendChild(broken);
    };
    if (probeFetch && component.path) {
      probeFetch(component.path)
        .then(function (response) {
          if (!response || !response.ok) markBroken();
        })
        .catch(function () {
          markBroken();
        });
    }
    iframe.addEventListener("load", function () {
      if (stage.classList.contains("browse-preview--broken")) return;
      label.textContent = "Preview · Default";
    });
    iframe.addEventListener("error", markBroken);
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
    // Copilot review (PR #248) — a generic `div` with only `aria-label` has no accessible ROLE, so
    // assistive tech has nowhere to expose that label as a landmark/section name; the "Component
    // source" label was effectively unreachable. `role="region"` makes this a labelled landmark
    // region, giving the source controls an announced section context.
    sourceBox.setAttribute("role", "region");
    sourceBox.setAttribute("aria-label", "Component source");
    // Copilot review (PR #248) — a stable marker so a later source-only update (see
    // `renderBrowseDetailSource`) can locate and replace just this subpanel instead of rebuilding
    // the entire detail pane (which would tear down and re-fetch the still-valid preview iframe
    // above).
    sourceBox.setAttribute("data-browse-source-panel", "true");
    renderBrowseSourceBoxContent(doc, sourceBox, state);
    container.appendChild(sourceBox);
  }

  /**
   * Builds the source subpanel's content (source text / loading / error copy) into an
   * already-created `sourceBox` container. Extracted from `renderBrowseDetail` so the source-read
   * settle handler can update just this subpanel in place (Copilot review, PR #248) rather than
   * replacing the whole detail pane — including its live preview iframe — every time an async
   * source read resolves.
   *
   * @param {Document} doc
   * @param {Element} sourceBox
   * @param {{source?: string|null, sourceLoading?: boolean, hostAvailable: boolean}} state
   */
  function renderBrowseSourceBoxContent(doc, sourceBox, state) {
    sourceBox.replaceChildren();
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
      // AC7 — a settled failed read is the ONLY time the "could not be read" copy is honest; a read
      // that simply hasn't resolved yet must say so distinctly (Copilot #17), never present as an
      // error.
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
  }

  /**
   * Update ONLY the source subpanel of an already-rendered detail pane, in place; fall back to a
   * full `renderBrowseDetail` re-render when the subpanel marker isn't found.
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * ("Repainting Browse source text without tearing down the preview") — viewer.js is capped at
   * 256 KiB (#253).
   *
   * @param {Document} doc
   * @param {Element} container
   * @param {object} state
   */
  function renderBrowseDetailSource(doc, container, state) {
    var sourceBox = container.querySelector('[data-browse-source-panel="true"]');
    if (!sourceBox) {
      renderBrowseDetail(doc, container, state);
      return;
    }
    renderBrowseSourceBoxContent(doc, sourceBox, state);
  }

  /**
   * Render the "component removed during HMR" controlled state (AC4/product- behavior: "If the
   * selected component disappears, show a controlled removed state and move focus to the nearest
   * valid navigation control"). This function only renders the message; moving focus is the
   * caller's job (it owns the tree DOM and knows the nearest valid item).
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
   * Rationale relocated verbatim to `docs/developer/architecture.md`
   * (“`initBrowseController` responsibilities”) — viewer.js is capped at 256 KiB (#253).
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
      return {
        update: function () {},
        setHostBridge: function () {},
        refresh: function () {},
        openComponent: function () {},
        teardown: function () {},
      };
    }

    var manifest = { components: [], groups: [] };
    var selection = null; // {group, componentName}
    var hostBridge = options.hostBridge || null;
    // Copilot review (PR #248, AC13) — source-read capability and Refine capability are NOT the
    // same thing. `hostBridge` here may be the standalone `createStandaloneSourceBridge` adapter,
    // which only ever supports `mcp__genie__read_file` and explicitly rejects everything else
    // (never Refine/Conjure — Decision #6). `refineEnabled` tracks the REAL MCP-App host bridge
    // only, and is flipped true exclusively by `setHostBridge` (the embedded tier's post-handshake
    // callback) — the standalone tier never calls `setHostBridge`, so this stays false there even
    // though `hostBridge` is truthy for source reads.
    var refineEnabled = false;
    // AC3/Copilot #7 — a monotonic generation counter. Every `renderAll()` call bumps it and
    // captures its own value; an in-flight async source read is only allowed to commit if the
    // generation it captured is STILL the current one when it resolves. This closes a race a pure
    // identity check (group+componentName) cannot: HMR replacing the SAME selected component
    // (identity unchanged, content/path changed) while an older read for the PRIOR content is still
    // in flight.
    var renderGeneration = 0;
    // Bytes of the currently selected component, once `read_file` resolves. Reset to `null` on
    // every (re)render so a stale body can never be attributed to a newly selected component.
    var latestSource = null;
    // Copilot round 3 #2 — makes `openComponent` awaitable so AC14's stale-view path is
    // reachable; reuses this read to keep the post-apply tool order pinned. See architecture.md.
    var pendingSourceRead = null;

    function currentSearch() {
      return searchInput ? searchInput.value || "" : "";
    }

    function writeSelectionToUrl(sel) {
      if (!win) return;
      try {
        var next = new win.URL(win.location.href);
        if (sel) {
          // Copilot #8 — serialize kitId too, so a saved/shared link disambiguates across kits
          // instead of only group+componentName (which could collide with a same-named component in
          // a different kit once re-opened there).
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
      // Copilot #4 — embedded manifests rewrite `component.path` to an absolute/data transport URL
      // for the IFRAME's `src`, but preserve the kit-relative file identity in `sourcePath`. A host
      // read-file tool has a relative-path contract, so it MUST receive `sourcePath` (when present)
      // rather than the rewritten transport URL, which would always fail (or worse, resolve to the
      // wrong file) against a real host.
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
        // AC2/S2 — Refine resolves bytes through this at click time. The render-time `source` is
        // `null` on first paint (read still in flight), so a snapshot would hand Review an empty
        // baseline forever.
        resolveSource: function () {
          return latestSource;
        },
        // ...and the in-flight read behind it, so an eager click can await rather than give up.
        resolvePendingSource: function () {
          return pendingSourceRead;
        },
        hostAvailable: Boolean(hostBridge),
        // Copilot review (PR #248, AC13) — gates the Refine button separately from source-read
        // availability; see `refineEnabled`'s own comment above.
        refineAvailable: refineEnabled,
        // Copilot review (PR #248) — this previously called `writeRoute(win, "review", false)` (a
        // PUSH) unconditionally, before the real shell's `setRefineContext` (`initProductShell`)
        // ran its own `navigate("review", false, true)` — which itself does a SECOND `writeRoute`
        // push plus render/focus. That put two identical "review" history entries on the stack, so
        // a single Back press after a Refine handoff landed back on "review" instead of Browse.
        // `replace: true` here means this write is never itself a second history entry — it only
        // ensures the URL reflects "review" when no shell is attached at all (the controller is
        // exercised standalone in tests with no shell), while a REAL shell's own push (via
        // `navigate`) remains the only entry Back has to undo.
        onRefine: function (context) {
          if (win) core().writeRoute(win, "review", true);
          if (typeof options.onRefine === "function") options.onRefine(context);
        },
      };
    }

    // Copilot #24 — identity of the last selection whose detail/source panel was actually
    // (re)rendered. A plain search-filter keystroke only needs to refresh the filtered tree list;
    // re-rendering the detail panel and re-issuing a `mcp__genie__read_file` call for a selection
    // that hasn't changed is wasted work — it visibly reloads the preview iframe on every character
    // typed. Callers that DO need the detail panel refreshed even when the selection is unchanged
    // (HMR content updates, a host bridge becoming available) pass `forceDetailRender: true`.
    var lastRenderedSelectionKey = undefined;

    function selectionKey(sel) {
      return sel ? sel.group + "\x00" + sel.componentName : null;
    }

    function renderAll(forceDetailRender) {
      // Copilot #6 — project the FILTERED tree only for the visible tree list/counts; selection
      // resolution below always uses the UNFILTERED manifest, so typing a filter that hides the
      // selected component never conflates "filtered out" with "removed from the manifest".
      var filteredTree = projectManifestToTree(manifest, currentSearch());
      var unfilteredTree = projectManifestToTree(manifest, "");
      renderBrowseTree(doc, treeContainer, filteredTree, currentSearch(), select, selection);

      // Copilot #24 — skip the detail-panel rebuild (and its source re-read) when the selection
      // identity hasn't actually changed since the last time it was rendered and no caller has
      // demanded a fresh render.
      var nextKey = selectionKey(selection);
      if (!forceDetailRender && nextKey === lastRenderedSelectionKey) return;
      lastRenderedSelectionKey = nextKey;

      renderGeneration += 1;
      var generation = renderGeneration;

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
        // Move focus to the nearest valid navigation control (AC/a11y) — whichever one is actually
        // visible at the current breakpoint (see `focusVisibleBrowseNavControl`'s own doc comment).
        focusVisibleBrowseNavControl(doc, treeContainer, searchInput);
        return;
      }

      // Copilot #17 — the initial render for a host-backed selection must show a distinct LOADING
      // state, not the settled-failure copy; the failure copy is reserved for when the async read
      // below actually resolves to `null`.
      latestSource = null;
      pendingSourceRead = null;
      renderBrowseDetail(
        doc,
        detailContainer,
        detailStateFor(resolved.component, null, Boolean(hostBridge)),
      );

      if (!hostBridge) return;

      pendingSourceRead = fetchSource(resolved.component).then(function (source) {
        // Copilot #7 — stale-result guard: only the render generation that is STILL current when
        // this read resolves may commit. A plain identity check (group/componentName only, the
        // prior guard) cannot catch HMR replacing the same-identity component's content/path while
        // an older read for the PRIOR content is in flight; the generation counter does.
        if (generation !== renderGeneration) return source;
        if (
          !selection ||
          selection.group !== resolved.component.group ||
          selection.componentName !== resolved.component.componentName
        ) {
          return source;
        }
        // Copilot review (PR #248) — update only the source subpanel in place, guarded by the
        // generation/selection checks above, instead of a full `renderBrowseDetail` that would tear
        // down and re-fetch the still-live preview iframe just to paint the resolved source.
        latestSource = source;
        renderBrowseDetailSource(
          doc,
          detailContainer,
          detailStateFor(resolved.component, source, false),
        );
        return source;
      });
    }

    function select(sel) {
      selection = sel;
      writeSelectionToUrl(sel);
      renderAll();
      // Copilot #22 — `renderAll()` rebuilds the tree DOM from scratch, which detaches whatever
      // treeitem the keyboard/activation event had focus on. Without this, focus silently drops to
      // <body> after every selection change. Restore it explicitly to the newly (re)rendered
      // selected row so keyboard navigation stays predictable.
      var activeItem = treeContainer.querySelector('[role="treeitem"][aria-selected="true"]');
      if (activeItem && typeof activeItem.focus === "function") activeItem.focus();
    }

    treeContainer.addEventListener("click", function (event) {
      var clear =
        event.target && event.target.closest && event.target.closest("[data-clear-filter]");
      if (clear && searchInput) {
        searchInput.value = "";
        renderAll();
        // Copilot review (PR #248) — after clearing the filter, `renderAll()` rebuilds the tree DOM
        // and the "Clear filter" button (which had focus) is detached, so focus silently drops to
        // <body>. Return focus to the search input so the user can immediately continue
        // typing/keyboard-navigating without hunting for a focus target.
        searchInput.focus();
      }
    });

    // A bare `searchInput.addEventListener("input", renderAll)` would pass the DOM Event object as
    // `renderAll`'s `forceDetailRender` argument — always truthy — silently defeating the Copilot
    // #24 dedup on every keystroke. Wrap it so a search keystroke only ever requests the default
    // (non-forced) render.
    function onSearchInput() {
      renderAll();
    }

    if (searchInput) {
      searchInput.addEventListener("input", onSearchInput);
    }

    // Deep-link (Decision #7): read an initial selection from the URL. Copilot #8 — a link's
    // `kitId` (when present) must match the CURRENT kit; a mismatched kitId means the link was
    // minted for a different kit and a same-named component here would be the wrong one, so the
    // deep-link is rejected (falls back to no initial selection) rather than silently resolving
    // against this kit.
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
        // HMR-safe: an update never resets an unrelated selection or filter (product-behavior
        // requirement) — `renderAll` re-resolves the SAME `selection` identity against the fresh
        // manifest and only shows the "removed" state if it genuinely no longer resolves. Force the
        // detail panel to re-render even though the selection's identity is unchanged — HMR can
        // replace the SAME component's content/source, which the identity-only dedup in `renderAll`
        // would otherwise skip.
        renderAll(true);
      },
      // Copilot #1 — the embedded tier's host bridge only exists after the `ui://` MCP-App
      // handshake resolves (asynchronously, after `initBrowseController` is first called with
      // `hostBridge: null` so the workbench renders immediately rather than waiting on the host).
      // This lets the boot path hand the bridge in later without recreating the whole controller
      // (and losing the live selection/filter state).
      setHostBridge: function (nextBridge) {
        hostBridge = nextBridge || null;
        // Copilot review (PR #248, AC13) — `setHostBridge` is ONLY ever called from the embedded
        // tier's real MCP-App handshake (`onReady`/`onUnavailable` in `boot()`), never by the
        // standalone tier's `createStandaloneSourceBridge` path. So this is exactly the signal that
        // a real, Refine-capable host is present.
        refineEnabled = Boolean(nextBridge);
        // Force a re-render: the bridge just changed from absent to present (or vice versa), which
        // must re-evaluate `hostAvailable`/source fetching for the SAME selection, not be skipped
        // by the identity dedup in `renderAll`.
        renderAll(true);
      },
      // Copilot review (PR #248) — a live `card.changed`/`tokens.changed` HMR push (WS or
      // postMessage) doesn't carry a new manifest at all — it's purely a content-repaint signal for
      // whatever the CURRENT manifest already describes. `update()` above requires a manifest
      // argument and is the wrong tool here; `refresh()` re-renders the selected detail (forcing
      // past the identity dedup, exactly like `update(true)`/`setHostBridge` do) against the
      // manifest already on file, so the selected preview/source panel picks up the repaint instead
      // of silently going stale.
      refresh: function () {
        renderAll(true);
      },
      // AC13 — open the just-written component with LIVE bytes. No manifest re-fetch (embedded
      // ships `connect-src 'none'`): merge in-memory, let HMR reconcile, and let `select` re-read
      // through the host bridge.
      openComponent: function (group, componentName, kitId) {
        if (!group || !componentName) return Promise.resolve();
        // Copilot round 2 — opening a component from a DIFFERENT kit would read the wrong bytes
        // under the right name. `kitId` here MUST be in Browse's own namespace (the manifest name),
        // never the server's UUID kit id — see architecture.md and #254.
        if (kitId && options.kitId && kitId !== options.kitId) {
          throw new Error("Browse is showing " + options.kitId + ", not " + kitId + ".");
        }
        var components = (manifest && manifest.components) || [];
        // Copilot #6 (PR #250) — the RAW manifest keys entries by `name`; `componentName` is the
        // TREE's shape and never matches here.
        var known = components.some(function (component) {
          return component && component.group === group && component.name === componentName;
        });
        if (!known) {
          var groups = (manifest && manifest.groups) || [];
          manifest = {
            name: manifest && manifest.name,
            components: components.concat([
              {
                name: componentName,
                group: group,
                path: "components/" + group + "/" + componentName + "/" + componentName + ".html",
              },
            ]),
            groups: groups.indexOf(group) === -1 ? groups.concat([group]) : groups,
          };
        }
        // Copilot (round 4) — `select()` already renders. Forcing a SECOND render started a second
        // `read_file` and replaced the `pendingSourceRead` the caller awaits below, so a transient
        // failure on that redundant read reported a stale view even when the first read succeeded.
        // Clearing the dedup key makes the single `select()` render perform the fresh read.
        lastRenderedSelectionKey = null;
        select({ group: group, componentName: componentName });
        // `null` means the read failed (or was base64), so the panel is stale — reject, and let
        // the caller turn that into AC14's "written, but the view is stale" note.
        if (!hostBridge) return Promise.resolve();
        return Promise.resolve(pendingSourceRead).then(function (source) {
          if (source === null || source === undefined) {
            throw new Error("could not re-read " + componentName + " after apply");
          }
        });
      },
      teardown: function () {
        if (searchInput) searchInput.removeEventListener("input", onSearchInput);
      },
    };
  }

  // Publish the seam `viewer.js`'s boot path consumes, plus the test-only hooks
  // (same opt-in contract as `viewer.js`: no global write unless a harness has
  // already created the hook object).
  if (typeof window !== "undefined") {
    window.__genieViewerBrowse = {
      initBrowseController: initBrowseController,
    };

    if (window.__genieViewerTestHooks) {
      window.__genieViewerTestHooks.projectManifestToTree = projectManifestToTree;
      window.__genieViewerTestHooks.componentDirFromPath = componentDirFromPath;
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
      window.__genieViewerTestHooks.focusVisibleBrowseNavControl = focusVisibleBrowseNavControl;
    }
  }
})();
