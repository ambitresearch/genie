/**
 * M4-03 (DRO-265) — viewer grid renderer unit suite.
 *
 * Drives the browser-facing `static/viewer.js` module in a *programmatic* jsdom
 * window (a fresh `JSDOM` per test), exactly like the server package's
 * `*-preview-host.test.ts` files: the repo's default vitest environment is
 * `node`, and switching the global environment for one suite is heavier than
 * newing up a `JSDOM` and passing its `document` into the (deliberately pure,
 * `document`-injected) render functions.
 *
 * WHY the module is importable from a node-env test at all: `viewer.js` exports
 * pure helpers (`parseViewport`, `groupByGroup`, `createCard`, `renderGrid`,
 * `applyFilter`, `boot`) that take a `Document` + `fetch` as parameters, and its
 * only side-effecting line — the browser auto-boot — is guarded by
 * `typeof document !== "undefined"`, which is false under node. So importing it
 * runs no DOM code; every test supplies its own jsdom `document`.
 *
 * AC coverage map (DRO-265):
 *   - AC1 — asserted in `static-index.test.ts` (the HTML shell), not here.
 *   - AC2 — `renderGrid` groups by `component.group` and sizes each card's
 *           iframe from the manifest `viewport`.
 *   - AC3 — every iframe is `sandbox="allow-scripts"` and NEVER carries
 *           `allow-same-origin` (defence in depth).
 *   - AC4 — every iframe is `loading="lazy"`.
 *   - AC5 — `applyFilter` hides/shows cards by a case-insensitive `name`
 *           substring; `boot` wires it to the `#q` input.
 *   - AC6 — an empty manifest renders a visible empty state and zero iframes.
 *   - AC7 — asserted in `static-index.test.ts` (the CSS `minmax(320px,1fr)`).
 */
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MANIFEST_URL,
  parseViewport,
  groupByGroup,
  createCard,
  renderGrid,
  applyFilter,
  boot,
  type ManifestCard,
  type ViewerManifest,
} from "../static/viewer.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

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

function manifest(components: ManifestCard[]): ViewerManifest {
  const groups = [...new Set(components.map((c) => c.group))];
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

let dom: JSDOM;
let doc: Document;
let grid: HTMLElement;

beforeEach(() => {
  dom = new JSDOM(
    '<!doctype html><html><body><input id="q" /><main id="grid"></main></body></html>',
  );
  doc = dom.window.document;
  grid = doc.getElementById("grid") as HTMLElement;
});

// ── MANIFEST_URL ────────────────────────────────────────────────────────────

describe("MANIFEST_URL", () => {
  it("points at the real M3-03 compiler output path (.genie/manifest.json)", () => {
    // The AC sketch says `./manifest.json`, but the SHIPPED compiler writes
    // `.genie/manifest.json` (see server/manifest/compiler.ts + viewer/cli.ts
    // MANIFEST_RELATIVE_PATH). The viewer must fetch the real location.
    expect(MANIFEST_URL).toBe(".genie/manifest.json");
  });
});

// ── parseViewport (AC2 viewport sizing) ─────────────────────────────────────

describe("parseViewport", () => {
  it("parses a WxH token into integers", () => {
    expect(parseViewport("480x240")).toEqual({ width: 480, height: 240 });
    expect(parseViewport("1024x768")).toEqual({ width: 1024, height: 768 });
  });

  it("returns null for a named token like 'desktop'", () => {
    expect(parseViewport("desktop")).toBeNull();
  });

  it("returns null for an empty or missing viewport", () => {
    expect(parseViewport("")).toBeNull();
    expect(parseViewport(undefined)).toBeNull();
  });

  it("returns null for a malformed WxH token", () => {
    expect(parseViewport("12x")).toBeNull();
    expect(parseViewport("x240")).toBeNull();
    expect(parseViewport("480X240 extra")).toBeNull();
    expect(parseViewport("480x240x100")).toBeNull();
    expect(parseViewport("4.5x2")).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseViewport("  480x240  ")).toEqual({ width: 480, height: 240 });
  });

  it("returns null for a degenerate zero/non-positive dimension", () => {
    // A 0-size iframe would render invisible; treat it like a named token and
    // let createCard fall back to the default height.
    expect(parseViewport("0x0")).toBeNull();
    expect(parseViewport("480x0")).toBeNull();
    expect(parseViewport("0x240")).toBeNull();
  });
});

