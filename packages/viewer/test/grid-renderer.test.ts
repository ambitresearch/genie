/**
 * M4-03 (DRO-265) — viewer grid renderer unit suite.
 *
 * Drives the browser-facing `static/viewer.js` script in a *programmatic*
 * jsdom window (a fresh `JSDOM` per test), exactly like the server package's
 * `*-preview-host.test.ts` files: the repo's default vitest environment is
 * `node`, and switching the global environment for one suite is heavier than
 * newing up a `JSDOM` and passing its `document` into the (deliberately pure,
 * `document`-injected) render functions.
 *
 * ── Why `window.eval`, not `import` (DRO-749) ──────────────────────────────
 * `viewer.js` is a CLASSIC script, not an ES module (see its own header): a
 * module's relative-`src` fetch is rejected by the browser under `file://`,
 * which broke the `file://` vehicle when this file briefly shipped as
 * `type="module"`. A classic script has no `export`s to `import`, so this
 * suite instead evaluates the real file's source text into a fresh jsdom
 * `window` via `window.eval` — the same execution path a real `<script src>`
 * takes — and reads its pure helpers off `window.__genieViewerTestHooks`,
 * a seam `viewer.js` only populates when that object already exists before
 * it runs (see its header). Production pages never define it.
 *
 * AC coverage map (DRO-265):
 *   - AC1 — asserted in `static-index.test.ts` (the HTML shell), not here.
 *   - AC2 — `renderGrid` groups by `component.group` and sizes each card's
 *           iframe from the manifest `viewport`; group section order follows
 *           the manifest's own `groups[]` (DRO-749 fix — see
 *           `computeGroupOrder`).
 *   - AC3 — every iframe is `sandbox="allow-scripts"` and NEVER carries
 *           `allow-same-origin` (defence in depth).
 *   - AC4 — every iframe is `loading="lazy"`.
 *   - AC5 — `applyFilter` hides/shows cards by a case-insensitive `name`
 *           substring; `boot` wires it to the `#q` input.
 *   - AC6 — an empty manifest renders a visible empty state and zero iframes.
 *   - AC7 — asserted in `static-index.test.ts` (the CSS `minmax(320px,1fr)`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(HERE, "../static");
const VIEWER_JS = readFileSync(resolve(STATIC_DIR, "viewer.js"), "utf8");

// ── Fixtures ────────────────────────────────────────────────────────────────

interface ManifestCard {
  name: string;
  group: string;
  path: string;
  viewport: string;
  hash: string;
  lastModified: string;
}

interface ViewerManifest {
  version: 1;
  name: string;
  generatedAt: string;
  groups: string[];
  components: ManifestCard[];
}

function card(overrides: Partial<ManifestCard> = {}): ManifestCard {
  return {
    name: "Primary buttons",
    group: "actions",
    path: "components/actions/Button/preview.html",
    viewport: "480x240",
    hash: "sha256-x",
    lastModified: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(components: ManifestCard[], groupsOverride?: string[]): ViewerManifest {
  const groups = groupsOverride ?? [...new Set(components.map((c) => c.group))];
  return {
    version: 1,
    name: "kit",
    generatedAt: "2026-07-01T00:00:00.000Z",
    groups,
    components,
  };
}

/** A realistic two-group manifest mirroring the M4-02 test fixture. */
function twoGroupManifest(): ViewerManifest {
  return manifest([
    card({ name: "Primary buttons", group: "actions", viewport: "480x240" }),
    card({
      name: "Card",
      group: "surfaces",
      path: "components/surfaces/Card/preview.html",
      viewport: "480x320",
    }),
  ]);
}

// ── Harness: evaluate the real static/viewer.js in a fresh jsdom window ────

/**
 * Hook surface `viewer.js` populates on `window.__genieViewerTestHooks` when
 * that object is pre-defined (see the file's header). Typed loosely (`any`
 * function signatures) since this is a test-only seam onto a plain-JS file,
 * not a public API — the individual `it()` blocks pin down each function's
 * real contract via assertions instead of via the type checker.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Hooks = Record<string, any>;

/**
 * Evaluate the real `viewer.js` source into a fresh jsdom `Document`/`window`
 * and return its exposed test hooks. Each test gets an independent window
 * (mirroring the previous `beforeEach(() => new JSDOM(...))` pattern), since
 * `viewer.js` wraps itself in an IIFE with no external teardown.
 */
