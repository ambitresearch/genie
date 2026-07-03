/**
 * React preview host-contract execution suite (DRO-624 · AC3) — closes the
 * "asserted on bytes, never ran" gap the M2-08 conformance test left open.
 *
 * `adapter-conformance.test.ts` only asserts on the *text* of the preview bundle
 * (that it contains `GenieComponent`, `(() =>`, `button`). That never catches the
 * DRO-624 bug: the original `external`-marked config emitted a bundle whose text
 * looked right but threw `Dynamic require of "react" is not supported` the moment
 * it evaluated in a browser. This suite **executes** the emitted bundle inside a
 * jsdom window with the host-provided React globals (the vendored `_vendor/react*`
 * runtime the preview iframe supplies per PRD §6.6 / FR-056) and asserts the
 * component actually mounts and renders — the real preview-host contract.
 *
 * ── Environment ───────────────────────────────────────────────────────────────
 * The repo's default vitest environment is `node`; this file drives jsdom
 * *programmatically* (a fresh `JSDOM` per test with the vendored React/ReactDOM
 * UMD builds eval'd in) rather than switching the global test environment, so it
 * mirrors the real contract — a bare iframe window that only has what the host
 * page injected — and stays isolated from the rest of the node-env suite.
 *
 * ── Why React 18 UMD ──────────────────────────────────────────────────────────
 * The host-global contract needs a runtime that ships a UMD build defining a
 * `window.React` global. React 19 dropped the UMD builds, so both the vendored
 * `_vendor/react*.min.js` and this test pin the React 18 UMD production bundles.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";

import {
  ReactAdapter,
  PREVIEW_GLOBAL_NAME,
  REACT_HOST_GLOBAL,
  REACT_DOM_HOST_GLOBAL,
} from "./react.js";
import type { RenderInput } from "./interface.js";

const require = createRequire(import.meta.url);

// ── Vendored runtime (stands in for `_vendor/react*.production.min.js`) ────────
//
// Resolve the UMD builds off the package directory: React 18's `exports` map
// blocks the `./umd/*` subpath from `require.resolve`, but the files ship in the
// package, so we resolve `package.json` and swap the basename. These UMD bundles
// self-assign `window.React` / `window.ReactDOM` when eval'd — exactly what the
// preview iframe host does with the kit's vendored copies.
function umd(pkg: string, file: string): string {
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return readFileSync(pkgJson.replace(/package\.json$/, `umd/${file}`), "utf8");
}
const REACT_UMD = umd("react", "react.production.min.js");
const REACT_DOM_UMD = umd("react-dom", "react-dom.production.min.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    componentName: "Button",
    group: "actions",
    source: [
      'import React from "react";',
      "export interface ButtonProps {",
      "  label: string;",
      "  variant?: 'primary' | 'ghost';",
      "}",
      "export function Button({ label, variant = 'primary' }: ButtonProps) {",
      "  return <button className={variant}>{label}</button>;",
      "}",
      "export default Button;",
    ].join("\n"),
    ...overrides,
  };
}

/**
 * A component that exercises the automatic-runtime surface a naive shim breaks
 * on: `jsxs` (an element with multiple children), a `<>…</>` Fragment, a
 * `useState` hook (so the bundle and host must share one React identity), and a
 * keyed `.map()`.
 */
