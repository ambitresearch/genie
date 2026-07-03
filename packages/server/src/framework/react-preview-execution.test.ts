/**
 * @vitest-environment jsdom
 *
 * React preview **execution** conformance (DRO-624 · AC3) — closes the
 * "asserted on bytes, never ran" gap in `adapter-conformance.test.ts`.
 *
 * The adapter's `renderPreview` emits an IIFE that resolves React from the M4
 * host globals (the preview host contract documented at the top of `react.ts`).
 * The old `external: [react]` config emitted `require("react")`, which throws
 * `Dynamic require of "react" is not supported` in a browser — invisible to a
 * text-substring assertion. This suite *executes* the emitted bundle the exact
 * way the M4 iframe host will:
 *
 *   1. provide `window.React` / `window.ReactDOM` (the vendored `_vendor/*` globals),
 *   2. evaluate `<Name>.preview.js` (top-level `var GenieComponent` → a `window` global
 *      in a browser `<script>`; here we return it out of the eval wrapper),
 *   3. mount `window.GenieComponent.default` via `window.ReactDOM.createRoot`,
 *
 * and asserts real DOM comes out — including interactivity (a `useState` click),
 * which proves the shared host React instance actually drives the component.
 *
 * ── Two environment reconciliations this file needs ──────────────────────────
 * 1. **esbuild ⨯ jsdom realm.** esbuild asserts
 *    `new TextEncoder().encode("") instanceof Uint8Array` at import time. Under
 *    vitest's jsdom environment that is *false* — jsdom's realm installs a
 *    `Uint8Array` distinct from the one `TextEncoder` emits. We realign the
 *    global to the constructor `TextEncoder` actually produces (both are the
 *    platform `Uint8Array`; only cross-realm identity is reconciled).
 * 2. **React dev build for `act`.** React picks its production vs development
 *    build from `process.env.NODE_ENV` *at import time*, and only the dev build
 *    exports `act` (needed to flush state updates deterministically). We set
 *    `NODE_ENV=development` and then **dynamically import** React/ReactDOM in
 *    `beforeAll`, so the env is set before the module bodies evaluate. (A static
 *    `import React` would be hoisted above the env assignment and load the prod
 *    build, where `act` is `undefined`.)
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import {
  ReactAdapter,
  PREVIEW_GLOBAL_NAME,
  REACT_HOST_GLOBAL,
  REACT_DOM_HOST_GLOBAL,
} from "./react.js";
import type { RenderInput } from "./interface.js";

// Reconciliation (1): make esbuild's Uint8Array invariant hold under jsdom,
// before `renderPreview` lazily imports esbuild.
{
  const probe = new TextEncoder().encode("");
  if (!(probe instanceof Uint8Array)) {
    (globalThis as { Uint8Array: unknown }).Uint8Array = probe.constructor;
  }
}

// Bound in beforeAll after NODE_ENV is pinned to the dev build (reconciliation 2).
let React: typeof import("react");
let act: (typeof import("react"))["act"];
let ReactDOMClient: typeof import("react-dom/client");

const adapter = new ReactAdapter();

/** A component exercising: automatic JSX runtime, `jsxs` (array children + `key`),
 *  a props interface, `useState`, and an event handler. */
const COUNTER_SOURCE = [
  'import { useState } from "react";',
  "export interface CounterProps { label: string; start?: number }",
  "export function Counter({ label, start = 0 }: CounterProps) {",
  "  const [n, setN] = useState(start);",
  "  return (",
  "    <section className='counter'>",
  "      <h2>{label}</h2>",
  "      <ul>{[1, 2, 3].map((i) => (<li key={i}>row {i}</li>))}</ul>",
  "      <button onClick={() => setN(n + 1)}>count: {n}</button>",
  "    </section>",
  "  );",
  "}",
  "export default Counter;",
].join("\n");

function input(source: string, overrides: Partial<RenderInput> = {}): RenderInput {
  return { componentName: "Counter", group: "actions", source, ...overrides };
}

