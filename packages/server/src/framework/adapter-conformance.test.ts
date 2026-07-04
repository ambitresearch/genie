/**
 * Adapter conformance suite (M2-08 · DRO-255 · AC5) — the framework adapter
 * contract, tested **independently of `conjure`** (no LLM, no MCP transport, no
 * `GENIE_LLM_*` env). It exercises:
 *
 *   - AC1 — every adapter satisfies the `FrameworkAdapter` interface
 *     (`renderSource` / `renderPreview` / `extractDts` / `defaultViewport`), plus
 *     the `promptDirective` metadata `conjure` reads.
 *   - AC2 — the React + Vue adapters' real codegen: their canonical source file,
 *     an esbuild IIFE preview bundle exposing `GenieComponent`, and a
 *     `ts-morph`-extracted `.d.ts`.
 *   - AC3 — the remaining HTML stub throws a structured `NotYetImplementedError`
 *     with a tracking-issue link from every codegen method, yet still exposes
 *     identity + viewport (so `conjure`'s adapter selection never breaks for it).
 *     Vue graduated out of the stub set in v2 (DRO-616).
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

/**
 * A representative Vue SFC: an exported props interface passed to `defineProps`
 * (so `extractDts` can surface it), an event via `defineEmits`, a `<template>`
 * with a bound class + interpolation, and a `<style scoped>` block (so the
 * preview must compile + carry scoped CSS).
 */
const VUE_SOURCE = [
  '<script setup lang="ts">',
  "export interface ButtonProps {",
  "  label: string;",
  "  variant?: 'primary' | 'ghost';",
  "}",
  "const props = withDefaults(defineProps<ButtonProps>(), { variant: 'primary' });",
  "const emit = defineEmits<{ (e: 'press'): void }>();",
  "</script>",
  "",
  "<template>",
  '  <button :class="props.variant" @click="emit(\'press\')">{{ props.label }}</button>',
  "</template>",
  "",
  "<style scoped>",
  "button { padding: 8px 12px; }",
  "</style>",
].join("\n");

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return { componentName: "Button", group: "actions", source: REACT_SOURCE, ...overrides };
}

/** Fixture for the Vue adapter: same identity, Vue SFC source. */
function vueInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return { componentName: "Button", group: "actions", source: VUE_SOURCE, ...overrides };
}

