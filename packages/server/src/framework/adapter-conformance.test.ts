/**
 * Adapter conformance suite (M2-08 · DRO-255 · AC5) — the framework adapter
 * contract, tested **independently of `conjure`** (no LLM, no MCP transport, no
 * `GENIE_LLM_*` env). It exercises:
 *
 *   - AC1 — every adapter satisfies the `FrameworkAdapter` interface
 *     (`renderSource` / `renderPreview` / `extractDts` / `defaultViewport`), plus
 *     the `promptDirective` metadata `conjure` reads.
 *   - AC2 — the React adapter's real codegen: `.tsx` source, an esbuild IIFE
 *     preview bundle exposing `GenieComponent`, and a `ts-morph`-extracted `.d.ts`.
 *   - AC3 — the Vue + HTML stubs throw a structured `NotYetImplementedError` with
 *     a tracking-issue link from every codegen method, yet still expose identity
 *     + viewport (so `conjure`'s adapter selection never breaks for them).
 *   - AC4 — the registry (`getAdapter`) maps each framework to the right adapter.
 */
import { describe, it, expect } from "vitest";

import {
  FRAMEWORKS,
  DEFAULT_FRAMEWORK,
  NotYetImplementedError,
  componentPath,
  getAdapter,
  type Framework,
  type FrameworkAdapter,
  type RenderInput,
} from "./interface.js";
import { ReactAdapter, PREVIEW_GLOBAL_NAME } from "./react.js";
import { VueAdapter, VUE_TRACKING_ISSUE } from "./vue.js";
import { HtmlAdapter, HTML_TRACKING_ISSUE } from "./html.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A representative React source: props interface + JSX return + default export. */
const REACT_SOURCE = [
  'import React from "react";',
  "export interface ButtonProps {",
  "  label: string;",
  "  variant?: 'primary' | 'ghost';",
  "  onClick?: () => void;",
  "}",
  "export function Button({ label, variant = 'primary', onClick }: ButtonProps) {",
  "  return <button className={variant} onClick={onClick}>{label}</button>;",
  "}",
  "export default Button;",
].join("\n");

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return { componentName: "Button", group: "actions", source: REACT_SOURCE, ...overrides };
}

const STUB_FRAMEWORKS: Framework[] = ["vue", "html"];

// ── AC1 — interface shape (every adapter) ─────────────────────────────────────

describe("AC1 — FrameworkAdapter interface", () => {
  const adapters: FrameworkAdapter[] = [new ReactAdapter(), new VueAdapter(), new HtmlAdapter()];

  it("declares the four contract members + promptDirective on every adapter", () => {
    for (const a of adapters) {
      expect(typeof a.renderSource).toBe("function");
      expect(typeof a.renderPreview).toBe("function");
      expect(typeof a.extractDts).toBe("function");
      expect(a.defaultViewport).toEqual({
        width: expect.any(Number),
        height: expect.any(Number),
      });
      expect(a.defaultViewport.width).toBeGreaterThan(0);
      expect(a.defaultViewport.height).toBeGreaterThan(0);
      // Metadata every adapter (stub included) exposes — `conjure` reads it.
      expect(a.promptDirective).toContain(`Target framework: ${a.framework}`);
    }
  });

  it("reports a framework identity in the FRAMEWORKS set", () => {
    for (const a of adapters) {
      expect(FRAMEWORKS).toContain(a.framework);
    }
  });

  it("componentPath builds a COMPONENT_SCHEMA-shaped path", () => {
    expect(componentPath(input(), "Button.tsx")).toBe("components/actions/Button/Button.tsx");
  });
});

// ── AC4 — registry maps framework → adapter ───────────────────────────────────

describe("AC4 — getAdapter registry", () => {
  it("resolves each framework to the matching adapter", async () => {
    expect((await getAdapter("react")).framework).toBe("react");
    expect((await getAdapter("vue")).framework).toBe("vue");
    expect((await getAdapter("html")).framework).toBe("html");
  });

  it("returns the same cached instance across calls", async () => {
    const a = await getAdapter("react");
    const b = await getAdapter("react");
    expect(a).toBe(b);
  });

  it("resolves an adapter for every FRAMEWORKS member", async () => {
    for (const fw of FRAMEWORKS) {
      const adapter = await getAdapter(fw);
      expect(adapter.framework).toBe(fw);
    }
  });

  it("DEFAULT_FRAMEWORK is react (the v1 framework)", () => {
    expect(DEFAULT_FRAMEWORK).toBe("react");
  });
});

// ── AC2 — React adapter codegen (the real implementation) ─────────────────────

