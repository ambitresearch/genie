/**
 * `HtmlAdapter` (M2-08 stub → **v2 · DRO-617**) — the vanilla-HTML framework adapter.
 *
 * Lowers a neutral {@link RenderInput} (a self-contained `.html` document /
 * template) into the three target artefacts, mirroring {@link ReactAdapter} /
 * {@link VueAdapter} method-for-method so `conjure` treats every framework the
 * same:
 *   - {@link HtmlAdapter.renderSource}  → `<Name>.html` (the canonical source)
 *   - {@link HtmlAdapter.renderPreview} → `<Name>.preview.js` — a browser-ready
 *     **IIFE** exposing the component on `globalThis.GenieComponent` for the M4
 *     iframe grid to mount, exactly like the React/Vue previews
 *   - {@link HtmlAdapter.extractDts}    → `<Name>.d.ts` — a minimal custom-element
 *     typing surface (an `HTMLElementTagNameMap` augmentation for any
 *     `customElements.define(...)` the source registers), or a valid empty module
 *
 * ── Why vanilla HTML still emits a `.preview.js` IIFE ─────────────────────────
 * The HTML *is* already browser-ready — but the M4-03 iframe grid mounts **every**
 * framework through the identical `window.{@link PREVIEW_GLOBAL_NAME}` handle
 * (`{ default, <Name> }`), so React and Vue cards mount the same way (react.ts /
 * vue.ts). Emitting an HTML card as a raw document instead would fork the grid's
 * mount path per framework. Instead this adapter wraps the markup in the same
 * preview-global contract: the IIFE exposes a descriptor whose `mount(container)`
 * writes the component's markup into the card and *re-executes* any inline
 * `<script>` (browsers do not run scripts inserted via `innerHTML`), so an
 * interactive vanilla-HTML component behaves the same mounted as it would opened
 * directly. This is the issue's "mostly a pass-through + optional JS/CSS inlining":
 * no bundler, no compile — the markup flows through verbatim, only *wrapped* for a
 * uniform mount.
 *
 * ── No preview host globals ───────────────────────────────────────────────────
 * Unlike React (`window.React`) and Vue (`window.Vue`), a vanilla-HTML preview has
 * **no** framework runtime to resolve from a host global — the browser is the
 * runtime. So there is no host-global contract and no esbuild rewrite plugin here;
 * the preview is fully self-contained and evaluates in any window.
 *
 * ── Import-time safety ────────────────────────────────────────────────────────
 * Nothing heavy is imported here at all — the preview is assembled from plain
 * string templating and `extractDts` scans the source with a regex — so resolving
 * an `HtmlAdapter` (which the registry does on first `getAdapter("html")`) is
 * free, and `conjure` can read its `promptDirective` / `defaultViewport` on the
 * generation hot path with zero cost. The React/Vue adapters lazy-`import` esbuild
 * / ts-morph / the SFC compiler for the same "keep resolving cheap" reason; the
 * HTML adapter simply needs none of them.
 */
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
// HTML, Vue and React cards are all mounted through the identical
// `window.GenieComponent` handle. (react.js has no heavy top-level imports —
// only `import type` — so this stays free and pulls no esbuild/ts-morph.)
import { PREVIEW_GLOBAL_NAME } from "./react.js";

/**
 * v2 tracking issue this adapter was implemented under (kept exported for
 * provenance and referenced by the conformance suite's URL-shape assertion).
 * Retained now that HTML is no longer a stub so historical links still resolve.
 */
export const HTML_TRACKING_ISSUE = "https://github.com/roshangautam/genie/issues/130";

/**
 * Matches a `customElements.define("tag-name", …)` registration in the source,
 * capturing the custom-element tag (which must contain a hyphen per the HTML
 * spec). Used by {@link HtmlAdapter.extractDts} to surface a typed element map.
 * Tolerant of single/double/back quotes and arbitrary whitespace around `(`.
 *
 * **Case-sensitive by design** (only the `g` flag — no `i`): `customElements.define`
 * is a case-sensitive JS API, so a mixed-case token like `CustomElements.Define` is
 * not a real registration and must not match. More importantly, a valid custom-element
 * name is lowercase per the HTML spec — `define("X-Counter", …)` throws `SyntaxError`
 * at runtime — so an `i` flag would let the tag group accept uppercase names and type
 * an element in `HTMLElementTagNameMap` that can never actually be registered. The
 * literal `customElements`/`define` and every valid tag name are already lowercase,
 * so dropping `i` costs nothing and rejects exactly the tags that can never exist.
 */
