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
    expect(tabs.map((t: { id: string }) => t.id)).toEqual([
      "default",
      "hover",
      "focus",
      "disabled",
    ]);
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

describe("renderBrowseTree — roving tabindex (Copilot #9)", () => {
  it("clears the first row's tabindex when a later row is the selection, leaving exactly one Tab stop", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const tree = hooks.projectManifestToTree(MANIFEST, "");
    // "Card" (surfaces group) is NOT the first row ("Primary buttons" is) —
    // this is exactly the two-tab-stop regression Copilot flagged.
    hooks.renderBrowseTree(document, container, tree, null, () => {}, {
      group: "surfaces",
      componentName: "Card",
    });

    const items = Array.from(container.querySelectorAll('[role="treeitem"]')) as HTMLElement[];
    const tabbable = items.filter((item) => item.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].dataset.componentName).toBe("Card");
    // The first row (not selected) must be demoted out of the Tab order.
    const firstRow = items[0];
    expect(firstRow.dataset.componentName).toBe("Primary buttons");
    expect(firstRow.getAttribute("tabindex")).toBe("-1");
  });
});

describe("renderBrowseDetail — iframe/tab a11y wiring (Copilot #10/#18)", () => {
  it("pulls the preview iframe out of Tab order, mirroring createCard's contract", () => {
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
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("tabindex")).toBe("-1");
  });

  it("wires every tab's aria-controls to the single labelled tabpanel preview stage", () => {
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
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[];
    const panel = container.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.id).toBeTruthy();
    for (const tab of tabs) {
      expect(tab.getAttribute("aria-controls")).toBe(panel.id);
      expect(tab.id).toBeTruthy();
    }
    // The panel's accessible name tracks the active (Default) tab.
    const activeTab = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(panel.getAttribute("aria-labelledby")).toBe(activeTab?.id);
  });

  it("shows a distinct loading label until the iframe fires load, then Preview · Default (Copilot #16)", () => {
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
    const label = container.querySelector(".stage-label") as HTMLElement;
    expect(label.textContent).toMatch(/loading/i);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    iframe.dispatchEvent(new (document.defaultView as Window).Event("load"));
    expect(label.textContent).toBe("Preview · Default");
  });

  it("shows a distinct source-loading state, never the failure copy, while a read is in flight (Copilot #17)", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const component = { ...MANIFEST.components[0], componentName: MANIFEST.components[0].name };
    hooks.renderBrowseDetail(document, container, {
      kitId: "kit-a",
      kitName: "kit",
      component,
      source: null,
      sourceLoading: true,
      hostAvailable: true,
    });
    expect(container.textContent).toMatch(/loading source/i);
    expect(container.textContent).not.toMatch(/could not be read/i);
  });
});

