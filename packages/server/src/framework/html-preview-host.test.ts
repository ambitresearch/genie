/**
 * HTML preview host-contract execution suite (DRO-617 · v2) — the vanilla-HTML
 * analogue of `react-preview-host.test.ts` / `vue-preview-host.test.ts`, closing
 * the same "asserted on bytes, never ran" gap for the HTML adapter.
 *
 * `adapter-conformance.test.ts` asserts on the *text* of the HTML preview bundle
 * (that it contains `GenieComponent`, a `mount()`, the component's markup). That
 * text can look right while the bundle fails to mount — a broken IIFE, markup that
 * never lands in the DOM, or an inline `<script>` that silently never runs (an
 * `innerHTML` assignment parses `<script>` elements but does not execute them).
 * This suite **executes** the emitted bundle inside a jsdom window and asserts the
 * component actually mounts, injects its styles, and runs its inline script — the
 * real preview-host behaviour.
 *
 * ── Environment ───────────────────────────────────────────────────────────────
 * The repo's default vitest environment is `node`; this file drives jsdom
 * *programmatically* (a fresh `JSDOM` per test) rather than switching the global
 * test environment, mirroring `vue-preview-host.test.ts` and staying isolated from
 * the rest of the node-env suite.
 *
 * ── Why no host global ────────────────────────────────────────────────────────
 * Unlike React/Vue, a vanilla-HTML preview has no framework runtime to resolve, so
 * there is no vendored `_vendor/*.js` global to load first — the bundle is fully
 * self-contained. `runScripts: "dangerously"` is required because the whole point
 * of the HTML mount path is that re-injected inline `<script>` elements execute.
 */
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";

import { HtmlAdapter } from "./html.js";
import { PREVIEW_GLOBAL_NAME } from "./react.js";
import type { RenderInput } from "./interface.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    componentName: "Button",
    group: "actions",
    source: [
      '<button class="btn" type="button">Click me</button>',
      "<style>.btn { color: rgb(10, 20, 30); }</style>",
    ].join("\n"),
    ...overrides,
  };
}

/**
 * A component whose inline `<script>` mutates the DOM on mount — so the test can
 * prove the re-injected script actually executed (an `innerHTML` assignment alone
 * would parse but never run it).
 */
const INTERACTIVE_SOURCE = [
  '<output id="out">idle</output>',
  "<script>",
  '  document.getElementById("out").textContent = "ran";',
  "  window.__genieHtmlRan = (window.__genieHtmlRan || 0) + 1;",
  "</script>",
].join("\n");

// ── Preview host harness ──────────────────────────────────────────────────────

interface PreviewHost {
  window: JSDOM["window"];
  container: HTMLElement;
  /** The namespace the bundle exposed on `window.GenieComponent`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exported: any;
}

/**
 * Build a fresh jsdom window that mimics the M4 preview host and evaluate the
 * adapter's emitted bundle in it. `runScripts: "dangerously"` so re-injected
 * inline `<script>` elements execute (the vanilla-HTML interactivity contract).
 */
function makeHost(bundle: string): PreviewHost {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`,
    { runScripts: "dangerously", pretendToBeVisual: true },
  );
  const { window } = dom;
  window.eval(bundle);
  const container = window.document.getElementById("root");
  if (!container) throw new Error("test harness: #root missing");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exported = (window as any)[PREVIEW_GLOBAL_NAME];
  return { window, container: container as unknown as HTMLElement, exported };
}

// ── the emitted bundle executes in a plain browser window ──────────────────────

describe("HTML preview bundle executes in a plain browser window", () => {
  const html = new HtmlAdapter();

  it("exposes the component on the preview global with default/name/mount handles", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);
    expect(host.exported).toBeTruthy();
    // The cross-framework `{ default, <Name> }` shape, plus the html-specific
    // `mount` alias and the raw `html` string.
    expect(typeof host.exported.default).toBe("function");
    expect(typeof host.exported.Button).toBe("function");
    expect(typeof host.exported.mount).toBe("function");
    expect(host.exported.default).toBe(host.exported.mount);
    expect(typeof host.exported.html).toBe("string");
  });

  it("mount(target) renders the component markup into the target", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);
    host.exported.mount(host.container);

    const button = host.container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Click me");
    expect(button?.classList.contains("btn")).toBe(true);
  });

  it("carries the inline <style> into the mounted output", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);
    host.exported.mount(host.container);

    const style = host.container.querySelector("style");
    expect(style?.textContent).toContain("color: rgb(10, 20, 30)");
  });

  it("re-injects and executes an inline <script> on mount", async () => {
    const file = await html.renderPreview(
      input({ componentName: "Panel", group: "surfaces", source: INTERACTIVE_SOURCE }),
    );
    const host = makeHost(file.content);
    host.exported.mount(host.container);

    // The re-injected script ran: it mutated its own element and a window flag.
    expect(host.container.querySelector("#out")?.textContent).toBe("ran");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((host.window as any).__genieHtmlRan).toBe(1);
  });

  it("mount(target) is idempotent — re-mounting replaces, never appends", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);
    host.exported.mount(host.container);
    host.exported.mount(host.container);
    // innerHTML assignment replaces content, so exactly one button after two mounts.
    expect(host.container.querySelectorAll("button")).toHaveLength(1);
  });

  it("mount(null) throws a clear error rather than silently no-op'ing", async () => {
    const file = await html.renderPreview(input());
    const host = makeHost(file.content);
    expect(() => host.exported.mount(null)).toThrow(/mount\(target\) requires a target/);
  });

  it("mounts using the target's own ownerDocument (not a captured document)", async () => {
    // Proves the mounter works against a target's own document — it creates the
    // fresh <script> via `target.ownerDocument`, never an ambient `document` the
    // bundle closure doesn't have. Uses a *detached* node: DOM manipulation
    // (innerHTML + node replacement) succeeds on it without error, so the markup
    // lands. (The inline <script> deliberately does NOT run here — browsers and
    // jsdom alike only execute a <script> once it is connected to the document;
    // the "executes on mount" behaviour is covered above with an attached
    // container. What this asserts is that mount reaches ownerDocument.createElement
    // and completes without throwing on a node from any document.)
    const file = await html.renderPreview(
      input({ componentName: "Panel", group: "surfaces", source: INTERACTIVE_SOURCE }),
    );
    const host = makeHost(file.content);
    const detached = host.window.document.createElement("div");
    expect(() => host.exported.mount(detached)).not.toThrow();
    // The markup rendered (the <output> is present, still at its pre-script value).
    expect(detached.querySelector("#out")?.textContent).toBe("idle");
  });
});
