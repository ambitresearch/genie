/**
 * `VueAdapter` (M2-08 stub → **v2 · DRO-616**) — the Vue 3 framework adapter.
 *
 * Lowers a neutral {@link RenderInput} (the component's `.vue` **single-file
 * component** source) into the three Vue target artefacts, mirroring
 * {@link ReactAdapter} method-for-method so `conjure` treats every framework the
 * same:
 *   - {@link VueAdapter.renderSource}  → `<Name>.vue` (the canonical SFC source)
 *   - {@link VueAdapter.renderPreview} → `<Name>.preview.js` — an **esbuild IIFE
 *     bundle** exposing the compiled component on `globalThis.GenieComponent` for
 *     the M4 iframe grid to mount with `Vue.createApp(GenieComponent.default)`
 *   - {@link VueAdapter.extractDts}    → `<Name>.d.ts` — the component's exported
 *     prop/emit types, extracted with **ts-morph** (declaration-only in-memory emit)
 *
 * ── Import-time safety ────────────────────────────────────────────────────────
 * `@vue/compiler-sfc`, `esbuild` and `ts-morph` are heavy transitive graphs.
 * None is imported at this module's top level — each is reached through a lazy
 * `await import(...)` *inside* the one method that needs it. So the registry
 * (`interface.ts#getAdapter`) can resolve a `VueAdapter` — and `conjure` can read
 * its `promptDirective` / `defaultViewport` on the generation hot path — without
 * ever pulling the SFC compiler, the bundler, or the TS compiler, which only load
 * when a preview / `.d.ts` is actually produced. The only compile-time references
 * at module scope are `import type`s (erased under `verbatimModuleSyntax`), which
 * emit no runtime `require(...)` and do not defeat the lazy-load.
 *
 * ── Preview host contract (parity with DRO-624's React contract) ──────────────
 * The `<Name>.preview.js` bundle does **not** carry its own copy of Vue, nor does
 * it `require("vue")`. Vue's SFC compiler lowers a `<script setup>` / template
 * into a module that imports its runtime helpers (`defineComponent`, `openBlock`,
 * `createElementBlock`, `toDisplayString`, …) from the bare specifier `"vue"`.
 * {@link hostVueGlobalPlugin} rewrites that specifier at bundle time to read a
 * **host-provided browser global** the preview iframe must define *before* the
 * bundle's `<script>` runs:
 *
 *   - `window.{@link VUE_HOST_GLOBAL}` → the Vue 3 runtime (`window.Vue`)
 *
 * exactly as the React adapter rewrites `react` → `window.React`. Per the on-disk
 * layout (PRD §6.6) the kit vendors the runtime under `_vendor/` (the Vue 3
 * *global* build — `vue.runtime.global.prod.js` — which self-assigns
 * `window.Vue`), and the iframe host page `<script>`-includes it ahead of the
 * component bundle. Marking `vue` esbuild-`external` under `format:"iife"` would
 * lower the import to a throwing `require("vue")` (the same failure mode DRO-624
 * fixed for React), so the plugin is the mechanism, not `external`.
 *
 * NOTE — **Vue 3 global build**: the contract depends on a runtime that ships a
 * build defining a `window.Vue` global carrying the full runtime helper surface.
 * The vendored `_vendor/vue.runtime.global.prod.js` must be a Vue 3 global build
 * (the adapter's execution test pins the same major).
 */
import { createHash } from "node:crypto";

import type { Plugin } from "esbuild";

import {
  componentPath,
  type AdapterFile,
  type FrameworkAdapter,
  type Framework,
  type RenderInput,
  type Viewport,
} from "./interface.js";
// The M4 grid's preview-global name is a cross-framework contract; import the
// single source of truth from the React adapter rather than redeclaring it, so
// Vue and React cards are mounted through the identical `window.GenieComponent`
// handle. (react.js has no heavy top-level imports — only `import type` — so
// this stays cheap and does not pull esbuild/ts-morph.)
import { PREVIEW_GLOBAL_NAME } from "./react.js";

/**
 * v2 tracking issue this adapter was implemented under (kept exported for
 * provenance and referenced by the conformance suite). Retained now that Vue is
 * no longer a stub so historical links and the AC3 URL-shape assertion still
 * resolve.
 */
export const VUE_TRACKING_ISSUE = "https://github.com/roshangautam/genie/issues/129";

/**
 * The host-provided browser global the preview IIFE resolves Vue from. The M4
 * preview iframe must load the vendored Vue 3 global build (which self-assigns
 * `window.Vue`) before the component bundle — see the *Preview host contract*
 * above. Kept here so the adapter is the single source of truth for the contract.
 */