describe("initBrowseController — HMR integration (Copilot #15, AC3/AC15)", () => {
  it("selects a component, then an HMR manifest update that removes it shows the removed state and moves focus off the stale row", () => {
    const { hooks, document, window } = loadShell();
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit",
      kitName: "kit",
    });

    // Select "Card" via the rendered tree (mirrors real user interaction,
    // not a direct internal call) so the controller's OWN selection state
    // — not just the pure render helper — is under test.
    controller.update(MANIFEST);
    const cardItem = document.querySelector<HTMLElement>(
      '[role="treeitem"][data-component-name="Card"]',
    );
    expect(cardItem).toBeTruthy();
    cardItem!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(document.querySelector(".browse-breadcrumb")?.textContent).toContain("Card");

    // HMR update: "Card" no longer exists in the manifest, but "Primary
    // buttons" still does.
    const nextManifest = {
      ...MANIFEST,
      components: MANIFEST.components.filter((c) => c.name !== "Card"),
    };
    controller.update(nextManifest);

    expect(document.querySelector(".browse-detail__removed")?.textContent).toMatch(
      /no longer available/i,
    );
    // Focus must move to the nearest valid navigation control (the
    // remaining tree item), never linger on/reference the removed row.
    const activeElement = document.activeElement;
    expect(activeElement?.getAttribute("role")).toBe("treeitem");
    expect(activeElement?.getAttribute("data-component-name")).toBe("Primary buttons");

    controller.teardown();
  });

  it("re-resolves an unrelated selection against the UNFILTERED manifest so a typed filter never shows it as removed (Copilot #6)", () => {
    const { hooks, document } = loadShell();
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit",
      kitName: "kit",
    });
    controller.update(MANIFEST);
    const cardItem = document.querySelector<HTMLElement>(
      '[role="treeitem"][data-component-name="Card"]',
    );
    cardItem!.dispatchEvent(
      new (document.defaultView as Window).MouseEvent("click", { bubbles: true }),
    );
    expect(document.querySelector(".browse-breadcrumb")?.textContent).toContain("Card");

    // Typing a filter that excludes "Card" from the VISIBLE tree must not
    // resolve the selection against the filtered projection — "Card" is
    // still in the manifest, just hidden by the filter.
    const search = document.getElementById("q") as HTMLInputElement;
    search.value = "button";
    search.dispatchEvent(new (document.defaultView as Window).Event("input", { bubbles: true }));

    expect(document.querySelector(".browse-detail__removed")).toBeFalsy();
    expect(document.querySelector(".browse-breadcrumb")?.textContent).toContain("Card");

    controller.teardown();
  });
});

describe("initBrowseController — deep-link kitId guard (Copilot #8)", () => {
  it("serializes kitId into the URL on selection", () => {
    const { hooks, document, window } = loadShell("https://viewer.example.test/?route=browse");
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);
    const cardItem = document.querySelector<HTMLElement>(
      '[role="treeitem"][data-component-name="Card"]',
    );
    cardItem!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const url = new window.URL(window.location.href);
    expect(url.searchParams.get("kitId")).toBe("kit-a");
    expect(url.searchParams.get("group")).toBe("surfaces");
    expect(url.searchParams.get("componentName")).toBe("Card");

    controller.teardown();
  });

  it("ignores an initial deep-link selection whose kitId does not match the current kit", () => {
    const { hooks, document } = loadShell(
      "https://viewer.example.test/?route=browse&kitId=other-kit&group=surfaces&componentName=Card",
    );
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    // The mismatched-kit deep link must NOT resolve — no selection, no
    // "removed" state either (a controlled "nothing selected" placeholder).
    expect(document.querySelector(".browse-breadcrumb")).toBeFalsy();
    expect(document.querySelector(".browse-detail__removed")).toBeFalsy();

    controller.teardown();
  });

  it("honors an initial deep-link selection whose kitId matches the current kit", () => {
    const { hooks, document } = loadShell(
      "https://viewer.example.test/?route=browse&kitId=kit-a&group=surfaces&componentName=Card",
    );
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    expect(document.querySelector(".browse-breadcrumb")?.textContent).toContain("Card");

    controller.teardown();
  });
});