// ── groupByGroup (AC2 grouping) ─────────────────────────────────────────────

describe("groupByGroup", () => {
  it("buckets components by their group, preserving first-seen group order", () => {
    const grouped = groupByGroup([
      card({ name: "A", group: "actions" }),
      card({ name: "S", group: "surfaces" }),
      card({ name: "B", group: "actions" }),
    ]);
    expect([...grouped.keys()]).toEqual(["actions", "surfaces"]);
    expect(grouped.get("actions")?.map((c) => c.name)).toEqual(["A", "B"]);
    expect(grouped.get("surfaces")?.map((c) => c.name)).toEqual(["S"]);
  });

  it("returns an empty map for zero components", () => {
    expect(groupByGroup([]).size).toBe(0);
  });
});

// ── createCard (AC2/AC3/AC4 per-card contract) ──────────────────────────────

describe("createCard", () => {
  it("renders an <iframe> whose src is the component path", () => {
    const el = createCard(doc, card({ path: "components/actions/Button/preview.html" }));
    const iframe = el.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("src")).toBe("components/actions/Button/preview.html");
  });

  it("AC3 — sandboxes the iframe as allow-scripts only (never allow-same-origin)", () => {
    const iframe = createCard(doc, card()).querySelector("iframe") as HTMLIFrameElement;
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox.split(/\s+/)).toContain("allow-scripts");
    expect(sandbox).not.toMatch(/allow-same-origin/);
  });

  it("AC4 — marks the iframe loading=lazy", () => {
    const iframe = createCard(doc, card()).querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("loading")).toBe("lazy");
  });

  it("AC2 — sizes the iframe height from a WxH viewport", () => {
    const iframe = createCard(doc, card({ viewport: "480x240" })).querySelector(
      "iframe",
    ) as HTMLIFrameElement;
    // height attribute reflects the parsed viewport height for intrinsic ratio.
    expect(iframe.getAttribute("height")).toBe("240");
    expect(iframe.getAttribute("width")).toBe("480");
  });

  it("AC2 — falls back to a default height for a named/unparseable viewport", () => {
    const iframe = createCard(doc, card({ viewport: "desktop" })).querySelector(
      "iframe",
    ) as HTMLIFrameElement;
    // No crash, no NaN: a sane default height, and no fixed width attr.
    const h = Number(iframe.getAttribute("height"));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
    expect(iframe.getAttribute("width")).toBeNull();
  });

  it("exposes the component name for the search filter (data-name, lowercased)", () => {
    const el = createCard(doc, card({ name: "Primary Buttons" }));
    expect(el.getAttribute("data-name")).toBe("primary buttons");
  });

  it("shows the component name and group as visible card chrome", () => {
    const el = createCard(doc, card({ name: "Primary buttons", group: "actions" }));
    expect(el.textContent).toContain("Primary buttons");
  });
});

// ── renderGrid (AC2/AC6) ────────────────────────────────────────────────────

