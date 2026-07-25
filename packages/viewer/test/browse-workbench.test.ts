/**
 * M7-02 (#234) — Browse UI-kit workbench unit + DOM suite.
 *
 * Drives the browser-facing `static/viewer.js` script the same way
 * `grid-renderer.test.ts` / `generate-workflow.test.ts` do: evaluate the real
 * classic-script source into a fresh jsdom `window` via `window.eval` and read
 * pure helpers off `window.__genieViewerTestHooks` (see viewer.js's own header
 * for why this isn't a plain `import`).
 *
 * Covers (see plan comment on issue #234 for the full AC mapping):
 *   - `projectManifestToTree` — manifest → tree projection, deterministic
 *     order, group counts, case-insensitive search/filter.
 *   - `resolveSelection` / `serializeSelection` / `parseSelection` — stable
 *     `kitId+group+componentName` identity, deep-link round-trip, kit-change
 *     invalidation, unknown-selection fallback.
 *   - `computeVariantTabs` — Default-only when the manifest carries no
 *     variant data (Decision #5); nothing is fabricated.
 *   - Tree DOM: keyboard nav (Arrow/Home/End/Enter), roles, counts.
 *   - Detail DOM: breadcrumb, metadata, source truncation, Refine handoff.
 *   - States: empty kit, no-match, broken preview, HMR removal.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_JS = readFileSync(resolve(HERE, "../static/viewer.js"), "utf8");
const VIEWER_HTML = readFileSync(resolve(HERE, "../static/index.html"), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Hooks = Record<string, (...args: any[]) => any>;

function loadHooks(url = "https://viewer.example.test/?route=browse") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    url,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dom.window as any).__genieViewerTestHooks = {};
  dom.window.eval(VIEWER_JS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { hooks: (dom.window as any).__genieViewerTestHooks as Hooks, window: dom.window };
}

function loadShell(url = "https://viewer.example.test/?route=browse") {
  const dom = new JSDOM(VIEWER_HTML, { runScripts: "outside-only", url });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dom.window as any).__genieViewerTestHooks = {};
  dom.window.eval(VIEWER_JS);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks: (dom.window as any).__genieViewerTestHooks as Hooks,
    window: dom.window,
    document: dom.window.document,
  };
}

const MANIFEST = {
  version: 1,
  name: "kit",
  generatedAt: "2026-07-01T00:00:00.000Z",
  groups: ["actions", "surfaces"],
  components: [
    {
      name: "Primary buttons",
      group: "actions",
      path: "components/actions/Button/preview.html",
      viewport: "480x240",
      hash: "sha256-AAA=",
      lastModified: "2026-07-01T00:00:00.000Z",
    },
    {
      name: "Card",
      group: "surfaces",
      path: "components/surfaces/Card/preview.html",
      viewport: "480x320",
      hash: "sha256-BBB=",
      lastModified: "2026-07-01T00:00:00.000Z",
      tags: ["container"],
    },
  ],
};

describe("projectManifestToTree", () => {
  it("groups components deterministically with counts and preserves manifest order", () => {
    const { hooks } = loadHooks();
    const tree = hooks.projectManifestToTree(MANIFEST, "");
    expect(tree.groups.map((g: { name: string }) => g.name)).toEqual(["actions", "surfaces"]);
    expect(tree.groups[0].count).toBe(1);
    expect(tree.groups[0].components[0].componentName).toBe("Primary buttons");
    expect(tree.totalCount).toBe(2);
  });

  it("filters case-insensitively across name and group, never mutating the manifest", () => {
    const { hooks } = loadHooks();
    const before = JSON.stringify(MANIFEST);
    const tree = hooks.projectManifestToTree(MANIFEST, "card");
    expect(JSON.stringify(MANIFEST)).toBe(before);
    expect(tree.totalCount).toBe(1);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0].name).toBe("surfaces");
  });

  it("returns an empty-kit tree (zero groups) when the manifest has no components", () => {
    const { hooks } = loadHooks();
    const tree = hooks.projectManifestToTree({ ...MANIFEST, components: [] }, "");
    expect(tree.totalCount).toBe(0);
    expect(tree.groups).toEqual([]);
    expect(tree.isEmptyKit).toBe(true);
  });

  it("distinguishes no-filter-match (kit has data) from an empty kit", () => {
    const { hooks } = loadHooks();
    const tree = hooks.projectManifestToTree(MANIFEST, "zzz-does-not-exist");
    expect(tree.totalCount).toBe(0);
    expect(tree.isEmptyKit).toBe(false);
    expect(tree.isNoMatch).toBe(true);
  });
});

describe("selection identity + deep-link", () => {
  it("resolves a selection by stable kitId+group+componentName, not array index", () => {
    const { hooks } = loadHooks();
    const tree = hooks.projectManifestToTree(MANIFEST, "");
    const resolved = hooks.resolveSelection(tree, {
      kitId: "kit-a",
      group: "surfaces",
      componentName: "Card",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.component.componentName).toBe("Card");
  });

  it("falls back to a controlled not-found state for an unknown selection", () => {
    const { hooks } = loadHooks();
    const tree = hooks.projectManifestToTree(MANIFEST, "");
    const resolved = hooks.resolveSelection(tree, {
      kitId: "kit-a",
      group: "ghost",
      componentName: "Nope",
    });
    expect(resolved.found).toBe(false);
  });

  it("round-trips through URLSearchParams serialize/parse", () => {
    const { hooks } = loadHooks();
    const params = hooks.serializeSelection({
      kitId: "kit-a",
      group: "surfaces",
      componentName: "Card",
    });
    const parsed = hooks.parseSelection(new URLSearchParams(params));
    expect(parsed).toEqual({ kitId: "kit-a", group: "surfaces", componentName: "Card" });
  });

  it("parses a partial/missing deep-link as null rather than throwing", () => {
    const { hooks } = loadHooks();
    expect(hooks.parseSelection(new URLSearchParams("group=surfaces"))).toBeNull();
    expect(hooks.parseSelection(new URLSearchParams(""))).toBeNull();
  });

  it("clears an invalid prior selection when the UI kit changes", () => {
    const { hooks } = loadHooks();
    const tree = hooks.projectManifestToTree(MANIFEST, "");
    const cleared = hooks.selectionForKitChange(tree, {
      kitId: "old-kit",
      group: "surfaces",
      componentName: "Card",
    });
    // A kit change always invalidates the prior selection identity; the
    // caller then either picks a deterministic default or shows "no
    // selection" — this helper only asserts the OLD identity never survives.
    expect(cleared).toBeNull();
  });
});

describe("computeVariantTabs (Decision #5 — no schema invention)", () => {
  it("returns only Default as available; Hover/Focus/Disabled are declared-but-disabled", () => {
    const { hooks } = loadHooks();
    const tabs = hooks.computeVariantTabs({ componentName: "Button" });
    expect(tabs.map((t: { id: string }) => t.id)).toEqual(["default", "hover", "focus", "disabled"]);
    const [def, hover, focus, disabled] = tabs;
    expect(def.available).toBe(true);
    expect(hover.available).toBe(false);
    expect(focus.available).toBe(false);
    expect(disabled.available).toBe(false);
    expect(hover.reason).toMatch(/no variant data/i);
  });
});

describe("sanitizeSourceForDisplay", () => {
  it("truncates large source progressively and reports truncation", () => {
    const { hooks } = loadHooks();
    const big = "a".repeat(10_000);
    const result = hooks.sanitizeSourceForDisplay(big, 100);
    expect(result.text.length).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.totalLength).toBe(10_000);
  });

  it("passes short source through untruncated", () => {
    const { hooks } = loadHooks();
    const result = hooks.sanitizeSourceForDisplay("<script>hi</script>", 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("<script>hi</script>");
  });

  it("never throws on non-string input and renders as unavailable", () => {
    const { hooks } = loadHooks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = hooks.sanitizeSourceForDisplay(undefined as any, 100);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });
});

describe("Browse tree DOM", () => {
  it("renders tree/treeitem roles with group counts and keyboard nav", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const tree = hooks.projectManifestToTree(MANIFEST, "");
    hooks.renderBrowseTree(document, container, tree, null);

    const treeEl = container.querySelector('[role="tree"]');
    expect(treeEl).toBeTruthy();
    const items = container.querySelectorAll('[role="treeitem"]');
    expect(items).toHaveLength(2);
    const labels = container.querySelectorAll(".browse-tree__group-label");
    expect(labels[0].textContent).toContain("1");
    expect(labels[1].textContent).toContain("1");
  });

  it("moves roving focus with ArrowDown/ArrowUp and selects with Enter", () => {
    const { hooks, document, window } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const tree = hooks.projectManifestToTree(MANIFEST, "");
    let selected: unknown = null;
    hooks.renderBrowseTree(document, container, tree, null, (sel: unknown) => {
      selected = sel;
    });

    const items = Array.from(container.querySelectorAll('[role="treeitem"]')) as HTMLElement[];
    items[0].focus();
    items[0].dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(items[1]);
    items[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(selected).toMatchObject({ componentName: "Card", group: "surfaces" });
  });

  it("renders the empty-kit CTA distinctly from the no-match state", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);

    const emptyTree = hooks.projectManifestToTree({ ...MANIFEST, components: [] }, "");
    hooks.renderBrowseTree(document, container, emptyTree, null);
    expect(container.textContent).toMatch(/conjure your first component/i);

    const noMatchTree = hooks.projectManifestToTree(MANIFEST, "zzz-nope");
    hooks.renderBrowseTree(document, container, noMatchTree, "zzz-nope");
    expect(container.textContent).toMatch(/no.*match/i);
    expect(container.querySelector("[data-clear-filter]")).toBeTruthy();
  });
});

describe("Browse detail DOM", () => {
  it("renders breadcrumb, heading, metadata, and disabled variant tabs atomically", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const component = {
      ...MANIFEST.components[0],
      componentName: MANIFEST.components[0].name,
    };
    hooks.renderBrowseDetail(document, container, {
      kitId: "kit-a",
      kitName: "kit",
      component,
      source: null,
      hostAvailable: false,
    });

    expect(container.querySelector(".browse-breadcrumb")?.textContent).toContain("actions");
    expect(container.querySelector(".browse-detail__heading")?.textContent).toContain(
      "Primary buttons",
    );
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(4);
    expect(tabs[1].getAttribute("aria-disabled")).toBe("true");
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.hasAttribute("title")).toBe(true);
  });

  it("shows the @genie marker only when the component is registered/validated", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const component = { ...MANIFEST.components[1], componentName: MANIFEST.components[1].name };
    hooks.renderBrowseDetail(document, container, {
      kitId: "kit-a",
      kitName: "kit",
      component,
      source: null,
      hostAvailable: false,
      registered: true,
    });
    expect(container.querySelector(".genie-marker")).toBeTruthy();
  });

  it("omits the @genie marker and validation badge when not backed by a fact", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const component = { ...MANIFEST.components[1], componentName: MANIFEST.components[1].name };
    hooks.renderBrowseDetail(document, container, {
      kitId: "kit-a",
      kitName: "kit",
      component,
      source: null,
      hostAvailable: false,
    });
    expect(container.querySelector(".genie-marker")).toBeFalsy();
  });

  it("disables Refine and explains why when no MCP-capable host bridge is present", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const component = { ...MANIFEST.components[0], componentName: MANIFEST.components[0].name };
    hooks.renderBrowseDetail(document, container, {
      kitId: "kit-a",
      kitName: "kit",
      component,
      source: null,
      hostAvailable: false,
    });
    const refine = container.querySelector<HTMLButtonElement>("[data-refine-action]");
    expect(refine?.disabled).toBe(true);
    expect(container.textContent).toMatch(/requires an mcp-capable host/i);
  });

  it("renders a neutral 'Preview unavailable' card on iframe load failure without hiding metadata", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const component = { ...MANIFEST.components[0], componentName: MANIFEST.components[0].name };
    hooks.renderBrowseDetail(document, container, {
      kitId: "kit-a",
      kitName: "kit",
      component,
      source: null,
      hostAvailable: false,
    });
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    iframe.dispatchEvent(new (document.defaultView as Window).Event("error"));
    expect(container.querySelector(".browse-preview--broken")).toBeTruthy();
    // Metadata panel must remain present and unaffected.
    expect(container.querySelector(".browse-metadata")).toBeTruthy();
  });

  it("renders a removed-selection state and returns null focus target info when HMR drops the component", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    hooks.renderBrowseDetailRemoved(document, container, {
      componentName: "Ghost",
    });
    expect(container.textContent).toMatch(/no longer available/i);
  });
});

describe("Refine handoff context", () => {
  it("builds a review-bound context transfer object without mutating the component", () => {
    const { hooks } = loadHooks();
    const component = { ...MANIFEST.components[0], componentName: MANIFEST.components[0].name };
    const context = hooks.buildRefineContext("kit-a", component, "default");
    expect(context).toEqual({
      kitId: "kit-a",
      group: "actions",
      componentName: "Primary buttons",
      variant: "default",
    });
  });
});
