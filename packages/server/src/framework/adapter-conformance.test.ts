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
 *   - AC2 (cont.) — the HTML adapter's real codegen (DRO-617): its canonical
 *     `<Name>.html` source, a bundler-free preview IIFE exposing `GenieComponent`
 *     with a `mount()`, and a valid empty-module `.d.ts`.
 *   - AC3 — no frameworks remain stubbed in v2 (Vue → DRO-616, HTML → DRO-617);
 *     the `NotYetImplementedError` contract is retained (exercised directly) for a
 *     future stubbed framework, and the tracking-issue links stay genie-repo URLs.
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

/**
 * A representative vanilla-HTML component: semantic markup, an inline `<style>`,
 * and an inline `<script>` (so the preview must carry the JS and the source is a
 * self-contained, browser-ready document fragment).
 */
const HTML_SOURCE = [
  '<!-- @genie group="actions" -->',
  '<button class="btn" type="button">Click me</button>',
  "<style>",
  "  .btn { padding: 8px 12px; color: rgb(10, 20, 30); }",
  "</style>",
  "<script>",
  '  document.currentScript.previousElementSibling?.addEventListener("click", () => {});',
  "</script>",
].join("\n");

/** Fixture for the HTML adapter: same identity, vanilla-HTML source. */
function htmlInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return { componentName: "Button", group: "actions", source: HTML_SOURCE, ...overrides };
}

// No frameworks remain stubbed in v2: Vue graduated in DRO-616, HTML in DRO-617.
// Kept as an (empty) array so the "stubs still expose identity + viewport"
// invariant re-arms automatically the day a *new* stubbed framework is added.
const STUB_FRAMEWORKS: Framework[] = [];

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

// ── AC2 — HTML adapter codegen (the DRO-617 v2 implementation) ─────────────────