function loadHooks(): { hooks: Hooks; window: JSDOM["window"]; document: Document } {
  const dom = new JSDOM(
    '<!doctype html><html><body><input id="q" /><main id="grid"></main></body></html>',
    { runScripts: "outside-only" },
  );
  const { window } = dom;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__genieViewerTestHooks = {};
  window.eval(VIEWER_JS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { hooks: (window as any).__genieViewerTestHooks, window, document: window.document };
}

// ── MANIFEST_URL ────────────────────────────────────────────────────────────

describe("MANIFEST_URL", () => {
  it("points at the real M3-03 compiler output path (.genie/manifest.json)", () => {
    // The AC sketch says `./manifest.json`, but the SHIPPED compiler writes
    // `.genie/manifest.json` (see server/manifest/compiler.ts + viewer/cli.ts
    // MANIFEST_RELATIVE_PATH). The viewer must fetch the real location.
    const { hooks } = loadHooks();
    expect(hooks.MANIFEST_URL).toBe(".genie/manifest.json");
  });
});

// ── parseViewport (AC2 viewport sizing) ─────────────────────────────────────

describe("parseViewport", () => {
  it("parses a WxH token into integers", () => {
    const { hooks } = loadHooks();
    expect(hooks.parseViewport("480x240")).toEqual({ width: 480, height: 240 });
    expect(hooks.parseViewport("1024x768")).toEqual({ width: 1024, height: 768 });
  });

  it("returns null for a named token like 'desktop'", () => {
    const { hooks } = loadHooks();
    expect(hooks.parseViewport("desktop")).toBeNull();
  });

  it("returns null for an empty or missing viewport", () => {
    const { hooks } = loadHooks();
    expect(hooks.parseViewport("")).toBeNull();
    expect(hooks.parseViewport(undefined)).toBeNull();
  });

  it("returns null for a malformed WxH token", () => {
    const { hooks } = loadHooks();
    expect(hooks.parseViewport("12x")).toBeNull();
    expect(hooks.parseViewport("x240")).toBeNull();
    expect(hooks.parseViewport("480X240 extra")).toBeNull();
    expect(hooks.parseViewport("480x240x100")).toBeNull();
    expect(hooks.parseViewport("4.5x2")).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    const { hooks } = loadHooks();
    expect(hooks.parseViewport("  480x240  ")).toEqual({ width: 480, height: 240 });
  });

  it("returns null for a degenerate zero/non-positive dimension", () => {
    // A 0-size iframe would render invisible; treat it like a named token and
    // let createCard fall back to the default height.
    const { hooks } = loadHooks();
    expect(hooks.parseViewport("0x0")).toBeNull();
    expect(hooks.parseViewport("480x0")).toBeNull();
    expect(hooks.parseViewport("0x240")).toBeNull();
  });
});

// ── groupByGroup (AC2 grouping) ─────────────────────────────────────────────

describe("groupByGroup", () => {
  it("buckets components by their group, preserving first-seen group order", () => {
    const { hooks } = loadHooks();
    const grouped = hooks.groupByGroup([
      card({ name: "A", group: "actions" }),
      card({ name: "S", group: "surfaces" }),
      card({ name: "B", group: "actions" }),
    ]);
    expect([...grouped.keys()]).toEqual(["actions", "surfaces"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(grouped.get("actions")?.map((c: any) => c.name)).toEqual(["A", "B"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(grouped.get("surfaces")?.map((c: any) => c.name)).toEqual(["S"]);
  });

  it("returns an empty map for zero components", () => {
    const { hooks } = loadHooks();
    expect(hooks.groupByGroup([]).size).toBe(0);
  });
});

// ── computeGroupOrder (AC2 — DRO-749 fix: honour manifest.groups[]) ─────────

describe("computeGroupOrder", () => {
  it("prefers the manifest's declared groups[] order over first-seen order", () => {
    const { hooks } = loadHooks();
    const grouped = hooks.groupByGroup([
      card({ name: "S", group: "surfaces" }),
      card({ name: "A", group: "actions" }),
    ]);
    // Cards arrive surfaces-then-actions, but groups[] pins actions first —
    // the compiler already resolved _groups.json pinning server-side; the
    // viewer must not re-derive a different order from first-seen cards.
    expect(hooks.computeGroupOrder(["actions", "surfaces"], grouped)).toEqual([
      "actions",
      "surfaces",
    ]);
  });

  it("falls back to first-seen-among-grouped order when groups[] is absent", () => {
    const { hooks } = loadHooks();
    const grouped = hooks.groupByGroup([
      card({ name: "S", group: "surfaces" }),
      card({ name: "A", group: "actions" }),
    ]);
    expect(hooks.computeGroupOrder(undefined, grouped)).toEqual(["surfaces", "actions"]);
  });

  it("falls back when groups[] is present but empty", () => {
    const { hooks } = loadHooks();
    const grouped = hooks.groupByGroup([card({ group: "actions" })]);
    expect(hooks.computeGroupOrder([], grouped)).toEqual(["actions"]);
  });

  it("falls back when groups[] is malformed (not an array)", () => {
    const { hooks } = loadHooks();
    const grouped = hooks.groupByGroup([card({ group: "actions" })]);
    expect(hooks.computeGroupOrder("not-an-array", grouped)).toEqual(["actions"]);
  });

  it("ignores non-string / duplicate entries within a declared groups[]", () => {
    const { hooks } = loadHooks();
    const grouped = hooks.groupByGroup([
      card({ group: "actions" }),
      card({ group: "surfaces" }),
    ]);
    expect(hooks.computeGroupOrder(["actions", "actions", 42, "surfaces"], grouped)).toEqual([
      "actions",
      "surfaces",
    ]);
  });

  it("includes a group named in groups[] even if it has zero components (caller skips rendering it)", () => {
    // computeGroupOrder itself doesn't know about component counts — it's
    // renderGrid's job to skip a group whose Map lookup misses. Documented
    // here so the two functions' contracts stay clear at the seam.
    const { hooks } = loadHooks();
    const grouped = hooks.groupByGroup([card({ group: "actions" })]);
    expect(hooks.computeGroupOrder(["actions", "layout"], grouped)).toEqual(["actions", "layout"]);
  });
});

// ── createCard (AC2/AC3/AC4 per-card contract) ──────────────────────────────

describe("createCard", () => {
  it("renders an <iframe> whose src is the component path", () => {
    const { hooks, document } = loadHooks();
    const el = hooks.createCard(document, card({ path: "components/actions/Button/preview.html" }));
    const iframe = el.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("src")).toBe("components/actions/Button/preview.html");
  });

  it("AC3 — sandboxes the iframe as allow-scripts only (never allow-same-origin)", () => {
    const { hooks, document } = loadHooks();
    const iframe = hooks.createCard(document, card()).querySelector("iframe") as HTMLIFrameElement;
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox.split(/\s+/)).toContain("allow-scripts");
    expect(sandbox).not.toMatch(/allow-same-origin/);
  });

  it("AC4 — marks the iframe loading=lazy", () => {
    const { hooks, document } = loadHooks();
    const iframe = hooks.createCard(document, card()).querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("loading")).toBe("lazy");
  });

  it("AC2 — sizes the iframe height from a WxH viewport", () => {
    const { hooks, document } = loadHooks();
    const iframe = hooks
      .createCard(document, card({ viewport: "480x240" }))
      .querySelector("iframe") as HTMLIFrameElement;
    // height attribute reflects the parsed viewport height for intrinsic ratio.
    expect(iframe.getAttribute("height")).toBe("240");
    expect(iframe.getAttribute("width")).toBe("480");
  });

  it("AC2 — falls back to a default height for a named/unparseable viewport", () => {
    const { hooks, document } = loadHooks();
    const iframe = hooks
      .createCard(document, card({ viewport: "desktop" }))
      .querySelector("iframe") as HTMLIFrameElement;
    // No crash, no NaN: a sane default height, and no fixed width attr.
    const h = Number(iframe.getAttribute("height"));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
    expect(iframe.getAttribute("width")).toBeNull();
  });

  it("exposes the component name for the search filter (data-name, lowercased)", () => {
    const { hooks, document } = loadHooks();
    const el = hooks.createCard(document, card({ name: "Primary Buttons" }));
    expect(el.getAttribute("data-name")).toBe("primary buttons");
  });

  it("shows the component name and group as visible card chrome", () => {
    const { hooks, document } = loadHooks();
    const el = hooks.createCard(document, card({ name: "Primary buttons", group: "actions" }));
    expect(el.textContent).toContain("Primary buttons");
  });
});

// ── renderGrid (AC2/AC6) ────────────────────────────────────────────────────

describe("renderGrid", () => {
  it("AC2 — renders one section per group with the cards under it", () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    hooks.renderGrid(document, grid, twoGroupManifest());

    const sections = grid.querySelectorAll("section");
    expect(sections.length).toBe(2);

    // Each section is labelled with its group and holds the right cards.
    const actions = grid.querySelector('section[data-group="actions"]') as HTMLElement;
    const surfaces = grid.querySelector('section[data-group="surfaces"]') as HTMLElement;
    expect(actions).not.toBeNull();
    expect(surfaces).not.toBeNull();
    expect(actions.querySelectorAll("iframe").length).toBe(1);
    expect(surfaces.querySelectorAll("iframe").length).toBe(1);
    expect(actions.textContent).toContain("actions");
  });

  it("AC2 (DRO-749) — section order follows manifest.groups[], not first-seen card order", () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    // Cards arrive [surfaces, actions] but groups[] pins [actions, surfaces].
    const pinned = manifest(
      [
        card({ name: "Card", group: "surfaces", path: "components/surfaces/Card/preview.html" }),
        card({ name: "Button", group: "actions" }),
      ],
      ["actions", "surfaces"],
    );
    hooks.renderGrid(document, grid, pinned);
    const sections = [...grid.querySelectorAll("section")];
    expect(sections.map((s) => s.getAttribute("data-group"))).toEqual(["actions", "surfaces"]);
  });

  it("omits a declared-but-now-empty group from groups[] rather than rendering an empty section", () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    const withStaleGroup = manifest([card({ group: "actions" })], ["actions", "layout"]);
    hooks.renderGrid(document, grid, withStaleGroup);
    const sections = grid.querySelectorAll("section");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.getAttribute("data-group")).toBe("actions");
  });

  it("AC3/AC4 — every rendered iframe is lazy + allow-scripts, no allow-same-origin", () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    hooks.renderGrid(document, grid, twoGroupManifest());
    const iframes = [...grid.querySelectorAll("iframe")];
    expect(iframes.length).toBe(2);
    for (const f of iframes) {
      expect(f.getAttribute("loading")).toBe("lazy");
      expect((f.getAttribute("sandbox") ?? "").split(/\s+/)).toContain("allow-scripts");
      expect(f.getAttribute("sandbox") ?? "").not.toMatch(/allow-same-origin/);
    }
  });

  it("clears any prior render before drawing (idempotent re-render)", () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    hooks.renderGrid(document, grid, twoGroupManifest());
    hooks.renderGrid(document, grid, twoGroupManifest());
    // Not doubled: still exactly 2 iframes, 2 sections.
    expect(grid.querySelectorAll("iframe").length).toBe(2);
    expect(grid.querySelectorAll("section").length).toBe(2);
  });

  it("AC6 — an empty manifest renders a visible empty state and no iframes", () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    hooks.renderGrid(document, grid, manifest([]));
    expect(grid.querySelectorAll("iframe").length).toBe(0);
    const empty = grid.querySelector(".ds-empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.toLowerCase()).toContain("no components");
  });
});

