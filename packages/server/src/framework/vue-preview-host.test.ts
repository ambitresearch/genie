/**
 * Vue preview host-contract execution suite (DRO-616 · v2) — the Vue analogue of
 * `react-preview-host.test.ts`, closing the same "asserted on bytes, never ran"
 * gap for the Vue adapter that DRO-624 closed for React.
 *
 * `adapter-conformance.test.ts` asserts on the *text* of the Vue preview bundle
 * (that it contains `GenieComponent`, references `window.Vue`, carries the scoped
 * CSS). That text can look right while the bundle fails to mount — a wrong
 * host-global contract, a broken scope-id wiring, or a `require("vue")` that
 * throws the instant the IIFE evaluates. This suite **executes** the emitted
 * bundle inside a jsdom window with the host-provided Vue global (the vendored
 * `_vendor/vue.runtime.global.prod.js` the preview iframe supplies per PRD §6.6)
 * and asserts the component actually mounts, renders, applies scoped styles, and
 * reacts to state — the real preview-host contract.
 *
 * ── Environment ───────────────────────────────────────────────────────────────
 * The repo's default vitest environment is `node`; this file drives jsdom
 * *programmatically* (a fresh `JSDOM` per test with the vendored Vue global build
 * eval'd in) rather than switching the global test environment, so it mirrors the
 * real contract — a bare iframe window that only has what the host page injected —
 * and stays isolated from the rest of the node-env suite.
 *
 * ── Why the Vue 3 *runtime* global build ──────────────────────────────────────
 * The adapter compiles each SFC's template to a render function ahead of time, so
 * the preview never needs the in-browser template compiler — only the runtime.
 * The vendored `_vendor/vue.runtime.global.prod.js` (which self-assigns
 * `window.Vue`) is exactly that runtime, and this test pins the same build.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";

import { VueAdapter, VUE_HOST_GLOBAL } from "./vue.js";
import { PREVIEW_GLOBAL_NAME } from "./react.js";
import type { RenderInput } from "./interface.js";

const require = createRequire(import.meta.url);

// ── Vendored runtime (stands in for `_vendor/vue.runtime.global.prod.js`) ──────
//
// Resolve the global build off the package directory (`vue/package.json` → swap
// the basename), mirroring how react-preview-host.test.ts resolves the React UMD
// builds. This global bundle self-assigns `window.Vue` when eval'd — exactly what
// the preview iframe host does with the kit's vendored copy.
function vueGlobalRuntime(): string {
  const pkgJson = require.resolve("vue/package.json");
  return readFileSync(pkgJson.replace(/package\.json$/, "dist/vue.runtime.global.prod.js"), "utf8");
}
const VUE_GLOBAL = vueGlobalRuntime();

// ── Fixtures ──────────────────────────────────────────────────────────────────

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    componentName: "Button",
    group: "actions",
    source: [
      '<script setup lang="ts">',
      "export interface ButtonProps {",
      "  label: string;",
      "  variant?: 'primary' | 'ghost';",
      "}",
      "const props = withDefaults(defineProps<ButtonProps>(), { variant: 'primary' });",
      "</script>",
      "<template>",
      '  <button :class="props.variant">{{ props.label }}</button>',
      "</template>",
      "<style scoped>",
      "button { color: rgb(10, 20, 30); }",
      "</style>",
    ].join("\n"),
    ...overrides,
  };
}

/**
 * A component that exercises reactivity + list rendering: a `ref` counter derived
 * from a prop, a `v-for` with `:key`, and an interpolation — so the bundle and
 * host must share one Vue runtime for the component to render at all.
 */