describe("renderGrid", () => {
  it("AC2 — renders one section per group with the cards under it", () => {
    renderGrid(doc, grid, twoGroupManifest());

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

  it("AC3/AC4 — every rendered iframe is lazy + allow-scripts, no allow-same-origin", () => {
    renderGrid(doc, grid, twoGroupManifest());
    const iframes = [...grid.querySelectorAll("iframe")];
    expect(iframes.length).toBe(2);
    for (const f of iframes) {
      expect(f.getAttribute("loading")).toBe("lazy");
      expect((f.getAttribute("sandbox") ?? "").split(/\s+/)).toContain("allow-scripts");
      expect(f.getAttribute("sandbox") ?? "").not.toMatch(/allow-same-origin/);
    }
  });

  it("clears any prior render before drawing (idempotent re-render)", () => {
    renderGrid(doc, grid, twoGroupManifest());
    renderGrid(doc, grid, twoGroupManifest());
    // Not doubled: still exactly 2 iframes, 2 sections.
    expect(grid.querySelectorAll("iframe").length).toBe(2);
    expect(grid.querySelectorAll("section").length).toBe(2);
  });

  it("AC6 — an empty manifest renders a visible empty state and no iframes", () => {
    renderGrid(doc, grid, manifest([]));
    expect(grid.querySelectorAll("iframe").length).toBe(0);
    const empty = grid.querySelector(".ds-empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.toLowerCase()).toContain("no components");
  });
});

// ── applyFilter (AC5) ───────────────────────────────────────────────────────

describe("applyFilter", () => {
  beforeEach(() => {
    renderGrid(doc, grid, twoGroupManifest());
  });

  function visibleNames(): string[] {
    return [...grid.querySelectorAll("[data-name]")]
      .filter((el) => !(el as HTMLElement).hidden)
      .map((el) => el.getAttribute("data-name") ?? "");
  }

  it("AC5 — filters cards by a case-insensitive name substring", () => {
    applyFilter(grid, "prim");
    expect(visibleNames()).toEqual(["primary buttons"]);
  });

  it("AC5 — matches regardless of query case", () => {
    applyFilter(grid, "CARD");
    expect(visibleNames()).toEqual(["card"]);
  });

  it("AC5 — an empty query reveals every card", () => {
    applyFilter(grid, "prim");
    applyFilter(grid, "");
    expect(visibleNames().sort()).toEqual(["card", "primary buttons"]);
  });

  it("AC5 — hides a group section when it has no matching cards", () => {
    applyFilter(grid, "prim");
    const surfaces = grid.querySelector('section[data-group="surfaces"]') as HTMLElement;
    const actions = grid.querySelector('section[data-group="actions"]') as HTMLElement;
    expect(surfaces.hidden).toBe(true);
    expect(actions.hidden).toBe(false);
  });

  it("AC5 — a query matching nothing hides all cards and all sections", () => {
    applyFilter(grid, "zzz-no-match");
    expect(visibleNames()).toEqual([]);
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
    const seen: string[] = [];
    const f = async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => twoGroupManifest() } as Response;
    };

    await boot(doc, f as typeof fetch);

    expect(seen).toEqual([MANIFEST_URL]);
    expect(grid.querySelectorAll("iframe").length).toBe(2);
  });

  it("AC5 — wires the #q input so typing filters the grid live", async () => {
    await boot(doc, fakeFetch(twoGroupManifest()) as typeof fetch);

    const q = doc.getElementById("q") as HTMLInputElement;
    q.value = "prim";
    q.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const visible = [...grid.querySelectorAll("[data-name]")].filter(
      (el) => !(el as HTMLElement).hidden,
    );
    expect(visible.map((el) => el.getAttribute("data-name"))).toEqual(["primary buttons"]);
  });

  it("AC6 — boot with an empty manifest shows the empty state", async () => {
    await boot(doc, fakeFetch(manifest([])) as typeof fetch);
    expect(grid.querySelector(".ds-empty")).not.toBeNull();
    expect(grid.querySelectorAll("iframe").length).toBe(0);
  });

  it("renders a visible error state (not a thrown error) when the fetch fails", async () => {
    const f = async () => {
      throw new Error("network down");
    };
    await expect(boot(doc, f as typeof fetch)).resolves.toBeUndefined();
    const err = grid.querySelector(".ds-error");
    expect(err).not.toBeNull();
    expect(err?.textContent?.toLowerCase()).toContain("could not load");
  });

  it("renders the error state when the manifest responds non-ok", async () => {
    await boot(doc, fakeFetch({}, false) as typeof fetch);
    expect(grid.querySelector(".ds-error")).not.toBeNull();
    expect(grid.querySelectorAll("iframe").length).toBe(0);
  });
});