describe("initBrowseController — source read identity + staleness (Copilot #4/#7)", () => {
  it("reads sourcePath (kit-relative identity), not the embedded-rewritten transport path", async () => {
    const { hooks, document, window } = loadShell();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bridge = {
      callTool: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({ content: "export const X = 1;", encoding: "utf-8" });
      },
      destroy: () => {},
    };
    const controller = hooks.initBrowseController(document, {
      hostBridge: bridge,
      kitId: "kit-a",
      kitName: "kit",
    });
    const embeddedManifest = {
      ...MANIFEST,
      components: [
        {
          ...MANIFEST.components[0],
          componentName: MANIFEST.components[0].name,
          path: "data:text/html;base64,AAAA",
          sourcePath: "components/actions/Button/preview.html",
        },
      ],
    };
    controller.update(embeddedManifest);
    const item = document.querySelector<HTMLElement>('[role="treeitem"]');
    item!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // Let the fetchSource promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("mcp__genie__read_file");
    expect(calls[0].args.path).toBe("components/actions/Button/preview.html");

    controller.teardown();
  });

  it("does not commit a stale in-flight source read after a newer HMR update selects fresh content for the same identity", async () => {
    const { hooks, document, window } = loadShell();
    let resolveFirst!: (value: { content: string; encoding: string }) => void;
    let callCount = 0;
    const bridge = {
      callTool: () => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ content: "SECOND", encoding: "utf-8" });
      },
      destroy: () => {},
    };
    const controller = hooks.initBrowseController(document, {
      hostBridge: bridge,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);
    const item = document.querySelector<HTMLElement>('[role="treeitem"]');
    item!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // The first read is now in flight (unresolved). An HMR update re-renders
    // the SAME selected identity — bumping the render generation — before
    // the first read settles.
    controller.update({ ...MANIFEST });

    // Now let the FIRST (stale) read resolve.
    resolveFirst({ content: "STALE", encoding: "utf-8" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The stale content must never have been committed to the DOM.
    expect(document.querySelector(".code-box")?.textContent).not.toBe("STALE");

    controller.teardown();
  });
});