const CUSTOM_ELEMENT_DEFINE =
  /customElements\s*\.\s*define\s*\(\s*["'`]([a-z][a-z0-9]*-[a-z0-9-]*)["'`]/g;

/**
 * The property name the preview descriptor carries the component's raw markup
 * under. Exported so a test (or the M4 grid) can read the pass-through markup off
 * `window.GenieComponent.default.html` without re-deriving the key.
 */
export const PREVIEW_HTML_KEY = "html";

/**
 * Serialize a string into a JS string literal that is also safe to embed inside
 * an HTML `<script>` block. `JSON.stringify` handles quotes/newlines/control
 * chars, and replacing every `<` with the `<` escape means the literal can
 * never contain a `</script>` (or `<script>`, or `<!--`) token an HTML parser
 * would act on. `"<"` evaluates back to `"<"` at JS runtime, so the value
 * the descriptor carries is byte-identical to the source markup.
 */
function jsStringForHtmlEmbedding(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Build the browser-ready preview IIFE body for a vanilla-HTML component. The
 * emitted script assigns `window.GenieComponent = { default: descriptor, <Name>:
 * descriptor }` (the same `{ default, <Name> }` shape React/Vue expose), where the
 * descriptor is:
 *
 *   {
 *     framework: "html",
 *     html: "<the component markup, verbatim>",
 *     mount: function (container) { … }
 *   }
 *
 * `mount` writes the markup into the target element and then re-executes any
 * inline `<script>` the markup carried — because setting `innerHTML` produces
 * inert `<script>` nodes the browser will not run. Re-creating each `<script>`
 * (copying its attributes + text) makes an interactive vanilla-HTML component work
 * mounted exactly as it would opened directly (the "optional JS … inlining" the
 * issue calls for). It is defensive about a missing DOM (returns without throwing)
 * so evaluating the bundle for static analysis never crashes.
 *
 * The markup is embedded via `JSON.stringify` so any quotes / newlines in the
 * source are safely escaped into a single JS string literal. `JSON.stringify`
 * does **not** escape `<` (or `/`), so a literal `</script>` in the markup would
 * survive verbatim — harmless in a standalone `.js` file, but a script-breakout
 * hazard the instant this preview is inlined into an HTML `<script>` block (which
 * an iframe host page may do). Escaping every `<` to its `<` unicode form
 * closes that hole: `"<"` evaluates back to `<` at runtime (so the mounted
 * markup is byte-identical to the source), yet no HTML parser ever sees a
 * `<script` / `</script` token in the emitted preview. The standard safe-embed
 * technique used by JSON-in-HTML serializers.
 */
function previewIife(input: RenderInput): string {
  const markup = jsStringForHtmlEmbedding(input.source);
  const componentExport = JSON.stringify(input.componentName);
  return [
    `(function () {`,
    `  "use strict";`,
    `  var descriptor = {`,
    `    framework: "html",`,
    `    ${PREVIEW_HTML_KEY}: ${markup},`,
    `    mount: function (container) {`,
    `      if (!container || typeof document === "undefined") return;`,
    `      container.innerHTML = descriptor.${PREVIEW_HTML_KEY};`,
    `      // Scripts inserted via innerHTML are inert; re-create each so the`,
    `      // browser executes it — this is what makes interactivity work mounted.`,
    `      var inert = container.querySelectorAll("script");`,
    `      for (var i = 0; i < inert.length; i++) {`,
    `        var old = inert[i];`,
    `        var next = document.createElement("script");`,
    `        for (var a = 0; a < old.attributes.length; a++) {`,
    `          var attr = old.attributes[a];`,
    `          next.setAttribute(attr.name, attr.value);`,
    `        }`,
    `        next.textContent = old.textContent;`,
    `        old.parentNode.replaceChild(next, old);`,
    `      }`,
    `      return container;`,
    `    },`,
    `  };`,
    `  var GC = { default: descriptor };`,
    `  GC[${componentExport}] = descriptor;`,
    `  if (typeof window !== "undefined") {`,
    `    window.${PREVIEW_GLOBAL_NAME} = GC;`,
    `  } else if (typeof globalThis !== "undefined") {`,
    `    globalThis.${PREVIEW_GLOBAL_NAME} = GC;`,
    `  }`,
    `})();`,
  ].join("\n");
}

/**
 * Collect the distinct custom-element tag names the source registers via
 * `customElements.define("x-y", …)`, in first-seen order. Empty when the markup
 * defines no custom elements (the common case for a plain HTML component).
 */
function customElementTags(source: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  // `matchAll` needs the /g flag (present on CUSTOM_ELEMENT_DEFINE); re-run from a
  // fresh matcher each call so the shared regex's lastIndex never leaks state.
  for (const match of source.matchAll(CUSTOM_ELEMENT_DEFINE)) {
    const tag = match[1];
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * Build the `.d.ts` typing surface for an HTML component. Vanilla HTML has no
 * exported component type the way a `.tsx`/`.vue` source does, so the only stable
 * typing worth surfacing is the **custom elements** the markup registers: each
 * `customElements.define("x-y", …)` is declared as an `HTMLElement` and mapped in
 * `HTMLElementTagNameMap`, so a consuming TypeScript project's
 * `document.createElement("x-y")` / `querySelector("x-y")` are typed. When the
 * source registers none, fall back to a valid empty module (never an empty file),
 * mirroring the React/Vue `export {};` fallback.
 */
function dtsForCustomElements(tags: string[]): string {
  if (tags.length === 0) return `export {};\n`;
  const lines: string[] = [
    "// Custom elements this HTML component registers via customElements.define().",
    "declare global {",
    "  interface HTMLElementTagNameMap {",
  ];
  for (const tag of tags) {
    lines.push(`    ${JSON.stringify(tag)}: HTMLElement;`);
  }
  lines.push("  }", "}", "export {};", "");
  return lines.join("\n");
}

export class HtmlAdapter implements FrameworkAdapter {
  readonly framework: Framework = "html";

  /**
   * A comfortable default card for a vanilla-HTML component when the caller has no
   * better viewport. Matches the React/Vue adapters (and the RFC's default preview
   * grid cell, §7.5) so a framework switch never resizes a card by default.
   */
  readonly defaultViewport: Viewport = { width: 400, height: 300 };

  /**
   * The framework directive `conjure` injects into the generation prompt (AC4):
   * name the target framework and the self-contained vanilla-HTML shape the model
   * should emit. Kept aligned with the original stub's directive so a prompt built
   * before this adapter graduated still reads identically.
   */
  readonly promptDirective: string = [
    "Target framework: html",
    "Emit a self-contained vanilla HTML component: semantic markup with inline " +
      "<style>, and vanilla JS in a <script> only if interactivity is required.",
  ].join("\n");

  /**
   * The canonical source file: `<Name>.html`, carrying the model-authored markup
   * verbatim. `text/html` matches the MIME the kit-file classifier maps `.html` to
   * (`mime-types` resolves `.html` → `text/html`), so an adapter-emitted source and
   * a store-read source report the same type.
   */
  renderSource(input: RenderInput): AdapterFile {
    return {
      path: componentPath(input, `${input.componentName}.html`),
      content: input.source,
      mimeType: "text/html",
    };
  }

  /**
   * Wrap the component markup in the browser-ready **IIFE** exposing it on
   * `globalThis.${PREVIEW_GLOBAL_NAME}` (`{ default, <Name> }`), so the M4 grid
   * mounts an HTML card through the identical `window.GenieComponent` handle it
   * uses for React/Vue — see {@link previewIife} for the descriptor + `mount`
   * contract. The markup passes through verbatim (no bundler, no compile); this is
   * `async` only to satisfy the {@link FrameworkAdapter} contract (React/Vue are
   * async because they lazy-load esbuild) — HTML needs no async work, so it
   * resolves immediately.
   */
  renderPreview(input: RenderInput): Promise<AdapterFile> {
    return Promise.resolve({
      path: componentPath(input, `${input.componentName}.preview.js`),
      content: previewIife(input),
      mimeType: "text/javascript",
    });
  }

  /**
   * Emit a `.d.ts` typing surface (parity with React/Vue). A vanilla-HTML
   * component exports no component type, so the useful typing is the **custom
   * elements** it registers: {@link customElementTags} scans the source for
   * `customElements.define("x-y", …)` and {@link dtsForCustomElements} augments
   * `HTMLElementTagNameMap` for each. A component that registers none falls back to
   * a valid empty module (`export {};`) — never an empty file — exactly as the
   * React/Vue adapters do for a source with no exported declarations. `async` only
   * to match the contract; the work is synchronous.
   */
  extractDts(input: RenderInput): Promise<AdapterFile> {
    const tags = customElementTags(input.source);
    return Promise.resolve({
      path: componentPath(input, `${input.componentName}.d.ts`),
      content: dtsForCustomElements(tags),
      mimeType: "text/plain",
    });
  }
}