// ── applyFilter (AC5) ───────────────────────────────────────────────────────

describe("applyFilter", () => {
  function setupFiltered(): { hooks: Hooks; grid: HTMLElement } {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    hooks.renderGrid(document, grid, twoGroupManifest());
    return { hooks, grid };
  }

  function visibleNames(grid: HTMLElement): string[] {
    return [...grid.querySelectorAll("[data-name]")]
      .filter((el) => !(el as HTMLElement).hidden)
      .map((el) => el.getAttribute("data-name") ?? "");
  }

  it("AC5 — filters cards by a case-insensitive name substring", () => {
    const { hooks, grid } = setupFiltered();
    hooks.applyFilter(grid, "prim");
    expect(visibleNames(grid)).toEqual(["primary buttons"]);
  });

  it("AC5 — matches regardless of query case", () => {
    const { hooks, grid } = setupFiltered();
    hooks.applyFilter(grid, "CARD");
    expect(visibleNames(grid)).toEqual(["card"]);
  });

  it("AC5 — an empty query reveals every card", () => {
    const { hooks, grid } = setupFiltered();
    hooks.applyFilter(grid, "prim");
    hooks.applyFilter(grid, "");
    expect(visibleNames(grid).sort()).toEqual(["card", "primary buttons"]);
  });

  it("AC5 — hides a group section when it has no matching cards", () => {
    const { hooks, grid } = setupFiltered();
    hooks.applyFilter(grid, "prim");
    const surfaces = grid.querySelector('section[data-group="surfaces"]') as HTMLElement;
    const actions = grid.querySelector('section[data-group="actions"]') as HTMLElement;
    expect(surfaces.hidden).toBe(true);
    expect(actions.hidden).toBe(false);
  });

  it("AC5 — a query matching nothing hides all cards and all sections", () => {
    const { hooks, grid } = setupFiltered();
    hooks.applyFilter(grid, "zzz-no-match");
    expect(visibleNames(grid)).toEqual([]);
    for (const s of grid.querySelectorAll("section")) {
      expect((s as HTMLElement).hidden).toBe(true);
    }
  });
});