// ── initBrowseController integration (Copilot review #234) ─────────────────
//
// The suite above drives the pure/DOM-render helpers directly; these tests
// instead drive the STATEFUL `initBrowseController` the way `boot()` really
// does — selecting a component, pushing a manifest `update()` that removes
// it (AC3/AC15 HMR selection-removal), and asserting the promised focus
// move — closing the gap Copilot flagged (#15) where only the message
// renderer was exercised.
describe("initBrowseController — HMR selection-removal + focus (AC3/AC15)", () => {
  it("selects a component, then moves focus to the tree and shows the removed state when an HMR update drops it", () => {
    const { hooks, document } = loadShell();
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    const firstItem = document.querySelector<HTMLElement>('[role="treeitem"]');
    expect(firstItem).toBeTruthy();
    firstItem!.click();
    expect(document.querySelector(".browse-breadcrumb")?.textContent).toContain("Primary buttons");

    // HMR update removing the selected component ("Primary buttons").
    const withoutSelected = {
      ...MANIFEST,
      components: MANIFEST.components.filter((c) => c.name !== "Primary buttons"),
    };
    controller.update(withoutSelected);

    expect(document.querySelector("#browse-detail")?.textContent).toMatch(/no longer available/i);
    // Focus moved to the nearest valid navigation control (the remaining
    // tabbable tree item), never left stranded on a now-removed row.
    const activeItem = document.activeElement;
    expect(activeItem?.getAttribute("role")).toBe("treeitem");

    controller.teardown();
  });

  it("re-resolves the SAME selection after a manifest update that keeps it, without resetting the active filter", () => {
    const { hooks, document } = loadShell();
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();

    const search = document.getElementById("q") as HTMLInputElement;
    search.value = "card";
    search.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));

    // A content-only HMR update (hash change) must not clear the selection
    // or the active filter (Copilot #6/#7 regression guard).
    const updated = {
      ...MANIFEST,
      components: MANIFEST.components.map((c) =>
        c.name === "Card" ? { ...c, hash: "sha256-NEW=" } : c,
      ),
    };
    controller.update(updated);

    expect(document.querySelector(".browse-breadcrumb")?.textContent).toContain("Card");
    expect(search.value).toBe("card");

    controller.teardown();
  });

  it("resolves selection against the UNFILTERED manifest, not the filtered tree (Copilot #6)", () => {
    const { hooks, document } = loadShell();
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();
    expect(document.querySelector(".browse-breadcrumb")?.textContent).toContain("Card");

    // Typing a filter that excludes the selected component must NOT show
    // the "no longer available" HMR-removal state — the component is still
    // in the manifest, merely filtered out of the visible tree list.
    const search = document.getElementById("q") as HTMLInputElement;
    search.value = "does-not-match-card";
    search.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));

    expect(document.querySelector("#browse-detail")?.textContent).not.toMatch(
      /no longer available/i,
    );
    expect(document.querySelector(".browse-breadcrumb")?.textContent).toContain("Card");

    controller.teardown();
  });

  it("only commits the LATEST source read when HMR replaces the selected component while an older read is in flight (Copilot #7)", async () => {
    const { hooks, document } = loadShell();
    const reads: Array<{ path: string; resolve: (v: { content: string }) => void }> = [];
    const hostBridge = {
      callTool: (_name: string, args: { path: string }) =>
        new Promise((resolve) => {
          reads.push({ path: args.path, resolve });
        }),
      destroy: () => {},
    };
    const controller = hooks.initBrowseController(document, {
      hostBridge,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();
    expect(reads).toHaveLength(1);

    // HMR replaces the SAME selected component's content (identity
    // unchanged) while the first read is still in flight — a second read
    // for the new content starts.
    const updated = {
      ...MANIFEST,
      components: MANIFEST.components.map((c) =>
        c.name === "Card"
          ? { ...c, hash: "sha256-NEW=", path: "components/surfaces/Card/preview.html" }
          : c,
      ),
    };
    controller.update(updated);
    expect(reads).toHaveLength(2);

    // Resolve the OLDER (stale) read AFTER the newer one — a plain identity
    // check alone (group+componentName) would let this stale content win.
    reads[1].resolve({ content: "NEW SOURCE" });
    await Promise.resolve();
    await Promise.resolve();
    reads[0].resolve({ content: "STALE SOURCE" });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector(".code-box")?.textContent).toBe("NEW SOURCE");

    controller.teardown();
  });

  it("serializes kitId into the deep-link URL and rejects a link whose kitId does not match the current kit (Copilot #8)", () => {
    const { hooks, document, window } = loadShell(
      "https://viewer.example.test/?route=browse&kitId=other-kit&group=surfaces&componentName=Card",
    );
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    // A deep-link minted for a DIFFERENT kit must not resolve against this
    // kit's same-named component.
    expect(document.querySelector(".browse-breadcrumb")).toBeFalsy();

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();
    const url = new window.URL(window.location.href);
    expect(url.searchParams.get("kitId")).toBe("kit-a");
    expect(url.searchParams.get("group")).toBe("surfaces");
    expect(url.searchParams.get("componentName")).toBe("Card");

    controller.teardown();
  });

  it("passes the Refine context through to onRefine and routes to Review (Copilot #5)", () => {
    const { hooks, document, window } = loadShell();
    let received: unknown = null;
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
      onRefine: (context: unknown) => {
        received = context;
      },
    });
    controller.update(MANIFEST);
    // Refine requires a REAL MCP-App host, signaled only via `setHostBridge`
    // (see PR #248 review — AC13). Passing `hostBridge` at construction is
    // what the standalone tier's source-read-only adapter also does, and
    // must NOT by itself enable Refine.
    controller.setHostBridge({ callTool: () => Promise.resolve({}), destroy: () => {} });

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();

    const refineButton = document.querySelector<HTMLButtonElement>("[data-refine-action]");
    refineButton!.click();

    expect(received).toMatchObject({ kitId: "kit-a", group: "surfaces", componentName: "Card" });
    expect(new window.URL(window.location.href).searchParams.get("route")).toBe("review");

    controller.teardown();
  });

  it("reads sourcePath (not the rewritten embedded transport path) for host source inspection (Copilot #4)", async () => {
    const { hooks, document } = loadShell();
    const calls: Array<{ path: string }> = [];
    const hostBridge = {
      callTool: (_name: string, args: { path: string }) => {
        calls.push(args);
        return Promise.resolve({ content: "source text" });
      },
      destroy: () => {},
    };
    const embeddedManifest = {
      ...MANIFEST,
      components: MANIFEST.components.map((c) => ({
        ...c,
        path: "https://cdn.example.test/blob/abc123", // rewritten transport URL
        sourcePath: c.path, // original kit-relative identity
      })),
    };
    const controller = hooks.initBrowseController(document, {
      hostBridge,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(embeddedManifest);

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("components/surfaces/Card/preview.html");

    controller.teardown();
  });

  it("shows a distinct loading state (not the failure copy) before a host source read settles (Copilot #17)", () => {
    const { hooks, document } = loadShell();
    const hostBridge = {
      callTool: () => new Promise(() => {}), // never resolves within this test
      destroy: () => {},
    };
    const controller = hooks.initBrowseController(document, {
      hostBridge,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();

    const sourceText = document.querySelector(".browse-source")?.textContent ?? "";
    expect(sourceText).toMatch(/loading/i);
    expect(sourceText).not.toMatch(/could not be read/i);

    controller.teardown();
  });

  it("standalone Browse (createStandaloneSourceBridge) supports source inspection via a same-origin relative fetch (Copilot #3, AC13)", async () => {
    const { hooks } = loadHooks();
    const fetchCalls: string[] = [];
    const fetchImpl = (url: string) => {
      fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("standalone source"),
      });
    };
    const bridge = hooks.createStandaloneSourceBridge(fetchImpl);
    const result = await bridge.callTool("mcp__genie__read_file", {
      path: "components/surfaces/Card/preview.html",
    });
    expect(fetchCalls).toEqual(["components/surfaces/Card/preview.html"]);
    expect(result).toEqual({ content: "standalone source" });
  });

  it("createStandaloneSourceBridge refuses unsafe/absolute/traversal paths (AC16)", async () => {
    const { hooks } = loadHooks();
    const bridge = hooks.createStandaloneSourceBridge(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("nope") }),
    );
    await expect(
      bridge.callTool("mcp__genie__read_file", { path: "../../etc/passwd" }),
    ).rejects.toThrow();
    await expect(
      bridge.callTool("mcp__genie__read_file", { path: "/etc/passwd" }),
    ).rejects.toThrow();
    await expect(
      bridge.callTool("mcp__genie__read_file", { path: "https://evil.example/x" }),
    ).rejects.toThrow();
  });
});