describe("AC2 — ReactAdapter", () => {
  const react = new ReactAdapter();

  it("renderSource emits <Name>.tsx carrying the source verbatim", () => {
    const file = react.renderSource(input());
    expect(file.path).toBe("components/actions/Button/Button.tsx");
    expect(file.content).toBe(REACT_SOURCE);
    expect(file.mimeType).toBe("text/tsx");
  });

  it("renderPreview bundles to an IIFE exposing the component global", async () => {
    const file = await react.renderPreview(input());
    expect(file.path).toBe("components/actions/Button/Button.preview.js");
    expect(file.mimeType).toBe("text/javascript");
    // esbuild IIFE assigns the bundle to `var GenieComponent = (() => { … })()`.
    expect(file.content).toContain(PREVIEW_GLOBAL_NAME);
    expect(file.content).toContain("(() =>");
    // The component's own JSX/markup made it into the bundle.
    expect(file.content).toContain("button");
  });

  it("renderPreview does not inline React (host provides it as an external)", async () => {
    const file = await react.renderPreview(input());
    // React is external → its source is not bundled in. A crude but effective
    // check: the whole of react-dom's internals never appear.
    expect(file.content).not.toContain("react-dom.production");
  });

  it("extractDts emits a <Name>.d.ts with the component's exported types", async () => {
    const file = await react.extractDts(input());
    expect(file.path).toBe("components/actions/Button/Button.d.ts");
    expect(file.content).toContain("ButtonProps");
    expect(file.content).toContain("label: string");
    expect(file.content).toContain("Button");
  });

  it("extractDts falls back to a valid empty module for a source with no exports", async () => {
    const file = await react.extractDts(
      input({ source: "const x = 1;", componentName: "Noop", group: "misc" }),
    );
    // Always a valid .d.ts artefact, never an empty string.
    expect(file.content.length).toBeGreaterThan(0);
    expect(file.path).toBe("components/misc/Noop/Noop.d.ts");
  });

  it("all React artefacts live under components/<group>/<Name>/", async () => {
    const src = react.renderSource(input());
    const prev = await react.renderPreview(input());
    const dts = await react.extractDts(input());
    for (const f of [src, prev, dts]) {
      expect(f.path.startsWith("components/actions/Button/")).toBe(true);
    }
  });
});

// ── AC3 — Vue + HTML stubs throw a structured, linked error ───────────────────

describe("AC3 — Vue/HTML stubs", () => {
  it("Vue codegen methods reject with NotYetImplementedError + tracking link", async () => {
    const vue = new VueAdapter();
    expect(() => vue.renderSource(input())).toThrow(NotYetImplementedError);
    await expect(vue.renderPreview(input())).rejects.toBeInstanceOf(NotYetImplementedError);
    await expect(vue.extractDts(input())).rejects.toBeInstanceOf(NotYetImplementedError);
    try {
      vue.renderSource(input());
    } catch (err) {
      const e = err as NotYetImplementedError;
      expect(e.code).toBe("ERR_FRAMEWORK_NOT_IMPLEMENTED");
      expect(e.framework).toBe("vue");
      expect(e.trackingIssue).toBe(VUE_TRACKING_ISSUE);
      expect(e.message).toContain(VUE_TRACKING_ISSUE);
    }
  });

  it("HTML codegen methods reject with NotYetImplementedError + tracking link", async () => {
    const html = new HtmlAdapter();
    expect(() => html.renderSource(input())).toThrow(NotYetImplementedError);
    await expect(html.renderPreview(input())).rejects.toBeInstanceOf(NotYetImplementedError);
    await expect(html.extractDts(input())).rejects.toBeInstanceOf(NotYetImplementedError);
    try {
      html.renderSource(input());
    } catch (err) {
      const e = err as NotYetImplementedError;
      expect(e.code).toBe("ERR_FRAMEWORK_NOT_IMPLEMENTED");
      expect(e.framework).toBe("html");
      expect(e.trackingIssue).toBe(HTML_TRACKING_ISSUE);
      expect(e.message).toContain(HTML_TRACKING_ISSUE);
    }
  });

  it("the tracking-issue links point at the genie repo (v2 milestone)", () => {
    for (const url of [VUE_TRACKING_ISSUE, HTML_TRACKING_ISSUE]) {
      expect(url).toMatch(/^https:\/\/github\.com\/roshangautam\/genie\/issues\/\d+$/);
    }
  });

  it("stubs still expose identity + viewport (selection never breaks for them)", () => {
    for (const fw of STUB_FRAMEWORKS) {
      const adapter = fw === "vue" ? new VueAdapter() : new HtmlAdapter();
      expect(adapter.framework).toBe(fw);
      expect(adapter.defaultViewport.width).toBeGreaterThan(0);
      expect(adapter.promptDirective).toContain(`Target framework: ${fw}`);
    }
  });
});
