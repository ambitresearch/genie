/**
 * M4-04 (DRO-266) — client-side HMR suite for `static/viewer.js`.
 *
 * Companion to the SERVER suite (`src/hmr-plugin.test.ts`, which covers the
 * `/__genie_hmr` WebSocket + watcher classification). This file drives the
 * BROWSER half — the per-card reload dispatcher and the two live transports —
 * exactly like `grid-renderer.test.ts`: evaluate the real `static/viewer.js`
 * source into a fresh jsdom window per test and read its pure helpers off the
 * `window.__genieViewerTestHooks` seam (`viewer.js` is a CLASSIC script with no
 * `export`s — see its own header for why, DRO-749 / RFC G-5).
 *
 * AC coverage map (DRO-266):
 *   - AC2 — a `card.changed` reloads ONLY the iframe whose `data-path` matches,
 *           via a fresh `?__genie_hmr=N` cache-bust on its `src` (the
 *           cross-origin-safe equivalent of `contentWindow.reload()`, which
 *           throws against the mandated `allow-scripts`-only sandbox). Sibling
 *           cards are untouched — no whole-grid reflow.
 *   - AC4 — when the WebSocket errors/closes, `initHmr` falls back to polling
 *           the manifest every 2 s and reloads exactly the cards whose `hash`
 *           changed (`diffManifestHashes`).
 *   - AC5 — a `tokens.changed` reloads EVERY card iframe.
 *   - AC6 — each reload bumps the header `#hmr-count` read-out.
 *   - G-5 — `hmrSocketUrl` returns `null` on `file://` / opaque origins, so the
 *           same script degrades to the postMessage bridge across vehicles.
 *   - postMessage bridge — the embedded `ui://` tier refreshes via a `message`
 *           event (both the WS shape and the `{type:"refresh"}` sketch shape).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(HERE, "../static");
const VIEWER_JS = readFileSync(resolve(STATIC_DIR, "viewer.js"), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Hooks = Record<string, any>;

/**
 * A realistic two-card manifest (mirrors the M4-03 fixture): one `actions`
 * card, one `surfaces` card, each with a distinct kit-relative `path` + `hash`.
 */
function twoCardManifest(overrides?: {
  buttonHash?: string;
  cardHash?: string;
}): Record<string, unknown> {
  return {
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
        hash: overrides?.buttonHash ?? "sha256-button-v1",
        lastModified: "2026-07-01T00:00:00.000Z",
      },
      {
        name: "Card",
        group: "surfaces",
        path: "components/surfaces/Card/preview.html",
        viewport: "480x320",
        hash: overrides?.cardHash ?? "sha256-card-v1",
        lastModified: "2026-07-01T00:00:00.000Z",
      },
    ],
  };
}

/**
 * Evaluate the real `viewer.js` into a fresh jsdom window whose DOM already has
 * the header read-out (`#hmr-count`), the search input, and the grid — then
 * render `twoCardManifest()` into the grid so the tests operate on REAL card
 * iframes carrying `data-path` (exactly what a booted page has).
 */
function setup(manifest: Record<string, unknown> = twoCardManifest()): {
  hooks: Hooks;
  window: JSDOM["window"];
  document: Document;
  grid: HTMLElement;
} {
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      '<header><input id="q" />' +
      '<details class="hmr-meter"><summary>HMR <span id="hmr-count" data-count="0">0</span></summary></details>' +
      "</header>" +
      '<main id="grid"></main></body></html>',
    { runScripts: "outside-only", url: "http://127.0.0.1:5173/" },
  );
  const { window } = dom;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__genieViewerTestHooks = {};
  window.eval(VIEWER_JS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks = (window as any).__genieViewerTestHooks as Hooks;
  const document = window.document;
  const grid = document.getElementById("grid") as HTMLElement;
  hooks.renderGrid(document, grid, manifest);
  return { hooks, window, document, grid };
}

const BUTTON_PATH = "components/actions/Button/preview.html";
const CARD_PATH = "components/surfaces/Card/preview.html";

function iframeFor(grid: HTMLElement, path: string): HTMLIFrameElement {
  const el = grid.querySelector(`iframe[data-path="${path}"]`);
  if (!el) throw new Error(`no iframe for ${path}`);
  return el as HTMLIFrameElement;
}

// ── createCard now stamps data-path (AC2 identity) ──────────────────────────

describe("card iframe carries a stable data-path (AC2)", () => {
  it("every rendered iframe has data-path equal to its component path", () => {
    const { grid } = setup();
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("data-path")).toBe(BUTTON_PATH);
    expect(iframeFor(grid, CARD_PATH).getAttribute("data-path")).toBe(CARD_PATH);
  });

  it("data-path stays clean (no cache-bust) while src starts un-busted", () => {
    const { grid } = setup();
    const f = iframeFor(grid, BUTTON_PATH);
    expect(f.getAttribute("src")).toBe(BUTTON_PATH);
    expect(f.getAttribute("data-path")).not.toContain("__genie_hmr");
  });

  it("keeps embedded transport src separate from the kit-relative HMR identity", () => {
    const manifest = twoCardManifest();
    const button = (manifest.components as Array<Record<string, unknown>>)[0]!;
    button.sourcePath = BUTTON_PATH;
    button.path = "data:text/html;base64,PGJ1dHRvbj5vbGQ8L2J1dHRvbj4=";

    const { grid } = setup(manifest);
    const iframe = iframeFor(grid, BUTTON_PATH);
    expect(iframe.getAttribute("data-path")).toBe(BUTTON_PATH);
    expect(iframe.getAttribute("data-src")).toBe(button.path);
    expect(iframe.getAttribute("src")).toBe(button.path);
  });
});

// ── normalizeHmrMessage (both wire shapes) ──────────────────────────────────