describe("renderBrowseTree — roving tabindex (Copilot #9)", () => {
  it("demotes the first row's tabindex when a LATER row is selected, leaving exactly one tab stop", () => {
    const { hooks, document } = loadShell();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const tree = hooks.projectManifestToTree(MANIFEST, "");
    // "Card" (surfaces) is the SECOND rendered row; select it.
    hooks.renderBrowseTree(document, container, tree, null, () => {}, {
      group: "surfaces",
      componentName: "Card",
    });

    const items = Array.from(container.querySelectorAll('[role="treeitem"]')) as HTMLElement[];
    const zeroTabIndex = items.filter((el) => el.getAttribute("tabindex") === "0");
    expect(zeroTabIndex).toHaveLength(1);
    expect(zeroTabIndex[0].dataset.componentName).toBe("Card");
  });
});

describe("renderBrowseDetail — preview iframe tabindex + tab semantics (Copilot #10/#18)", () => {
  it("keeps the preview iframe out of Tab order like createCard's iframe", () => {
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
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("tabindex")).toBe("-1");
  });

  it("wires each variant tab's aria-controls to the labelled tabpanel preview stage", () => {
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
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[];
    const panel = container.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(panel).toBeTruthy();
    for (const tab of tabs) {
      expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    }
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
  });

  it("shows a loading preview label until the iframe load event fires (Copilot #16)", () => {
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
    const label = container.querySelector(".stage-label");
    expect(label?.textContent).toMatch(/loading/i);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    iframe.dispatchEvent(new (document.defaultView as Window).Event("load"));
    expect(label?.textContent).toBe("Preview · Default");
  });
});