const PANEL_SOURCE = [
  'import React, { useState } from "react";',
  "export function Panel({ items }: { items: string[] }) {",
  "  const [count] = useState(items.length);",
  "  return (",
  "    <>",
  "      <h2>{count} items</h2>",
  "      <ul>",
  "        {items.map((it) => (",
  "          <li key={it}>{it}</li>",
  "        ))}",
  "      </ul>",
  "    </>",
  "  );",
  "}",
  "export default Panel;",
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
 * Build a fresh jsdom window that mimics the M4 preview iframe: it loads the
 * vendored React/ReactDOM globals, then evaluates the adapter's emitted bundle.
 * `loadReact` can be false to prove the bundle *needs* the host globals (it must
 * throw the contract error rather than silently misbehave).
 */
function makeHost(bundle: string, loadReact = true): PreviewHost {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  if (loadReact) {
    window.eval(REACT_UMD);
    window.eval(REACT_DOM_UMD);
  }
  window.eval(bundle);
  const container = window.document.getElementById("root");
  if (!container) throw new Error("test harness: #root missing");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exported = (window as any)[PREVIEW_GLOBAL_NAME];
  return { window, container: container as unknown as HTMLElement, exported };
}

/** Mount an exported component into the host's #root using the host's ReactDOM. */
function mount(host: PreviewHost, props: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = host.window as any;
  const React = w[REACT_HOST_GLOBAL];
  const ReactDOM = w[REACT_DOM_HOST_GLOBAL];
  const root = ReactDOM.createRoot(host.container);
  // flushSync: render synchronously so assertions can read the DOM immediately.
  ReactDOM.flushSync(() => {
    root.render(React.createElement(host.exported.default, props));
  });
}

// ── AC3 — the emitted bundle executes against the host React globals ──────────

describe("AC3 — React preview bundle executes in a host with vendored React globals", () => {
  const react = new ReactAdapter();

  it("the vendored UMD builds self-assign window.React / window.ReactDOM", () => {
    // Guards the harness itself: if these globals don't appear, every downstream
    // 'renders' assertion would be meaningless.
    const host = makeHost("/* no bundle side effects */ var GenieComponent = {};");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = host.window as any;
    expect(typeof w[REACT_HOST_GLOBAL]).toBe("object");
    expect(String(w[REACT_HOST_GLOBAL].version)).toMatch(/^18\./);
    expect(typeof w[REACT_DOM_HOST_GLOBAL].createRoot).toBe("function");
  });

  it("emits a bundle with no throwing dynamic `require` and referencing the host global", async () => {
    const file = await react.renderPreview(input());
    // The DRO-624 regression guard: the old `external` config emitted esbuild's
    // `Dynamic require of "..." is not supported` shim. The fix must not.
    expect(file.content).not.toContain("Dynamic require of");
    expect(file.content).not.toMatch(/[^_.\w]require\("react/);
    // …and it resolves React from the host global instead.
    expect(file.content).toContain(`window.${REACT_HOST_GLOBAL}`);
  });

  it("mounts the component and renders its DOM (no Dynamic require error)", async () => {
    const file = await react.renderPreview(input());
    const host = makeHost(file.content);

    // The bundle exposed the component on the preview global.
    expect(host.exported).toBeTruthy();
    expect(typeof host.exported.default).toBe("function");

    mount(host, { label: "Click me", variant: "ghost" });

    const button = host.container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Click me");
    expect(button?.className).toBe("ghost");
  });

  it("renders automatic-runtime features: jsxs children, Fragment, hooks, keyed map", async () => {
    const file = await react.renderPreview(
      input({ componentName: "Panel", group: "surfaces", source: PANEL_SOURCE }),
    );
    const host = makeHost(file.content);
    mount(host, { items: ["a", "b", "c"] });

    // useState(items.length) resolved to 3 → bundle & host share one React.
    expect(host.container.querySelector("h2")?.textContent).toBe("3 items");
    // jsxs + keyed map produced three <li>.
    expect(host.container.querySelectorAll("li")).toHaveLength(3);
    expect(host.container.querySelector("ul")?.textContent).toBe("abc");
    // Fragment flattened: <h2> and <ul> are direct children of #root, no wrapper.
    expect(host.container.children).toHaveLength(2);
  });

  it("throws the preview-host-contract error when the host global is absent", async () => {
    const file = await react.renderPreview(input());
    // Evaluating the bundle in a window WITHOUT the vendored React must fail
    // loudly with the adapter's contract message — not silently mis-mount.
    expect(() => makeHost(file.content, /* loadReact */ false)).toThrow(
      /preview host contract violated: window\.React is not defined/,
    );
  });
});