describe("normalizeHmrMessage", () => {
  it("maps the WS card.changed shape to a card command", () => {
    const { hooks } = setup();
    expect(hooks.normalizeHmrMessage({ event: "card.changed", path: BUTTON_PATH })).toEqual({
      kind: "card",
      path: BUTTON_PATH,
    });
  });

  it("parses a JSON STRING frame (a raw WebSocket message) too", () => {
    const { hooks } = setup();
    expect(
      hooks.normalizeHmrMessage(JSON.stringify({ event: "card.changed", path: CARD_PATH })),
    ).toEqual({ kind: "card", path: CARD_PATH });
  });

  it("maps tokens.changed to a tokens command", () => {
    const { hooks } = setup();
    expect(hooks.normalizeHmrMessage({ event: "tokens.changed" })).toEqual({ kind: "tokens" });
  });

  it("maps manifest.changed to a structural refresh command", () => {
    const { hooks } = setup();
    expect(hooks.normalizeHmrMessage({ event: "manifest.changed" })).toEqual({
      kind: "manifest",
    });
  });

  it("maps the postMessage {type:'refresh', path} sketch shape to a card command", () => {
    const { hooks } = setup();
    expect(hooks.normalizeHmrMessage({ type: "refresh", path: BUTTON_PATH })).toEqual({
      kind: "card",
      path: BUTTON_PATH,
    });
  });

  it("accepts {type:'refresh', id} (id is the card path) as a card command", () => {
    const { hooks } = setup();
    expect(hooks.normalizeHmrMessage({ type: "refresh", id: CARD_PATH })).toEqual({
      kind: "card",
      path: CARD_PATH,
    });
  });

  it("treats a target-less {type:'refresh'} as refresh-all (tokens)", () => {
    const { hooks } = setup();
    expect(hooks.normalizeHmrMessage({ type: "refresh" })).toEqual({ kind: "tokens" });
  });

  it("returns null for unrelated / malformed messages (ignored, not thrown)", () => {
    const { hooks } = setup();
    expect(hooks.normalizeHmrMessage(null)).toBeNull();
    expect(hooks.normalizeHmrMessage(undefined)).toBeNull();
    expect(hooks.normalizeHmrMessage("not json")).toBeNull();
    expect(hooks.normalizeHmrMessage(42)).toBeNull();
    expect(hooks.normalizeHmrMessage({ hello: "world" })).toBeNull();
    expect(hooks.normalizeHmrMessage({ event: "card.changed" })).toBeNull(); // no path
    expect(hooks.normalizeHmrMessage({ event: "card.changed", path: "" })).toBeNull(); // empty path
  });
});

// ── reloadCardByPath (AC2 — ONE card only) ──────────────────────────────────

describe("reloadCardByPath (AC2)", () => {
  it("reloads ONLY the matching iframe, cache-busting its src", () => {
    const { hooks, grid } = setup();
    const before = iframeFor(grid, CARD_PATH).getAttribute("src");
    const n = hooks.reloadCardByPath(grid, BUTTON_PATH, 7);

    expect(n).toBe(1);
    const buttonSrc = iframeFor(grid, BUTTON_PATH).getAttribute("src");
    expect(buttonSrc).toBe(BUTTON_PATH + "?__genie_hmr=7");
    // The sibling card is untouched — no whole-grid reflow (the anti-pattern
    // this whole issue exists to prevent).
    expect(iframeFor(grid, CARD_PATH).getAttribute("src")).toBe(before);
  });

  it("keeps data-path stable across a reload (identity != live src)", () => {
    const { hooks, grid } = setup();
    hooks.reloadCardByPath(grid, BUTTON_PATH, 1);
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("data-path")).toBe(BUTTON_PATH);
  });

  it("a second reload replaces (not appends) the cache-bust token", () => {
    const { hooks, grid } = setup();
    hooks.reloadCardByPath(grid, BUTTON_PATH, 1);
    hooks.reloadCardByPath(grid, BUTTON_PATH, 2);
    const src = iframeFor(grid, BUTTON_PATH).getAttribute("src") ?? "";
    expect(src).toBe(BUTTON_PATH + "?__genie_hmr=2");
    // exactly one token param — not "?__genie_hmr=1?__genie_hmr=2".
    expect(src.match(/__genie_hmr/g)).toHaveLength(1);
  });

  it("returns 0 (and touches nothing) for a path with no matching card", () => {
    const { hooks, grid } = setup();
    const buttonBefore = iframeFor(grid, BUTTON_PATH).getAttribute("src");
    expect(hooks.reloadCardByPath(grid, "components/does/Not/Exist/preview.html", 5)).toBe(0);
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(buttonBefore);
  });

  it("uses a fresh source supplied by the embedded host for a data-backed card", () => {
    const manifest = twoCardManifest();
    const button = (manifest.components as Array<Record<string, unknown>>)[0]!;
    button.sourcePath = BUTTON_PATH;
    button.path = "data:text/html;base64,b2xk";
    const { hooks, grid } = setup(manifest);
    const freshSrc = "data:text/html;base64,bmV3";

    expect(hooks.reloadCardByPath(grid, BUTTON_PATH, 1, freshSrc)).toBe(1);
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(freshSrc);
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("data-src")).toBe(freshSrc);
  });

  it("does not pretend to refresh a data-backed card without fresh bytes", () => {
    const manifest = twoCardManifest();
    const button = (manifest.components as Array<Record<string, unknown>>)[0]!;
    button.sourcePath = BUTTON_PATH;
    button.path = "data:text/html;base64,b2xk";
    const { hooks, grid } = setup(manifest);

    expect(hooks.reloadCardByPath(grid, BUTTON_PATH, 1)).toBe(0);
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(button.path);
  });
});

// ── reloadAllCards (AC5) ────────────────────────────────────────────────────