describe("extractToolResultManifest (Copilot #1 — embedded workbench sync)", () => {
  it("extracts the embedded manifest from _meta the same way renderToolResult does", () => {
    const { hooks } = loadHooks();
    const result = {
      structuredContent: {},
      _meta: {
        "genie/embeddedManifest": {
          ...MANIFEST,
          components: MANIFEST.components.map((c) => ({
            ...c,
            path: "https://cdn.example.test/x",
          })),
        },
      },
    };
    const manifest = hooks.extractToolResultManifest(result);
    expect(manifest).toBeTruthy();
    expect(manifest.components).toHaveLength(2);
  });

  it("returns null when there is no usable embedded manifest", () => {
    const { hooks } = loadHooks();
    expect(hooks.extractToolResultManifest({ structuredContent: {} })).toBeNull();
    expect(hooks.extractToolResultManifest(null)).toBeNull();
  });
});

describe("initBrowseController — keyboard focus restore on select (Copilot #22)", () => {
  it("keeps keyboard focus on the newly selected treeitem after renderAll rebuilds the tree DOM", () => {
    const { hooks, document } = loadShell();
    const controller = hooks.initBrowseController(document, {
      hostBridge: null,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();

    // `renderAll()` (triggered by `select()`) replaces the tree's children
    // wholesale, detaching the item that was originally clicked/focused.
    // Without an explicit focus restore, `document.activeElement` falls back
    // to <body> here — this regression-guards Copilot #22.
    const active = document.activeElement;
    expect(active?.getAttribute("role")).toBe("treeitem");
    expect((active as HTMLElement | null)?.dataset.componentName).toBe("Card");

    controller.teardown();
  });
});

describe("initBrowseController — search filtering does not re-fetch source (Copilot #24)", () => {
  it("does not re-render the detail panel or re-issue a source read on a search keystroke that leaves the selection unchanged", () => {
    const { hooks, document } = loadShell();
    const calls: Array<{ path: string }> = [];
    const hostBridge = {
      callTool: (_name: string, args: { path: string }) => {
        calls.push(args);
        return Promise.resolve({ content: "source text" });
      },
      destroy: () => {},
    };
    const controller = hooks.initBrowseController(document, {
      hostBridge,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();
    expect(calls).toHaveLength(1);

    const iframeBeforeFilter = document.querySelector(".preview-stage iframe");

    // Typing a filter that still matches the selected component ("Card")
    // must only refresh the tree list, never re-render the detail panel or
    // re-issue a `mcp__genie__read_file` call for the unchanged selection.
    const search = document.getElementById("q") as HTMLInputElement;
    search.value = "card";
    search.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));

    expect(calls).toHaveLength(1);
    expect(document.querySelector(".preview-stage iframe")).toBe(iframeBeforeFilter);

    controller.teardown();
  });

  it("still re-fetches source for an HMR content update to the SAME selected component (force render)", async () => {
    const { hooks, document } = loadShell();
    const calls: Array<{ path: string }> = [];
    const hostBridge = {
      callTool: (_name: string, args: { path: string }) => {
        calls.push(args);
        return Promise.resolve({ content: "source text" });
      },
      destroy: () => {},
    };
    const controller = hooks.initBrowseController(document, {
      hostBridge,
      kitId: "kit-a",
      kitName: "kit",
    });
    controller.update(MANIFEST);

    const cardItem = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (el) => el.dataset.componentName === "Card",
    );
    cardItem!.click();
    expect(calls).toHaveLength(1);

    // A content-only HMR update to the SAME selected component must still
    // trigger a fresh detail render/source read — the search-filter dedup
    // (Copilot #24) must not silently swallow this legitimate refresh.
    const updated = {
      ...MANIFEST,
      components: MANIFEST.components.map((c) =>
        c.name === "Card" ? { ...c, hash: "sha256-NEW=" } : c,
      ),
    };
    controller.update(updated);

    expect(calls).toHaveLength(2);

    controller.teardown();
  });
});