/**
 * Emulate the M4 iframe host page: publish the React globals the vendored
 * `_vendor/*` bundles would, evaluate the preview IIFE, and hand back the
 * component global the bundle assigned. In a real browser the bundle's
 * top-level `var GenieComponent = …` becomes `window.GenieComponent`; a
 * `new Function` body is sloppy-mode global scope, so we return it explicitly.
 */
function loadPreviewOntoHost(bundleText: string): { default: unknown } {
  (window as unknown as Record<string, unknown>)[REACT_HOST_GLOBAL] = React;
  (window as unknown as Record<string, unknown>)[REACT_DOM_HOST_GLOBAL] = ReactDOMClient;
  const evalOnHost = new Function(`${bundleText}\n;return ${PREVIEW_GLOBAL_NAME};`);
  return evalOnHost() as { default: unknown };
}

let container: HTMLDivElement;

beforeAll(async () => {
  // Reconciliation (2): pin the dev build BEFORE React's module body evaluates.
  if (!process.env.NODE_ENV || process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "development";
  }
  React = await import("react");
  act = React.act;
  ReactDOMClient = await import("react-dom/client");
  // Tell React it is inside an act()-managed test so it flushes updates.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
});

describe("AC3 — React preview bundle executes against the host React global", () => {
  it("emits an IIFE with NO dynamic require — the DRO-624 regression guard", async () => {
    const file = await adapter.renderPreview(input(COUNTER_SOURCE));
    // The exact failure mode being fixed: esbuild's `require` shim + its throw.
    expect(file.content).not.toContain("Dynamic require");
    expect(file.content).not.toMatch(/\brequire\((['"])react\1\)/);
    expect(file.content).not.toMatch(/\brequire\((['"])react\/jsx-runtime\1\)/);
    // …and it references React through the documented host global instead.
    expect(file.content).toContain(`window.${REACT_HOST_GLOBAL}`);
  });

  it("mounts via window.ReactDOM + window.React and renders real DOM", async () => {
    const file = await adapter.renderPreview(input(COUNTER_SOURCE));
    const componentGlobal = loadPreviewOntoHost(file.content);
    const Counter = componentGlobal.default;

    // Mount exactly as the M4 host contract prescribes: read React/ReactDOM/the
    // component off the window globals, not the test's own imports.
    const win = window as unknown as {
      React: typeof React;
      ReactDOM: typeof ReactDOMClient;
    };
    const root = win.ReactDOM.createRoot(container);
    await act(async () => {
      root.render(win.React.createElement(Counter as never, { label: "Hello Genie" }));
    });

    // The component's own JSX became real DOM nodes.
    expect(container.querySelector("h2")?.textContent).toBe("Hello Genie");
    expect(container.querySelector("section")?.className).toBe("counter");
    // `jsxs` array children with `key` rendered all three list items.
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector("li")?.textContent).toBe("row 1");
    expect(container.querySelector("button")?.textContent).toBe("count: 0");

    await act(async () => root.unmount());
  });

  it("is interactive — a useState click updates through the host React instance", async () => {
    const file = await adapter.renderPreview(input(COUNTER_SOURCE));
    const Counter = loadPreviewOntoHost(file.content).default;

    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(React.createElement(Counter as never, { label: "Counter", start: 4 }));
    });
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("count: 4");

    // A real click must drive a real re-render — only possible if the bundle's
    // hooks resolved to the live host React, not a broken/duplicate copy.
    await act(async () => {
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("button")?.textContent).toBe("count: 5");

    await act(async () => root.unmount());
  });

  it("renders a component authored with a classic `import React` default import", async () => {
    const classic = [
      'import React from "react";',
      "export function Badge({ text }: { text: string }) {",
      "  return <span className='badge'>{text}</span>;",
      "}",
      "export default Badge;",
    ].join("\n");
    const file = await adapter.renderPreview(input(classic, { componentName: "Badge" }));
    expect(file.content).not.toContain("Dynamic require");

    const Badge = loadPreviewOntoHost(file.content).default;
    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(React.createElement(Badge as never, { text: "new" }));
    });
    expect(container.querySelector("span.badge")?.textContent).toBe("new");

    await act(async () => root.unmount());
  });
});
