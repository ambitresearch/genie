/**
 * HTML preview host-contract execution suite (DRO-617 · v2) — the vanilla-HTML
 * analogue of `react-preview-host.test.ts` / `vue-preview-host.test.ts`, closing
 * the same "asserted on bytes, never ran" gap for the HTML adapter.
 *
 * `adapter-conformance.test.ts` asserts on the *text* of the HTML preview bundle
 * (that it contains `GenieComponent`, `(function ()`, the markup). That text can
 * look right while the bundle fails to mount — a botched descriptor shape, markup
 * that doesn't round-trip, or (the real HTML-specific hazard) an inline `<script>`
 * that never runs because it was inserted via `innerHTML` (spec: such scripts are
 * inert). This suite **executes** the emitted bundle inside a jsdom window,
 * reads `window.GenieComponent`, calls the descriptor's `mount(container)`, and
 * asserts the component actually renders — and that its inline script re-executes.
 *
 * ── Environment ───────────────────────────────────────────────────────────────
 * The repo's default vitest environment is `node`; this file drives jsdom
 * *programmatically* (a fresh `JSDOM` per test) rather than switching the global
 * test environment, mirroring the React/Vue host suites.
 *
 * ── Why `runScripts: "dangerously"` (not `outside-only`) ───────────────────────
 * The React/Vue suites use `runScripts: "outside-only"` — they only `window.eval`
 * the bundle and mount via a framework API, never executing an in-DOM `<script>`.
 * The HTML adapter's `mount()` deliberately *re-creates* each inline `<script>`
 * so the browser runs it (markup set via `innerHTML` yields inert scripts). To
 * verify that re-execution actually happens, jsdom must be allowed to run in-page
 * scripts — `"dangerously"` (a superset that still enables `window.eval`). This is
 * a controlled, self-authored fixture, not untrusted input.
 */
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";

import { HtmlAdapter, PREVIEW_HTML_KEY } from "./html.js";
import { PREVIEW_GLOBAL_NAME } from "./react.js";
import type { RenderInput } from "./interface.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    componentName: "Button",
    group: "actions",
    source: [
      "<style>.btn { color: rgb(10, 20, 30); }</style>",
      '<button class="btn">Click me</button>',
    ].join("\n"),
    ...overrides,
  };
}

/**
 * A component whose inline `<script>` mutates the DOM on execution. If `mount`
 * merely set `innerHTML` (leaving the script inert), `#status` would still read
 * "idle"; a working re-execution flips it to "ready" — the real interactivity
 * contract for a vanilla-HTML card.
 */
const INTERACTIVE_SOURCE = [
  '<output id="status">idle</output>',
  '<button id="tick" data-count="0">Tick</button>',
  "<script>",
  '  document.getElementById("status").textContent = "ready";',
  '  var b = document.getElementById("tick");',
  '  b.addEventListener("click", function () {',
  '    var n = Number(b.getAttribute("data-count")) + 1;',
  '    b.setAttribute("data-count", String(n));',
  '    document.getElementById("status").textContent = "clicked " + n;',
  "  });",
  "</script>",
].join("\n");

// ── Preview host harness ──────────────────────────────────────────────────────

interface PreviewHost {
  window: JSDOM["window"];
  container: HTMLElement;
  /** The component namespace the bundle exposed on `window.GenieComponent`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exported: any;
}

/**
 * Build a fresh jsdom window that mimics the M4 preview iframe and evaluates the
 * adapter's emitted bundle. A vanilla-HTML preview needs **no** vendored runtime
 * global (the browser is the runtime), so — unlike the React/Vue harnesses —
 * there is nothing to load before the bundle.
 */
function makeHost(bundle: string): PreviewHost {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`,
    {
      // "dangerously" so the re-created inline <script> actually runs (see the
      // module doc); it still enables the window.eval used to load the bundle.
      runScripts: "dangerously",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  window.eval(bundle);
  const container = window.document.getElementById("root");
  if (!container) throw new Error("test harness: #root missing");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exported = (window as any)[PREVIEW_GLOBAL_NAME];
  return { window, container: container as unknown as HTMLElement, exported };
}

/** Mount the exported component into the host's #root via the descriptor's mount(). */
function mount(host: PreviewHost): void {
  host.exported.default.mount(host.container);
}

// ── the emitted bundle executes and mounts in a bare browser window ───────────

describe("HTML preview bundle executes and mounts in a bare browser window", () => {
  const html = new HtmlAdapter();

  it("exposes { default, <Name> } on window.GenieComponent (both the same descriptor)", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);

    expect(host.exported).toBeTruthy();
    expect(host.exported.default).toBeTruthy();
    // The named export and `default` point at the identical descriptor object.
    expect(host.exported.Button).toBe(host.exported.default);
    expect(host.exported.default.framework).toBe("html");
    expect(typeof host.exported.default.mount).toBe("function");
  });

  it("carries the component markup through verbatim on the descriptor", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);
    // Pass-through fidelity: the descriptor's markup is byte-identical to source.
    expect(host.exported.default[PREVIEW_HTML_KEY]).toBe(input().source);
  });

  it("mounts the markup into the container with props/styles intact", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);
    mount(host);

    const button = host.container.querySelector("button.btn");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Click me");
    // The inline <style> came across in the mounted markup.
    expect(host.container.querySelector("style")?.textContent).toContain("rgb(10, 20, 30)");
  });

  it("re-executes an inline <script> so interactivity works (not inert innerHTML)", async () => {
    const file = await html.renderPreview(
      input({ componentName: "Counter", group: "actions", source: INTERACTIVE_SOURCE }),
    );
    const host = makeHost(file.content);
    mount(host);

    // The script ran on mount and flipped the status from its inert "idle".
    const status = host.container.querySelector("#status");
    expect(status?.textContent).toBe("ready");

    // …and the listener it registered responds to a click — proving the script
    // truly executed rather than being carried as inert markup.
    const tick = host.container.querySelector("#tick") as unknown as HTMLElement;
    tick.dispatchEvent(new host.window.Event("click"));
    expect(status?.textContent).toBe("clicked 1");
    tick.dispatchEvent(new host.window.Event("click"));
    expect(status?.textContent).toBe("clicked 2");
  });

  it("is self-contained: evaluating the bundle needs no host runtime global", async () => {
    const file = await html.renderPreview(input());
    // Unlike React/Vue, there is no window.React / window.Vue precondition — the
    // bundle must expose its global with nothing else loaded and never throw.
    expect(() => makeHost(file.content)).not.toThrow();
    const host = makeHost(file.content);
    expect(host.exported.default.framework).toBe("html");
  });

  it("mount() is defensive: a nullish container is a no-op, not a throw", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);
    // The M4 grid may call mount before a card element exists; that must not throw.
    expect(() => host.exported.default.mount(null)).not.toThrow();
  });
});