describe("AC2 — HtmlAdapter", () => {
  const html = new HtmlAdapter();

  it("has html identity + a viewport + an HTML-shaped prompt directive", () => {
    expect(html.framework).toBe("html");
    expect(html.defaultViewport.width).toBeGreaterThan(0);
    expect(html.defaultViewport.height).toBeGreaterThan(0);
    expect(html.promptDirective).toContain("Target framework: html");
    // The directive steers the model toward the self-contained vanilla-HTML shape.
    expect(html.promptDirective).toContain("self-contained vanilla HTML");
  });

  it("renderSource emits <Name>.html carrying the markup verbatim", () => {
    const file = html.renderSource(htmlInput());
    expect(file.path).toBe("components/actions/Button/Button.html");
    expect(file.content).toBe(HTML_SOURCE);
    // Matches the MIME the whole kit pipeline uses for `.html`.
    expect(file.mimeType).toBe("text/html");
  });

  it("renderPreview emits an IIFE exposing the component global with a mount()", async () => {
    const file = await html.renderPreview(htmlInput());
    expect(file.path).toBe("components/actions/Button/Button.preview.js");
    expect(file.mimeType).toBe("text/javascript");
    // Same `var GenieComponent = (() => { … })()` IIFE shape as React/Vue.
    expect(file.content).toContain(PREVIEW_GLOBAL_NAME);
    expect(file.content).toContain("(() =>");
    // Exposes the cross-framework `{ default, <Name> }` mount handle.
    expect(file.content).toContain("default: mount");
    expect(file.content).toContain('"Button": mount');
    // The component's own markup + inline style made it into the bundle.
    expect(file.content).toContain("btn");
    expect(file.content).toContain("color: rgb(10, 20, 30)");
  });

  it("renderPreview needs no bundler runtime (no esbuild/host-global, no require)", async () => {
    const file = await html.renderPreview(htmlInput());
    // Vanilla HTML has no framework runtime to resolve, so — unlike React/Vue —
    // the preview must not carry a host-global shim nor a throwing `require(...)`.
    expect(file.content).not.toContain("Dynamic require of");
    expect(file.content).not.toMatch(/[^_.\w]require\(/);
    expect(file.content).not.toContain("window.React");
    expect(file.content).not.toContain("window.Vue");
  });

  it("renderPreview is deterministic (byte-identical across runs)", async () => {
    const a = await html.renderPreview(htmlInput());
    const b = await html.renderPreview(htmlInput());
    expect(a.content).toBe(b.content);
  });

  it("renderPreview safely embeds source containing quotes / </script> sequences", async () => {
    // JSON-encoding the source (not string concatenation) keeps a literal
    // `</script>` or a quote from breaking the emitted JS.
    const file = await html.renderPreview(
      htmlInput({
        componentName: "Quirky",
        group: "misc",
        source: '<p title="a\'b">x</p><script>console.log("</script> not closed");</script>',
      }),
    );
    expect(file.path).toBe("components/misc/Quirky/Quirky.preview.js");
    // Round-trips: the embedded JSON string parses back to the exact source.
    const match = file.content.match(/var html = (".*?");\n {2}function mount/s);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toBe(
      '<p title="a\'b">x</p><script>console.log("</script> not closed");</script>',
    );
  });

  it("extractDts emits a valid empty-module <Name>.d.ts (HTML has no type surface)", async () => {
    const file = await html.extractDts(htmlInput());
    expect(file.path).toBe("components/actions/Button/Button.d.ts");
    // Always a valid `.d.ts` artefact, never an empty string.
    expect(file.content.length).toBeGreaterThan(0);
    expect(file.content).toContain("export {}");
    expect(file.mimeType).toBe("text/plain");
  });

  it("all HTML artefacts live under components/<group>/<Name>/", async () => {
    const src = html.renderSource(htmlInput());
    const prev = await html.renderPreview(htmlInput());
    const dts = await html.extractDts(htmlInput());
    for (const f of [src, prev, dts]) {
      expect(f.path.startsWith("components/actions/Button/")).toBe(true);
    }
  });
});

// ── AC3 — no framework remains stubbed; the error contract is retained ─────────

describe("AC3 — stub contract (retained for future frameworks)", () => {
  it("no shipped adapter is a stub — every framework's codegen is real", async () => {
    // Regression guard on the v2 graduation: none of the three adapters throws
    // NotYetImplementedError from a codegen method any more (React v1, Vue DRO-616,
    // HTML DRO-617). `STUB_FRAMEWORKS` is now empty; this asserts that stays true.
    expect(STUB_FRAMEWORKS).toHaveLength(0);
    for (const fw of FRAMEWORKS) {
      const adapter = await getAdapter(fw);
      expect(() => adapter.renderSource(input())).not.toThrow(NotYetImplementedError);
    }
  });

  it("NotYetImplementedError stays a well-formed, structured, linked error", () => {
    // The class is part of the FrameworkAdapter contract — kept for the next
    // framework that ships as a stub — so its shape is pinned even with no live
    // stub throwing it today.
    const err = new NotYetImplementedError("html", HTML_TRACKING_ISSUE);
    expect(err.code).toBe("ERR_FRAMEWORK_NOT_IMPLEMENTED");
    expect(err.framework).toBe("html");
    expect(err.trackingIssue).toBe(HTML_TRACKING_ISSUE);
    expect(err.message).toContain(HTML_TRACKING_ISSUE);
  });

  it("the tracking-issue links point at the genie repo (v2 milestone)", () => {
    // VUE_TRACKING_ISSUE / HTML_TRACKING_ISSUE are retained for provenance even
    // though both are now real adapters (DRO-616 / DRO-617); the links must stay
    // genie-repo URLs.
    for (const url of [VUE_TRACKING_ISSUE, HTML_TRACKING_ISSUE]) {
      expect(url).toMatch(/^https:\/\/github\.com\/roshangautam\/genie\/issues\/\d+$/);
    }
  });

  it("stubs still expose identity + viewport (selection never breaks for them)", async () => {
    // Vacuous while STUB_FRAMEWORKS is empty, but re-arms automatically for any
    // future stubbed framework so a new stub still proves it exposes metadata.
    for (const fw of STUB_FRAMEWORKS) {
      const adapter = await getAdapter(fw);
      expect(adapter.framework).toBe(fw);
      expect(adapter.defaultViewport.width).toBeGreaterThan(0);
      expect(adapter.promptDirective).toContain(`Target framework: ${fw}`);
    }
  });
});