describe("reloadAllCards (AC5 — tokens/styles change)", () => {
  it("reloads EVERY card iframe with the shared token", () => {
    const { hooks, grid } = setup();
    const n = hooks.reloadAllCards(grid, 9);
    expect(n).toBe(2);
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(BUTTON_PATH + "?__genie_hmr=9");
    expect(iframeFor(grid, CARD_PATH).getAttribute("src")).toBe(CARD_PATH + "?__genie_hmr=9");
  });
});

// ── applyHmrMessage (dispatcher) ────────────────────────────────────────────

describe("applyHmrMessage (dispatcher)", () => {
  it("card.changed → one card; tokens.changed → all cards", () => {
    const { hooks, grid } = setup();
    expect(hooks.applyHmrMessage(grid, { event: "card.changed", path: BUTTON_PATH }, 1)).toBe(1);
    expect(hooks.applyHmrMessage(grid, { event: "tokens.changed" }, 2)).toBe(2);
  });

  it("returns 0 for an unrecognised message (no reload)", () => {
    const { hooks, grid } = setup();
    expect(hooks.applyHmrMessage(grid, { nonsense: true }, 1)).toBe(0);
  });

  it("uses a monotonic token when none is pinned (each dispatch changes src)", () => {
    const { hooks, grid } = setup();
    hooks.applyHmrMessage(grid, { event: "card.changed", path: BUTTON_PATH });
    const first = iframeFor(grid, BUTTON_PATH).getAttribute("src");
    hooks.applyHmrMessage(grid, { event: "card.changed", path: BUTTON_PATH });
    const second = iframeFor(grid, BUTTON_PATH).getAttribute("src");
    expect(first).not.toBe(second); // token advanced, so the browser refetches
  });
});

// ── diffManifestHashes (AC4 poll diff) ──────────────────────────────────────

describe("diffManifestHashes (AC4)", () => {
  it("returns the paths of components whose hash changed", () => {
    const { hooks } = setup();
    const prev = twoCardManifest();
    const next = twoCardManifest({ buttonHash: "sha256-button-v2" });
    expect(hooks.diffManifestHashes(prev, next)).toEqual([BUTTON_PATH]);
  });

  describe("manifestStructureChanged", () => {
    it("detects rendered group, name, and viewport metadata changes at a stable path", () => {
      const { hooks } = setup();
      const prev = twoCardManifest();

      for (const field of ["group", "name", "viewport"]) {
        const next = twoCardManifest();
        (next.components as Array<Record<string, unknown>>)[0]![field] = `changed-${field}`;
        expect(hooks.manifestStructureChanged(prev, next)).toBe(true);
      }
    });

    it("keeps hash-only changes on the lightweight iframe reload path", () => {
      const { hooks } = setup();
      expect(
        hooks.manifestStructureChanged(
          twoCardManifest(),
          twoCardManifest({ buttonHash: "sha256-button-v2" }),
        ),
      ).toBe(false);
    });
  });

  it("returns [] when nothing changed", () => {
    const { hooks } = setup();
    expect(hooks.diffManifestHashes(twoCardManifest(), twoCardManifest())).toEqual([]);
  });

  it("detects multiple simultaneous content changes", () => {
    const { hooks } = setup();
    const next = twoCardManifest({ buttonHash: "b2", cardHash: "c2" });
    expect(hooks.diffManifestHashes(twoCardManifest(), next).sort()).toEqual(
      [BUTTON_PATH, CARD_PATH].sort(),
    );
  });

  it("leaves brand-new components to the structural-change detector", () => {
    const { hooks } = setup();
    const prev = twoCardManifest();
    const next = twoCardManifest();
    (next.components as unknown[]).push({
      name: "New",
      group: "actions",
      path: "components/actions/New/preview.html",
      viewport: "100x100",
      hash: "sha256-new",
      lastModified: "2026-07-02T00:00:00.000Z",
    });
    expect(hooks.diffManifestHashes(prev, next)).toEqual([]);
  });

  it("never throws on a partial/empty manifest", () => {
    const { hooks } = setup();
    expect(hooks.diffManifestHashes({}, {})).toEqual([]);
    expect(hooks.diffManifestHashes(null, null)).toEqual([]);
    expect(hooks.diffManifestHashes(twoCardManifest(), { components: [] })).toEqual([]);
  });
});

// ── bumpReloadCounter (AC6) ─────────────────────────────────────────────────

describe("bumpReloadCounter (AC6)", () => {
  it("increments the header read-out and mirrors it to data-count", () => {
    const { hooks, document } = setup();
    expect(hooks.bumpReloadCounter(document, 1)).toBe(1);
    expect(hooks.bumpReloadCounter(document, 2)).toBe(3);
    const el = document.getElementById("hmr-count") as HTMLElement;
    expect(el.getAttribute("data-count")).toBe("3");
    expect(el.textContent).toBe("3");
  });

  it("is a no-op for a non-positive delta", () => {
    const { hooks, document } = setup();
    hooks.bumpReloadCounter(document, 1);
    expect(hooks.bumpReloadCounter(document, 0)).toBe(1);
    expect(hooks.bumpReloadCounter(document, -5)).toBe(1);
  });

  it("does not throw when the counter element is absent (embedded shell)", () => {
    const { hooks, document } = setup();
    (document.getElementById("hmr-count") as HTMLElement).remove();
    expect(() => hooks.bumpReloadCounter(document, 1)).not.toThrow();
    expect(hooks.bumpReloadCounter(document, 1)).toBe(0);
  });
});

// ── hmrSocketUrl (G-5 vehicle awareness) ────────────────────────────────────