export const VUE_HOST_GLOBAL = "Vue";

/**
 * esbuild namespace the virtual `vue` shim module lives in (kept off the real
 * filesystem so nothing resolves to an on-disk `node_modules/vue`).
 */
const HOST_NAMESPACE = "genie-vue-host-global";

/** A clear, actionable error when the iframe forgot to load the vendored global. */
function hostMissingMessage(): string {
  return (
    `genie preview host contract violated: window.${VUE_HOST_GLOBAL} is not defined. ` +
    `The preview iframe must load the vendored _vendor/vue.runtime.global.prod.js ` +
    `(Vue 3 global build) before the component bundle — see the preview host contract in vue.ts.`
  );
}

/** CJS body for the virtual `vue` module that re-exports the host global. */
function hostGlobalModule(): string {
  return [
    `if (!window.${VUE_HOST_GLOBAL}) throw new Error(${JSON.stringify(hostMissingMessage())});`,
    `module.exports = window.${VUE_HOST_GLOBAL};`,
  ].join("\n");
}

/**
 * esbuild plugin implementing the {@link VUE_HOST_GLOBAL} contract (parity with
 * React's `hostReactGlobalsPlugin`). It intercepts the bare `vue` specifier every
 * compiled SFC imports its runtime helpers from and resolves it to an in-memory
 * virtual module that reads `window.Vue` — so the emitted IIFE contains **no**
 * `require("vue")` and instead references the host global.
 *
 * Vue's compiled output only ever imports from the bare `"vue"` entry (unlike
 * React's automatic-JSX runtime, which also pulls `react/jsx-runtime`), so a
 * single specifier rewrite is sufficient.
 */
export function hostVueGlobalPlugin(): Plugin {
  return {
    name: "genie-vue-host-global",
    setup(build) {
      build.onResolve({ filter: /^vue$/ }, () => ({ path: "vue", namespace: HOST_NAMESPACE }));
      build.onLoad({ filter: /.*/, namespace: HOST_NAMESPACE }, () => ({
        contents: hostGlobalModule(),
        loader: "js",
      }));
    },
  };
}

/**
 * A deterministic 8-hex scope id derived from the component identity + source, so
 * a given SFC always compiles to the same `data-v-…` attribute (stable preview
 * bytes across runs — no `Date.now()`/random). Vue's SFC compiler uses this id to
 * scope both the template's root attribute and the `<style scoped>` selectors.
 */
function scopeHash(input: RenderInput): string {
  return createHash("sha256")
    .update(`${input.componentName} ${input.source}`)
    .digest("hex")
    .slice(0, 8);
}

/**
 * A guarded, idempotent runtime `<style>` injector snippet. `<style scoped>` CSS
 * is intrinsic to an SFC, so the preview must carry it; the snippet appends one
 * `<style>` element (keyed by `styleKey` so re-evaluating the bundle never
 * duplicates it) and is a no-op outside a DOM (SSR / static analysis).
 */
function styleInjectorSnippet(css: string, styleKey: string): string {
  const elementId = `genie-style-${styleKey}`;
  return [
    `(function () {`,
    `  if (typeof document === "undefined") return;`,
    `  if (document.getElementById(${JSON.stringify(elementId)})) return;`,
    `  var __genieStyle = document.createElement("style");`,
    `  __genieStyle.id = ${JSON.stringify(elementId)};`,
    `  __genieStyle.textContent = ${JSON.stringify(css)};`,
    `  document.head.appendChild(__genieStyle);`,
    `})();`,
  ].join("\n");
}

export class VueAdapter implements FrameworkAdapter {
  readonly framework: Framework = "vue";

  /**
   * A comfortable default card for a Vue component when the caller has no better
   * viewport. Matches the React adapter (and the RFC's default preview grid cell,
   * §7.5) so a framework switch never resizes a card by default.
   */
  readonly defaultViewport: Viewport = { width: 400, height: 300 };

  /**
   * The framework directive `conjure` injects into the generation prompt (AC4):
   * name the target framework and the Vue SFC shape the model should emit. Asking
   * for an **exported** props interface makes {@link extractDts} productive (it
   * emits the SFC script block's exported declarations), mirroring the React
   * adapter's "exported interface" guidance.
   */
  readonly promptDirective: string = [
    "Target framework: vue",
    'Emit an idiomatic Vue 3 Single File Component (.vue) using <script setup lang="ts">. ' +
      "Type props by passing an exported interface to defineProps (e.g. " +
      "`defineProps<ButtonProps>()`) so the component's prop types are recoverable, and " +
      "declare events with defineEmits.",
  ].join("\n");