const PANEL_SOURCE = [
  '<script setup lang="ts">',
  "import { ref } from 'vue';",
  "const props = defineProps<{ items: string[] }>();",
  "const count = ref(props.items.length);",
  "</script>",
  "<template>",
  "  <div>",
  "    <h2>{{ count }} items</h2>",
  '    <ul><li v-for="it in props.items" :key="it">{{ it }}</li></ul>',
  "  </div>",
  "</template>",
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
 * vendored Vue global, then evaluates the adapter's emitted bundle. `loadVue` can
 * be false to prove the bundle *needs* the host global (it must throw the contract
 * error rather than silently misbehave).
 */
function makeHost(bundle: string, loadVue = true): PreviewHost {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`,
    {
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  if (loadVue) {
    window.eval(VUE_GLOBAL);
  }
  window.eval(bundle);
  const container = window.document.getElementById("root");
  if (!container) throw new Error("test harness: #root missing");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exported = (window as any)[PREVIEW_GLOBAL_NAME];
  return { window, container: container as unknown as HTMLElement, exported };
}

/** Mount an exported component into the host's #root using the host's Vue runtime. */
function mount(host: PreviewHost, props: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = host.window as any;
  const Vue = w[VUE_HOST_GLOBAL];
  Vue.createApp(host.exported.default, props).mount(host.container);
}

// ── the emitted bundle executes against the host Vue global ────────────────────

describe("Vue preview bundle executes in a host with the vendored Vue global", () => {
  const vue = new VueAdapter();

  it("the vendored global build self-assigns window.Vue (v3)", () => {
    // Guards the harness itself: if this global doesn't appear, every downstream
    // 'renders' assertion would be meaningless.
    const host = makeHost("/* no bundle side effects */ var GenieComponent = {};");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = host.window as any;
    expect(typeof w[VUE_HOST_GLOBAL]).toBe("object");
    expect(String(w[VUE_HOST_GLOBAL].version)).toMatch(/^3\./);
    expect(typeof w[VUE_HOST_GLOBAL].createApp).toBe("function");
  });

  it("emits a bundle with no throwing dynamic `require` and referencing the host global", async () => {
    const file = await vue.renderPreview(input());
    // The DRO-624 regression guard, applied to Vue: no esbuild
    // `Dynamic require of "vue"` shim, no bare `require("vue")`.
    expect(file.content).not.toContain("Dynamic require of");
    expect(file.content).not.toMatch(/[^_.\w]require\("vue/);
    // …and it resolves Vue from the host global instead.
    expect(file.content).toContain(`window.${VUE_HOST_GLOBAL}`);
  });

  it("mounts the component and renders its DOM with props applied", async () => {
    const file = await vue.renderPreview(input());
    const host = makeHost(file.content);

    // The bundle exposed the component on the preview global.
    expect(host.exported).toBeTruthy();
    expect(host.exported.default).toBeTruthy();

    mount(host, { label: "Click me", variant: "ghost" });

    const button = host.container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Click me");
    // withDefaults + the bound :class produced the variant class.
    expect(button?.classList.contains("ghost")).toBe(true);
  });

  it("injects the scoped <style> and scopes the element with a data-v attribute", async () => {
    const file = await vue.renderPreview(input());
    const host = makeHost(file.content);
    mount(host, { label: "Styled", variant: "primary" });

    const button = host.container.querySelector("button");
    // The scope attribute the compiler assigned is present on the element…
    const scopeAttr = [...(button?.attributes ?? [])]
      .map((a) => a.name)
      .find((n) => n.startsWith("data-v-"));
    expect(scopeAttr).toBeTruthy();
    // …and the matching scoped CSS was injected into a <style> in the host head.
    const style = host.window.document.querySelector("style");
    expect(style?.textContent).toContain("color: rgb(10, 20, 30)");
    expect(style?.textContent).toContain(scopeAttr as string);
  });

  it("shares one Vue runtime with the host: reactivity + keyed v-for render", async () => {
    const file = await vue.renderPreview(
      input({ componentName: "Panel", group: "surfaces", source: PANEL_SOURCE }),
    );
    const host = makeHost(file.content);
    mount(host, { items: ["a", "b", "c"] });

    // ref(props.items.length) resolved to 3 → bundle & host share one Vue.
    expect(host.container.querySelector("h2")?.textContent).toBe("3 items");
    // v-for + :key produced three <li>.
    expect(host.container.querySelectorAll("li")).toHaveLength(3);
    expect(host.container.querySelector("ul")?.textContent).toBe("abc");
  });

  it("renders an options-API SFC (plain <script>, template compiled separately)", async () => {
    // Regression guard: `compileScript({ inlineTemplate: true })` silently drops
    // the render function for an options-API `<script>` (it only inlines for
    // `<script setup>`), yielding a component that mounts to nothing. The adapter
    // compiles the template separately, so this must actually render.
    const file = await vue.renderPreview(
      input({
        componentName: "Label",
        group: "display",
        source: [
          '<script lang="ts">',
          "import { defineComponent } from 'vue';",
          "export default defineComponent({ props: { text: { type: String, required: true } } });",
          "</script>",
          '<template><strong class="lbl">{{ text }}</strong></template>',
        ].join("\n"),
      }),
    );
    const host = makeHost(file.content);
    mount(host, { text: "Options" });
    expect(host.container.querySelector(".lbl")?.textContent).toBe("Options");
  });

  it("renders a template-only SFC (no <script> block)", async () => {
    const file = await vue.renderPreview(
      input({
        componentName: "Badge",
        group: "display",
        source: '<template><span class="badge">Static</span></template>',
      }),
    );
    const host = makeHost(file.content);
    mount(host, {});
    expect(host.container.querySelector(".badge")?.textContent).toBe("Static");
  });

  it("throws the preview-host-contract error when the host global is absent", async () => {
    const file = await vue.renderPreview(input());
    // Evaluating the bundle in a window WITHOUT the vendored Vue must fail loudly
    // with the adapter's contract message — not silently mis-mount.
    expect(() => makeHost(file.content, /* loadVue */ false)).toThrow(
      /preview host contract violated: window\.Vue is not defined/,
    );
  });
});