// Only HTML remains stubbed in v2 — Vue graduated to a real adapter (DRO-616).
const STUB_FRAMEWORKS: Framework[] = ["html"];

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

  it("renderPreview does not inline React (host provides it as a global)", async () => {
    const file = await react.renderPreview(input());
    // React is resolved from the host's `window.React` global (the preview host
    // contract — see react.ts), not bundled in. A crude but effective check:
    // the whole of react-dom's internals never appear.
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

// ── AC2 — Vue adapter codegen (the DRO-616 v2 implementation) ──────────────────

describe("AC2 — VueAdapter", () => {
  const vue = new VueAdapter();

  it("has vue identity + a viewport + a Vue-shaped prompt directive", () => {
    expect(vue.framework).toBe("vue");
    expect(vue.defaultViewport.width).toBeGreaterThan(0);
    expect(vue.defaultViewport.height).toBeGreaterThan(0);
    expect(vue.promptDirective).toContain("Target framework: vue");
    // The directive steers the model toward the SFC shape extractDts relies on.
    expect(vue.promptDirective).toContain("Single File Component");
    expect(vue.promptDirective).toContain("defineProps");
  });

  it("renderSource emits <Name>.vue carrying the SFC verbatim", () => {
    const file = vue.renderSource(vueInput());
    expect(file.path).toBe("components/actions/Button/Button.vue");
    expect(file.content).toBe(VUE_SOURCE);
    // Matches the MIME the kit-file classifier maps `.vue` to.
    expect(file.mimeType).toBe("text/x-vue");
  });

  it("renderPreview bundles the SFC to an IIFE exposing the component global", async () => {
    const file = await vue.renderPreview(vueInput());
    expect(file.path).toBe("components/actions/Button/Button.preview.js");
    expect(file.mimeType).toBe("text/javascript");
    // esbuild IIFE assigns the bundle to `var GenieComponent = (() => { … })()`.
    expect(file.content).toContain(PREVIEW_GLOBAL_NAME);
    expect(file.content).toContain("(() =>");
    // The compiled template's element made it into the bundle.
    expect(file.content).toContain("button");
    // The scoped <style> was compiled and carried in the preview.
    expect(file.content).toContain("padding: 8px 12px");
  });

  it("renderPreview resolves Vue from the host global (no inlined/require'd runtime)", async () => {
    const file = await vue.renderPreview(vueInput());
    // Vue is resolved from the host's `window.Vue` global (the preview host
    // contract — see vue.ts), not bundled in and not left as a throwing
    // `require("vue")` (the DRO-624 failure mode, guarded here for Vue too).
    expect(file.content).toContain("window.Vue");
    expect(file.content).not.toMatch(/[^_.\w]require\("vue/);
    expect(file.content).not.toContain("Dynamic require of");
  });

  it("renderPreview compiles a template-only SFC (no <script> block)", async () => {
    const file = await vue.renderPreview(
      vueInput({
        componentName: "Badge",
        group: "display",
        source: [
          '<template><span class="badge">Static</span></template>',
          "<style scoped>.badge { color: red; }</style>",
        ].join("\n"),
      }),
    );
    expect(file.path).toBe("components/display/Badge/Badge.preview.js");
    expect(file.content).toContain(PREVIEW_GLOBAL_NAME);
    expect(file.content).toContain("badge");
  });

  it("renderPreview surfaces a Vue parse error rather than emitting a broken bundle", async () => {
    await expect(
      // An unterminated <template> is a hard SFC parse error.
      vue.renderPreview(vueInput({ source: "<template><div></template>" })),
    ).rejects.toThrow(/Vue (SFC parse|template compile) failed/);
  });

  it("extractDts emits a <Name>.d.ts with the SFC's exported prop types", async () => {
    const file = await vue.extractDts(vueInput());
    expect(file.path).toBe("components/actions/Button/Button.d.ts");
    expect(file.content).toContain("ButtonProps");
    expect(file.content).toContain("label: string");
  });

  it("extractDts falls back to a valid empty module for an SFC with no exports", async () => {
    const file = await vue.extractDts(
      vueInput({
        componentName: "Inline",
        group: "misc",
        // Inline (non-exported) prop types → nothing to emit.
        source: [
          '<script setup lang="ts">',
          "defineProps<{ n: number }>();",
          "</script>",
          "<template><i>{{ n }}</i></template>",
        ].join("\n"),
      }),
    );
    expect(file.content.length).toBeGreaterThan(0);
    expect(file.path).toBe("components/misc/Inline/Inline.d.ts");
  });

  it("all Vue artefacts live under components/<group>/<Name>/", async () => {
    const src = vue.renderSource(vueInput());
    const prev = await vue.renderPreview(vueInput());
    const dts = await vue.extractDts(vueInput());
    for (const f of [src, prev, dts]) {
      expect(f.path.startsWith("components/actions/Button/")).toBe(true);
    }
  });
});

// ── AC3 — the remaining HTML stub throws a structured, linked error ───────────

describe("AC3 — HTML stub", () => {
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
    // VUE_TRACKING_ISSUE is retained for provenance even though Vue is now a real
    // adapter (DRO-616); it and the HTML stub's link must stay genie-repo URLs.
    for (const url of [VUE_TRACKING_ISSUE, HTML_TRACKING_ISSUE]) {
      expect(url).toMatch(/^https:\/\/github\.com\/roshangautam\/genie\/issues\/\d+$/);
    }
  });

  it("stubs still expose identity + viewport (selection never breaks for them)", () => {
    for (const fw of STUB_FRAMEWORKS) {
      const adapter = new HtmlAdapter();
      expect(adapter.framework).toBe(fw);
      expect(adapter.defaultViewport.width).toBeGreaterThan(0);
      expect(adapter.promptDirective).toContain(`Target framework: ${fw}`);
    }
  });
});