  /**
   * The canonical source file: `<Name>.vue`, carrying the model-authored SFC
   * verbatim. `text/x-vue` matches the MIME the kit-file classifier already maps
   * `.vue` to (`store/kit-files.ts`), so an adapter-emitted source and a
   * store-read source report the same type.
   */
  renderSource(input: RenderInput): AdapterFile {
    return {
      path: componentPath(input, `${input.componentName}.vue`),
      content: input.source,
      mimeType: "text/x-vue",
    };
  }

  /**
   * Bundle the SFC to a browser-ready **IIFE** exposing the compiled component on
   * `globalThis.${PREVIEW_GLOBAL_NAME}` (`{ default, <Name> }`). The pipeline
   * mirrors what `@vitejs/plugin-vue` does — compile the script and the template
   * as *separate* modules and stitch them — so it renders every SFC shape
   * (`<script setup>`, options-API `<script>`, and template-only) identically:
   *
   *   1. `@vue/compiler-sfc#parse` → SFC descriptor.
   *   2. `compileScript({ inlineTemplate: false })` lowers `<script setup>` (or a
   *      plain options-API `<script>`) to the component object, exposing its
   *      `bindings` so the template can bind setup state correctly. `inlineTemplate`
   *      is deliberately **off**: it only bakes the template into `<script setup>`
   *      output — for an options-API `<script>` it silently drops the render
   *      function, leaving a component that mounts to nothing.
   *   3. `compileTemplate` compiles `<template>` to a standalone `render`, fed the
   *      script's `bindings` (so `<script setup>` refs resolve) and the scope id,
   *      then assigned onto the component. A template-only SFC starts from an empty
   *      component object; a script-only SFC skips this step.
   *   4. `<style scoped>` blocks are compiled with the matching scope id and
   *      inlined as a guarded runtime `<style>` injection so the preview is a
   *      single self-contained script (the interface returns one file).
   *   5. esbuild bundles it to an IIFE, rewriting `"vue"` → `window.Vue` via
   *      {@link hostVueGlobalPlugin} — no `require("vue")` at runtime.
   *
   * The SFC compiler, esbuild and ts-morph are all imported lazily so resolving a
   * `VueAdapter` never pulls them until a preview is actually built.
   */
  async renderPreview(input: RenderInput): Promise<AdapterFile> {
    const { parse, compileScript, compileStyle, compileTemplate } =
      await import("@vue/compiler-sfc");
    const esbuild = (await import("esbuild")).default;

    const filename = `${input.componentName}.vue`;
    const { descriptor, errors } = parse(input.source, { filename });
    if (errors.length > 0) {
      throw new Error(
        `Vue SFC parse failed for ${filename}: ${errors.map((e) => String(e)).join("; ")}`,
      );
    }
    if (!descriptor.scriptSetup && !descriptor.script && !descriptor.template) {
      throw new Error(
        `Vue SFC ${filename} has neither a <script> nor a <template> block to render.`,
      );
    }

    const id = scopeHash(input);
    const scopeId = `data-v-${id}`;
    const hasScoped = descriptor.styles.some((s) => s.scoped);
    // The identifier the compiled component is bound to before we re-export it —
    // renaming `export default` (via `genDefaultAs`) lets us attach `render` /
    // `__scopeId` and re-export under both `default` and the component name.
    const COMPONENT_BINDING = "__genie_component__";

    // ── 2. script (setup or options API) → component object + binding metadata ─
    const moduleParts: string[] = [];
    // `BindingMetadata | undefined` — passed to compileTemplate so a `<script
    // setup>` binding referenced in the template resolves to the right access.
    let bindings: ReturnType<typeof compileScript>["bindings"] | undefined;
    if (descriptor.scriptSetup || descriptor.script) {
      const script = compileScript(descriptor, {
        id,
        inlineTemplate: false,
        genDefaultAs: COMPONENT_BINDING,
      });
      bindings = script.bindings;
      moduleParts.push(script.content);
    } else {
      // Template-only SFC: start from a bare component object the render attaches to.
      moduleParts.push(`const ${COMPONENT_BINDING} = {};`);
    }

    // ── 3. template → standalone render, assigned onto the component ───────────
    if (descriptor.template) {
      const template = compileTemplate({
        source: descriptor.template.content,
        filename,
        id,
        scoped: hasScoped,
        compilerOptions: {
          bindingMetadata: bindings,
          ...(hasScoped ? { scopeId } : {}),
        },
      });
      if (template.errors.length > 0) {
        throw new Error(
          `Vue template compile failed for ${filename}: ` +
            template.errors.map((e) => String(e)).join("; "),
        );
      }
      // compileTemplate emits `export function render(...)`; drop the `export` so
      // it is a local we can assign onto the component binding.
      moduleParts.push(template.code.replace(/\bexport function render/, "function render"));
      moduleParts.push(`${COMPONENT_BINDING}.render = render;`);
    }

    // ── 4. styles (scoped + plain), compiled and concatenated ─────────────────
    let css = "";
    for (const style of descriptor.styles) {
      const compiled = compileStyle({
        source: style.content,
        filename,
        id: scopeId,
        scoped: style.scoped,
      });
      if (compiled.errors.length > 0) {
        throw new Error(
          `Vue style compile failed for ${filename}: ` +
            compiled.errors.map((e) => String(e)).join("; "),
        );
      }
      css += `${compiled.code}\n`;
    }

    // ── assemble the esbuild entry ────────────────────────────────────────────
    const entry = [
      ...moduleParts,
      hasScoped ? `${COMPONENT_BINDING}.__scopeId = ${JSON.stringify(scopeId)};` : "",
      css.trim() ? styleInjectorSnippet(css, id) : "",
      `export default ${COMPONENT_BINDING};`,
      `export const ${input.componentName} = ${COMPONENT_BINDING};`,
    ]
      .filter(Boolean)
      .join("\n");

    // ── 5. bundle to a host-global IIFE ───────────────────────────────────────
    const result = await esbuild.build({
      stdin: {
        contents: entry,
        loader: "ts",
        sourcefile: `${input.componentName}.vue.ts`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      globalName: PREVIEW_GLOBAL_NAME,
      platform: "browser",
      // `vue` is rewritten to the preview host's browser global (window.Vue)
      // rather than inlined or left as a throwing `require("vue")` — see the
      // Preview host contract.
      plugins: [hostVueGlobalPlugin()],
      logLevel: "silent",
    });
    const output = result.outputFiles[0];
    if (!output) {
      // esbuild returns at least one output file on success; this guards the
      // types, it is not an expected runtime branch.
      throw new Error("esbuild produced no preview output for the Vue component.");
    }
    return {
      path: componentPath(input, `${input.componentName}.preview.js`),
      content: output.text,
      mimeType: "text/javascript",
    };
  }

  /**
   * Extract the component's `.d.ts` typings with ts-morph (parity with React), via
   * an in-memory declaration-only emit so nothing touches disk. Vue's props/emits
   * live in the SFC's `<script setup>` (and/or `<script>`) block; this feeds those
   * blocks' TypeScript to ts-morph and emits the **exported** declarations — so a
   * component that exports its props interface (as the `promptDirective` asks)
   * yields that interface in its `.d.ts`.
   *
   * The `defineProps` / `defineEmits` / `withDefaults` compiler macros are left as
   * unresolved identifiers, but we never type-check — only emit declarations
   * (`skipLibCheck` + `emitDeclarationOnly`) — so their presence never blocks the
   * exported types from surfacing. A source with no exported declarations (inline
   * prop types, or a template-only SFC) falls back to a valid empty module.
   *
   * ts-morph and the SFC parser are imported lazily for the same reason as
   * {@link renderPreview}: keep resolving the adapter cheap.
   */
  async extractDts(input: RenderInput): Promise<AdapterFile> {
    const { parse } = await import("@vue/compiler-sfc");
    const { Project, ts } = await import("ts-morph");

    const filename = `${input.componentName}.vue`;
    const { descriptor } = parse(input.source, { filename });
    const scriptContent = [descriptor.script?.content, descriptor.scriptSetup?.content]
      .filter((c): c is string => Boolean(c && c.trim()))
      .join("\n");

    const project = new Project({
      useInMemoryFileSystem: true,
      // `skipLibCheck` + declaration-only emit means the unresolved compiler
      // macros / missing libs never block emission; we want the *shape*, not a
      // clean type-check.
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    });
    // `.ts` (not `.vue`): we hand ts-morph the extracted script block, which is
    // plain TypeScript once the SFC wrapper is stripped.
    project.createSourceFile(`${input.componentName}.ts`, scriptContent, { overwrite: true });
    const emitted = project.emitToMemory({ emitOnlyDtsFiles: true });
    const dtsText = emitted.getFiles().find((f) => f.filePath.endsWith(".d.ts"))?.text;
    // Fallback: a source with no exported declarations — inline prop types
    // (`defineProps<{…}>()`) or a template-only SFC with no script block — yields
    // an empty or absent `.d.ts`. Emit a minimal module marker rather than an
    // empty file so the artefact is always a valid `.d.ts`.
    const content = dtsText && dtsText.trim().length > 0 ? dtsText : `export {};\n`;
    return {
      path: componentPath(input, `${input.componentName}.d.ts`),
      content,
      mimeType: "text/plain",
    };
  }
}