// ── boot (integration: fetch → render → wire search) ────────────────────────

describe("boot", () => {
  function fakeFetch(payload: unknown, ok = true) {
    return async (_url: string) =>
      ({
        ok,
        status: ok ? 200 : 404,
        json: async () => payload,
      }) as Response;
  }

  it("fetches the manifest URL and renders the grid", async () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    const seen: string[] = [];
    const f = async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => twoGroupManifest() } as Response;
    };

    await hooks.boot(document, f);

    expect(seen).toEqual([hooks.MANIFEST_URL]);
    expect(grid.querySelectorAll("iframe").length).toBe(2);
  });

  it("AC5 — wires the #q input so typing filters the grid live", async () => {
    const { hooks, document, window } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    await hooks.boot(document, fakeFetch(twoGroupManifest()));

    const q = document.getElementById("q") as HTMLInputElement;
    q.value = "prim";
    q.dispatchEvent(new window.Event("input", { bubbles: true }));

    const visible = [...grid.querySelectorAll("[data-name]")].filter(
      (el) => !(el as HTMLElement).hidden,
    );
    expect(visible.map((el) => el.getAttribute("data-name"))).toEqual(["primary buttons"]);
  });

  it("AC6 — boot with an empty manifest shows the empty state", async () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    await hooks.boot(document, fakeFetch(manifest([])));
    expect(grid.querySelector(".ds-empty")).not.toBeNull();
    expect(grid.querySelectorAll("iframe").length).toBe(0);
  });

  it("renders a visible error state (not a thrown error) when the fetch fails", async () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    const f = async () => {
      throw new Error("network down");
    };
    await expect(hooks.boot(document, f)).resolves.toBeUndefined();
    const err = grid.querySelector(".ds-error");
    expect(err).not.toBeNull();
    expect(err?.textContent?.toLowerCase()).toContain("could not load");
  });

  it("renders the error state when the manifest responds non-ok", async () => {
    const { hooks, document } = loadHooks();
    const grid = document.getElementById("grid") as HTMLElement;
    await hooks.boot(document, fakeFetch({}, false));
    expect(grid.querySelector(".ds-error")).not.toBeNull();
    expect(grid.querySelectorAll("iframe").length).toBe(0);
  });
});

// ── Security: textContent, never innerHTML, for user-controlled strings ────

describe("XSS safety — card name rendered as inert text", () => {
  it("a hostile card name renders as literal text, not markup", () => {
    const { hooks, document, window } = loadHooks();
    const hostile = card({ name: '<img src=x onerror="window.__pwned=1">' });
    const el = hooks.createCard(document, hostile);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__pwned).toBeUndefined();
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".ds-card__name")?.textContent).toBe(hostile.name);
  });
});