describe("hmrSocketUrl (RFC G-5)", () => {
  it("derives a ws:// URL on http", () => {
    const { hooks } = setup();
    expect(hooks.hmrSocketUrl({ protocol: "http:", host: "127.0.0.1:5173" })).toBe(
      "ws://127.0.0.1:5173/__genie_hmr",
    );
  });

  it("derives a wss:// URL on https", () => {
    const { hooks } = setup();
    expect(hooks.hmrSocketUrl({ protocol: "https:", host: "preview.example.com" })).toBe(
      "wss://preview.example.com/__genie_hmr",
    );
  });

  it("returns null on file:// (no dev server — the byte-identical vehicle skip)", () => {
    const { hooks } = setup();
    expect(hooks.hmrSocketUrl({ protocol: "file:", host: "" })).toBeNull();
  });

  it("returns null for an opaque / missing-host origin (embedded ui://)", () => {
    const { hooks } = setup();
    expect(hooks.hmrSocketUrl({ protocol: "http:", host: "" })).toBeNull();
    expect(hooks.hmrSocketUrl(null)).toBeNull();
  });
});

// ── initHmr integration: transports, fallback, teardown ─────────────────────

/** A hand-driven fake WebSocket: capture the URL and fire callbacks on cue. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

function fakeMcpAppWindow(): {
  win: Record<string, unknown>;
  parentPostMessage: ReturnType<typeof vi.fn>;
  emit: (data: unknown) => void;
} {
  const listeners = new Set<(event: { source: unknown; data: unknown }) => void>();
  const parent = { postMessage: vi.fn() };
  const win = {
    parent,
    addEventListener: (
      type: string,
      listener: (event: { source: unknown; data: unknown }) => void,
    ) => {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener: (
      type: string,
      listener: (event: { source: unknown; data: unknown }) => void,
    ) => {
      if (type === "message") listeners.delete(listener);
    },
  };
  return {
    win,
    parentPostMessage: parent.postMessage,
    emit: (data) => {
      for (const listener of listeners) listener({ source: parent, data });
    },
  };
}

describe("initMcpApp — standard tool result delivery", () => {
  it("initializes with the host and renders the viewer URL from structuredContent", () => {
    const { hooks, document, grid } = setup({ version: 1, groups: [], components: [] });
    const host = fakeMcpAppWindow();

    hooks.initMcpApp(document, { win: host.win });
    const initialize = host.parentPostMessage.mock.calls[0]?.[0] as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(initialize.method).toBe("ui/initialize");
    expect(initialize.params).toHaveProperty("appInfo");
    expect(initialize.params).not.toHaveProperty("clientInfo");

    host.emit({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: "2026-01-26" } });
    expect(host.parentPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: "ui/notifications/initialized" }),
      "*",
    );
    Object.defineProperty(document.documentElement, "scrollWidth", {
      value: 640,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      value: 720,
      configurable: true,
    });

    host.emit({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: {
          transportKind: "stdio",
          locality: "local",
          viewerUrl: "http://127.0.0.1:5173/",
        },
      },
    });

    const frame = grid.querySelector("iframe.ds-viewer-embed");
    expect(frame?.getAttribute("src")).toBe("http://127.0.0.1:5173/");
    expect(document.querySelector("body > header")).toBeNull();
    expect(host.parentPostMessage).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { width: 640, height: 720 },
      },
      "*",
    );
  });

  it("renders the embedded manifest for HTTP instead of framing a server-local loopback URL", () => {
    const { hooks, document, grid } = setup({ version: 1, groups: [], components: [] });
    const host = fakeMcpAppWindow();
    hooks.initMcpApp(document, { win: host.win });

    const embeddedManifest = twoCardManifest();
    for (const component of embeddedManifest.components as Array<Record<string, unknown>>) {
      component.sourcePath = component.path;
      component.path = `https://previews.example.com/${String(component.path)}`;
    }
    host.emit({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: {
          transportKind: "http",
          locality: "remote",
          viewerUrl: "http://127.0.0.1:5173/",
        },
        _meta: { "genie/embeddedManifest": embeddedManifest },
      },
    });

    expect(grid.querySelector("iframe.ds-viewer-embed")).toBeNull();
    expect(document.querySelector("body > header")).not.toBeNull();
    expect(iframeFor(grid, BUTTON_PATH)).toBeDefined();
    expect(iframeFor(grid, CARD_PATH)).toBeDefined();
  });

  it("prefers the widget-only metadata manifest over the structured compatibility fallback", () => {
    const { hooks, document, grid } = setup({ version: 1, groups: [], components: [] });
    const embeddedManifest = twoCardManifest();
    for (const component of embeddedManifest.components as Array<Record<string, unknown>>) {
      component.sourcePath = component.path;
      component.path = `http://127.0.0.1:57321/${String(component.path)}`;
    }
    const compatibilityManifest = twoCardManifest();
    for (const component of compatibilityManifest.components as Array<Record<string, unknown>>) {
      component.sourcePath = component.path;
      component.path = `https://fallback.example.com/${String(component.path)}`;
    }

    expect(
      hooks.renderToolResult(document, grid, {
        structuredContent: {
          transportKind: "stdio",
          locality: "local",
          viewerUrl: "http://127.0.0.1:5173/",
          embeddedManifest: compatibilityManifest,
          embeddedError: "inline preview unavailable",
        },
        _meta: { "genie/embeddedManifest": embeddedManifest },
      }),
    ).toBe(true);

    expect(grid.querySelector("iframe.ds-viewer-embed")).toBeNull();
    expect(grid.querySelector(".ds-error")).toBeNull();
    expect(document.querySelector("body > header")).not.toBeNull();
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(
      `http://127.0.0.1:57321/${BUTTON_PATH}`,
    );
    expect(iframeFor(grid, CARD_PATH).getAttribute("src")).toBe(
      `http://127.0.0.1:57321/${CARD_PATH}`,
    );
  });

  it("frames a reachable viewer for explicitly local loopback HTTP", () => {
    const { hooks, document, grid } = setup({ version: 1, groups: [], components: [] });

    expect(
      hooks.renderToolResult(document, grid, {
        structuredContent: {
          transportKind: "http",
          locality: "local",
          viewerUrl: "http://127.0.0.1:5173/",
        },
      }),
    ).toBe(true);
    expect(grid.querySelector("iframe.ds-viewer-embed")?.getAttribute("src")).toBe(
      "http://127.0.0.1:5173/",
    );
  });

  it("restores the shell header when leaving a local framed viewer", () => {
    const { hooks, document, grid } = setup({ version: 1, groups: [], components: [] });
    const localResult = {
      structuredContent: {
        transportKind: "stdio",
        locality: "local",
        viewerUrl: "http://127.0.0.1:5173/",
      },
    };
    const embeddedManifest = twoCardManifest();
    for (const component of embeddedManifest.components as Array<Record<string, unknown>>) {
      component.sourcePath = component.path;
      component.path = `https://previews.example.com/${String(component.path)}`;
    }

    expect(hooks.renderToolResult(document, grid, localResult)).toBe(true);
    expect(document.querySelector("body > header")).toBeNull();

    expect(
      hooks.renderToolResult(document, grid, {
        structuredContent: {
          transportKind: "http",
          locality: "remote",
          embeddedManifest,
        },
      }),
    ).toBe(true);
    expect(document.querySelector("body > header")).not.toBeNull();

    expect(hooks.renderToolResult(document, grid, localResult)).toBe(true);
    expect(document.querySelector("body > header")).toBeNull();

    expect(
      hooks.renderToolResult(document, grid, {
        structuredContent: { embeddedError: "preview unavailable" },
      }),
    ).toBe(false);
    expect(document.querySelector("body > header")).not.toBeNull();
    expect(grid.querySelector(".ds-error")?.textContent).toContain("preview unavailable");
  });

  it("clears a stale successful preview for standard errors and malformed results", () => {
    const { hooks, document, grid } = setup({ version: 1, groups: [], components: [] });
    const localResult = {
      structuredContent: {
        transportKind: "stdio",
        locality: "local",
        viewerUrl: "http://127.0.0.1:5173/",
      },
    };

    expect(hooks.renderToolResult(document, grid, localResult)).toBe(true);
    expect(grid.querySelector("iframe.ds-viewer-embed")).not.toBeNull();

    expect(
      hooks.renderToolResult(document, grid, {
        isError: true,
        content: [{ type: "text", text: "Kit not found" }],
      }),
    ).toBe(false);
    expect(grid.querySelector("iframe")).toBeNull();
    expect(grid.querySelector(".ds-error")?.textContent).toBe("Kit not found");

    expect(hooks.renderToolResult(document, grid, localResult)).toBe(true);
    expect(
      hooks.renderToolResult(document, grid, {
        structuredContent: { locality: "local", viewerUrl: "ftp://example.com/preview" },
      }),
    ).toBe(false);
    expect(grid.querySelector("iframe")).toBeNull();
    expect(grid.querySelector(".ds-error")?.textContent).toContain("Preview unavailable");

    expect(hooks.renderToolResult(document, grid, localResult)).toBe(true);
    expect(
      hooks.renderToolResult(document, grid, {
        structuredContent: {
          locality: "remote",
          embeddedManifest: { components: {} },
        },
      }),
    ).toBe(false);
    expect(grid.querySelector("iframe")).toBeNull();
    expect(grid.querySelector(".ds-error")?.textContent).toContain("GENIE_PREVIEWS_BASE_URL");

    expect(hooks.renderToolResult(document, grid, localResult)).toBe(true);
    expect(hooks.renderToolResult(document, grid, null)).toBe(false);
    expect(grid.querySelector("iframe")).toBeNull();
    expect(grid.querySelector(".ds-error")?.textContent).toContain("Preview unavailable");
  });

  it("shows an explicit error instead of rendering dynamically delivered data cards under stale CSP", () => {
    const manifest = twoCardManifest();
    (manifest.components as Array<Record<string, unknown>>)[0]!.path =
      "data:text/html;base64,PGJ1dHRvbj5TYXZlPC9idXR0b24+";
    const { hooks, document, grid } = setup({ version: 1, groups: [], components: [] });

    expect(
      hooks.renderToolResult(document, grid, {
        structuredContent: { transportKind: "http", embeddedManifest: manifest },
      }),
    ).toBe(false);
    expect(grid.querySelector(".ds-error")?.textContent).toContain("GENIE_PREVIEWS_BASE_URL");
    expect(grid.querySelector("iframe[data-path]")).toBeNull();
  });

  it("acknowledges host ping requests with an empty JSON-RPC result", () => {
    const { hooks, document } = setup({ version: 1, groups: [], components: [] });
    const host = fakeMcpAppWindow();
    hooks.initMcpApp(document, { win: host.win });

    host.emit({ jsonrpc: "2.0", id: 41, method: "ping" });

    expect(host.parentPostMessage).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: 41, result: {} },
      "*",
    );
  });

  it("observes both the document root and body for size changes", () => {
    const { hooks, document } = setup({ version: 1, groups: [], components: [] });
    const host = fakeMcpAppWindow();
    const observed: Element[] = [];
    host.win.ResizeObserver = class {
      observe(element: Element) {
        observed.push(element);
      }
      disconnect() {}
    };
    hooks.initMcpApp(document, { win: host.win });
    const initialize = host.parentPostMessage.mock.calls[0]?.[0] as { id: number };

    host.emit({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: "2026-01-26" } });

    expect(observed).toEqual([document.documentElement, document.body]);
  });

  it("acknowledges ui/resource-teardown and stops processing host messages", () => {
    const { hooks, document, grid } = setup({ version: 1, groups: [], components: [] });
    const host = fakeMcpAppWindow();
    hooks.initMcpApp(document, { win: host.win });

    host.emit({ jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: {} });

    expect(host.parentPostMessage).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: 99, result: {} },
      "*",
    );
    host.emit({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: {
          transportKind: "stdio",
          locality: "local",
          viewerUrl: "http://127.0.0.1:5173/",
        },
      },
    });
    expect(grid.querySelector("iframe.ds-viewer-embed")).toBeNull();
  });

  it("boot composes MCP App teardown with the embedded HMR bridge", async () => {
    const { hooks, window, document, grid } = setup({ version: 1, groups: [], components: [] });
    const manifestNode = document.createElement("script");
    manifestNode.id = "manifest";
    manifestNode.type = "application/json";
    manifestNode.textContent = JSON.stringify(twoCardManifest());
    document.head.appendChild(manifestNode);
    const shellMarker = document.createElement("meta");
    shellMarker.name = "genie-tool-result-shell";
    document.head.appendChild(shellMarker);
    const parent = { postMessage: vi.fn() };
    Object.defineProperty(window, "parent", { value: parent, configurable: true });

    await hooks.boot(document, vi.fn());
    const initialize = parent.postMessage.mock.calls[0]?.[0] as { id: number };
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: parent as unknown as Window,
        data: { jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: "2026-01-26" } },
      }),
    );
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: parent as unknown as Window,
        data: { jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: {} },
      }),
    );
    const before = iframeFor(grid, BUTTON_PATH).getAttribute("src");

    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: parent as unknown as Window,
        data: { type: "refresh", path: BUTTON_PATH },
      }),
    );

    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(before);
  });

  it("boot inits the host bridge for an inlined resource that lacks the tool-result-shell marker", async () => {
    // Query-bearing `ui://` resources (e.g. the preview URI with ?kitId=…) are
    // emitted WITHOUT the tool-result-shell marker (grid-resource.ts) yet still
    // run inside an MCP-App host frame. The bridge must init regardless of the
    // marker — otherwise their Generate tab is wrongly flagged "Host unavailable".
    const { hooks, window, document } = setup({ version: 1, groups: [], components: [] });
    const manifestNode = document.createElement("script");
    manifestNode.id = "manifest";
    manifestNode.type = "application/json";
    manifestNode.textContent = JSON.stringify(twoCardManifest());
    document.head.appendChild(manifestNode);
    // NB: no genie-tool-result-shell meta node this time.
    const parent = { postMessage: vi.fn() };
    Object.defineProperty(window, "parent", { value: parent, configurable: true });

    await hooks.boot(document, vi.fn());

    // The MCP-App handshake fired: boot posted an `initialize` to the host.
    const initialize = parent.postMessage.mock.calls[0]?.[0] as
      | { method?: string; id?: number }
      | undefined;
    expect(initialize?.method).toBe("ui/initialize");
    expect(typeof initialize?.id).toBe("number");
  });

  it("resolves onUnavailable immediately when there is no host frame (win.parent === win)", () => {
    const { hooks, window, document } = setup({ version: 1, groups: [], components: [] });
    // Top-level render: a window is its own parent, so no MCP-App host handshake
    // is possible. The bridge must resolve the pending shell to unavailable
    // rather than returning a silent no-op that strands it spinning forever.
    Object.defineProperty(window, "parent", { value: window, configurable: true });
    const onUnavailable = vi.fn();
    const onReady = vi.fn();

    const teardown = hooks.initMcpApp(document, { win: window, onUnavailable, onReady });

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(typeof teardown).toBe("function");
  });
});

describe("initHmr — WebSocket transport (AC2/AC5)", () => {
  it("connects to /__genie_hmr and reloads the matching card on a card.changed frame", () => {
    const { hooks, window, document, grid } = setup();
    FakeWebSocket.instances = [];

    const teardown = hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: FakeWebSocket,
      // no fetch/timers needed on the happy WS path
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    const sock = FakeWebSocket.instances[0]!;
    expect(sock.url).toBe("ws://127.0.0.1:5173/__genie_hmr");

    sock.onmessage!({ data: JSON.stringify({ event: "card.changed", path: BUTTON_PATH }) });

    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toMatch(/\?__genie_hmr=\d+$/);
    // sibling untouched
    expect(iframeFor(grid, CARD_PATH).getAttribute("src")).toBe(CARD_PATH);
    // AC6 — counter bumped by one.
    expect(document.getElementById("hmr-count")!.getAttribute("data-count")).toBe("1");

    teardown();
    expect(sock.closed).toBe(true);
  });

  it("a tokens.changed frame reloads every card and bumps the counter by that many (AC5/AC6)", () => {
    const { hooks, window, document, grid } = setup();
    FakeWebSocket.instances = [];
    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: FakeWebSocket,
    });
    FakeWebSocket.instances[0]!.onmessage!({ data: JSON.stringify({ event: "tokens.changed" }) });

    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toMatch(/\?__genie_hmr=\d+$/);
    expect(iframeFor(grid, CARD_PATH).getAttribute("src")).toMatch(/\?__genie_hmr=\d+$/);
    expect(document.getElementById("hmr-count")!.getAttribute("data-count")).toBe("2");
  });

  it("a manifest.changed frame refetches and removes deleted cards from the open grid", async () => {
    const { hooks, window, document, grid } = setup();
    FakeWebSocket.instances = [];
    const next = twoCardManifest();
    (next.components as unknown[]).splice(1, 1);
    const fetchImpl = async () => ({ ok: true, json: async () => next }) as Response;

    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: FakeWebSocket,
      fetchImpl,
      initialManifest: twoCardManifest(),
    });

    FakeWebSocket.instances[0]!.onmessage!({
      data: JSON.stringify({ event: "manifest.changed" }),
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(iframeFor(grid, BUTTON_PATH)).toBeDefined();
    expect(grid.querySelector(`iframe[data-path="${CARD_PATH}"]`)).toBeNull();
  });

  it("a content-only manifest event reloads only the hash-changed card", async () => {
    const { hooks, window, document, grid } = setup();
    FakeWebSocket.instances = [];
    const buttonBefore = iframeFor(grid, BUTTON_PATH);
    const cardBefore = iframeFor(grid, CARD_PATH);
    const fetchImpl = async () =>
      ({
        ok: true,
        json: async () => twoCardManifest({ buttonHash: "sha256-button-v2" }),
      }) as Response;

    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: FakeWebSocket,
      fetchImpl,
      initialManifest: twoCardManifest(),
    });

    FakeWebSocket.instances[0]!.onmessage!({
      data: JSON.stringify({ event: "manifest.changed" }),
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(iframeFor(grid, BUTTON_PATH)).toBe(buttonBefore);
    expect(buttonBefore.getAttribute("src")).toMatch(/\?__genie_hmr=\d+$/);
    expect(iframeFor(grid, CARD_PATH)).toBe(cardBefore);
    expect(cardBefore.getAttribute("src")).toBe(CARD_PATH);
    expect(document.getElementById("hmr-count")!.getAttribute("data-count")).toBe("1");
  });

  it("a generatedAt-only manifest event preserves every iframe", async () => {
    const { hooks, window, document, grid } = setup();
    FakeWebSocket.instances = [];
    const buttonBefore = iframeFor(grid, BUTTON_PATH);
    const cardBefore = iframeFor(grid, CARD_PATH);
    const next = twoCardManifest() as { generatedAt: string };
    next.generatedAt = "2026-07-02T00:00:00.000Z";

    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: FakeWebSocket,
      fetchImpl: async () => ({ ok: true, json: async () => next }) as Response,
      initialManifest: twoCardManifest(),
    });

    FakeWebSocket.instances[0]!.onmessage!({
      data: JSON.stringify({ event: "manifest.changed" }),
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(iframeFor(grid, BUTTON_PATH)).toBe(buttonBefore);
    expect(iframeFor(grid, CARD_PATH)).toBe(cardBefore);
    expect(document.getElementById("hmr-count")!.getAttribute("data-count")).toBe("0");
  });

  it("queues one manifest refresh while the previous fetch is in flight", async () => {
    const { hooks, window, document, grid } = setup();
    FakeWebSocket.instances = [];
    const first = twoCardManifest();
    (first.components as unknown[]).splice(1, 1);
    const second = twoCardManifest();
    let resolveFirst!: (response: Response) => void;
    const firstFetch = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(firstFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => second } as Response);

    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: FakeWebSocket,
      fetchImpl,
      initialManifest: twoCardManifest(),
    });

    const refresh = { data: JSON.stringify({ event: "manifest.changed" }) };
    FakeWebSocket.instances[0]!.onmessage!(refresh);
    FakeWebSocket.instances[0]!.onmessage!(refresh);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveFirst({ ok: true, json: async () => first } as Response);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(iframeFor(grid, CARD_PATH)).toBeDefined();
  });
});

describe("initHmr — postMessage bridge (embedded ui:// tier)", () => {
  it("reloads a card from a window 'message' event even with NO WebSocket (file://-like)", () => {
    const { hooks, window, document, grid } = setup();
    // No dev server (location null → hmrSocketUrl null): the postMessage bridge
    // is the only live channel, exactly the embedded/file:// case.
    hooks.initHmr(document, { win: window, location: null });

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "refresh", path: CARD_PATH },
        source: window.parent,
      }),
    );

    expect(iframeFor(grid, CARD_PATH).getAttribute("src")).toMatch(/\?__genie_hmr=\d+$/);
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(BUTTON_PATH);
    expect(document.getElementById("hmr-count")!.getAttribute("data-count")).toBe("1");
  });

  it("also accepts the WS-shaped message over postMessage (one bridge, both shapes)", () => {
    const { hooks, window, document, grid } = setup();
    hooks.initHmr(document, { win: window, location: null });
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { event: "card.changed", path: BUTTON_PATH },
        source: window.parent,
      }),
    );
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toMatch(/\?__genie_hmr=\d+$/);
  });

  it("ignores an unrelated postMessage (no reload, no counter bump)", () => {
    const { hooks, window, document, grid } = setup();
    hooks.initHmr(document, { win: window, location: null });
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { source: "react-devtools" },
        source: window.parent,
      }),
    );
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(BUTTON_PATH);
    expect(document.getElementById("hmr-count")!.getAttribute("data-count")).toBe("0");
  });

  it("teardown removes the message listener (no reload after teardown)", () => {
    const { hooks, window, document, grid } = setup();
    const teardown = hooks.initHmr(document, { win: window, location: null });
    teardown();
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "refresh", path: BUTTON_PATH },
        source: window.parent,
      }),
    );
    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(BUTTON_PATH);
  });

  it("rejects refresh messages posted by a sandboxed child card", () => {
    const { hooks, window, document, grid } = setup();
    const child = document.createElement("iframe");
    document.body.appendChild(child);
    hooks.initHmr(document, { win: window, location: null });

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "refresh", path: BUTTON_PATH },
        source: child.contentWindow,
      }),
    );

    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(BUTTON_PATH);
  });

  it("rejects a parent message whose origin differs from the configured host origin", () => {
    const { hooks, window, document, grid } = setup();
    hooks.initHmr(document, {
      win: window,
      location: null,
      parentOrigin: "https://host.example",
    });

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "refresh", path: BUTTON_PATH },
        source: window.parent,
        origin: "https://evil.example",
      }),
    );

    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(BUTTON_PATH);
  });

  it("accepts a fresh embedded source from the configured parent origin", () => {
    const manifest = twoCardManifest();
    const button = (manifest.components as Array<Record<string, unknown>>)[0]!;
    button.sourcePath = BUTTON_PATH;
    button.path = "data:text/html;base64,b2xk";
    const { hooks, window, document, grid } = setup(manifest);
    const freshSrc = "data:text/html;base64,bmV3";
    hooks.initHmr(document, {
      win: window,
      location: null,
      parentOrigin: "https://host.example",
    });

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "refresh", path: BUTTON_PATH, src: freshSrc },
        source: window.parent,
        origin: "https://host.example",
      }),
    );

    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toBe(freshSrc);
  });
});

describe("initHmr — polling fallback (AC4)", () => {
  /** A controllable interval seam: capture the callback, fire it on demand. */
  function fakeTimers(): {
    setIntervalImpl: (fn: () => void, ms: number) => number;
    clearIntervalImpl: (id: number) => void;
    fireAll: () => void;
    intervalMs: () => number | undefined;
    cleared: () => boolean;
  } {
    let cb: (() => void) | null = null;
    let ms: number | undefined;
    let cleared = false;
    return {
      setIntervalImpl: (fn, interval) => {
        cb = fn;
        ms = interval;
        return 1;
      },
      clearIntervalImpl: () => {
        cleared = true;
      },
      fireAll: () => cb && cb(),
      intervalMs: () => ms,
      cleared: () => cleared,
    };
  }

  it("falls back to polling when the WebSocket errors, and reloads changed cards", async () => {
    const { hooks, window, document, grid } = setup();
    FakeWebSocket.instances = [];
    const timers = fakeTimers();

    // The poll fetch returns a manifest with Button's hash bumped.
    const changed = twoCardManifest({ buttonHash: "sha256-button-v2" });
    const fetchImpl = async () => ({ ok: true, json: async () => changed }) as Response;

    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: FakeWebSocket,
      fetchImpl,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      initialManifest: twoCardManifest(), // baseline
      pollIntervalMs: 2000,
    });

    // No polling until the socket actually fails.
    expect(timers.intervalMs()).toBeUndefined();
    FakeWebSocket.instances[0]!.onerror!();
    // AC4 cadence.
    expect(timers.intervalMs()).toBe(2000);

    timers.fireAll();
    await new Promise((r) => setTimeout(r, 0)); // let the fetch().then microtasks settle

    expect(iframeFor(grid, BUTTON_PATH).getAttribute("src")).toMatch(/\?__genie_hmr=\d+$/);
    expect(iframeFor(grid, CARD_PATH).getAttribute("src")).toBe(CARD_PATH); // unchanged hash
    expect(document.getElementById("hmr-count")!.getAttribute("data-count")).toBe("1");
  });

  it("drains a manifest refresh queued behind an active polling fetch", async () => {
    const { hooks, window, document, grid } = setup();
    const timers = fakeTimers();
    const first = twoCardManifest();
    (first.components as unknown[]).splice(1, 1);
    const second = twoCardManifest();
    let resolveFirst!: (response: Response) => void;
    const firstFetch = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(firstFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => second } as Response);

    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: undefined,
      fetchImpl,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      initialManifest: twoCardManifest(),
    });

    timers.fireAll();
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { event: "manifest.changed" },
        source: window.parent,
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveFirst({ ok: true, json: async () => first } as Response);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(iframeFor(grid, CARD_PATH)).toBeDefined();
  });

  it("skips an overlapping poll tick while a message fetch is active", async () => {
    const { hooks, window, document, grid } = setup();
    const timers = fakeTimers();
    const first = twoCardManifest();
    (first.components as unknown[]).splice(1, 1);
    const second = twoCardManifest();
    let resolveFirst!: (response: Response) => void;
    const firstFetch = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(firstFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => second } as Response);

    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: undefined,
      fetchImpl,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      initialManifest: twoCardManifest(),
    });

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { event: "manifest.changed" },
        source: window.parent,
      }),
    );
    timers.fireAll();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveFirst({ ok: true, json: async () => first } as Response);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(grid.querySelector(`iframe[data-path="${CARD_PATH}"]`)).toBeNull();
  });

  it("polls from the start when a dev server is present but WebSocket is unavailable", () => {
    const { hooks, window, document } = setup();
    const timers = fakeTimers();
    hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: undefined, // no WS in this environment
      fetchImpl: async () => ({ ok: true, json: async () => twoCardManifest() }) as Response,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      initialManifest: twoCardManifest(),
    });
    expect(timers.intervalMs()).toBe(2000); // polling engaged immediately
  });

  it("does NOT poll on file:// (no dev server to fetch a manifest from)", () => {
    const { hooks, window, document } = setup();
    const timers = fakeTimers();
    hooks.initHmr(document, {
      win: window,
      location: { protocol: "file:", host: "" },
      WebSocketImpl: FakeWebSocket,
      fetchImpl: async () => ({ ok: true, json: async () => twoCardManifest() }) as Response,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    expect(timers.intervalMs()).toBeUndefined();
    expect(FakeWebSocket.instances.every((s) => s.url.startsWith("ws"))).toBe(true);
  });

  it("teardown clears the poll interval", () => {
    const { hooks, window, document } = setup();
    FakeWebSocket.instances = [];
    const timers = fakeTimers();
    const teardown = hooks.initHmr(document, {
      win: window,
      location: { protocol: "http:", host: "127.0.0.1:5173" },
      WebSocketImpl: undefined,
      fetchImpl: async () => ({ ok: true, json: async () => twoCardManifest() }) as Response,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      initialManifest: twoCardManifest(),
    });
    teardown();
    expect(timers.cleared()).toBe(true);
  });
});
