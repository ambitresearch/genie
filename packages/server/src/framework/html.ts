/**
 * `HtmlAdapter` (M2-08 stub → **v2 · DRO-617**) — the vanilla-HTML framework adapter.
 *
 * Lowers a neutral {@link RenderInput} (the component's self-contained `.html`
 * source) into the three target artefacts, mirroring {@link ReactAdapter} /
 * {@link VueAdapter} method-for-method so `conjure` and the M4 preview pipeline
 * treat every framework the same:
 *   - {@link HtmlAdapter.renderSource}  → `<Name>.html` (the canonical source, which
 *     for vanilla HTML is *also* the browser-ready `preview.html` the M4-03 grid
 *     loads directly via `<iframe src="…/preview.html">`)
 *   - {@link HtmlAdapter.renderPreview} → `<Name>.preview.js` — a self-contained
 *     **IIFE** exposing a `mount(target)` on `globalThis.GenieComponent`
 *     (`{ default, <Name> }`) for the JS-based mount path, byte-identical across
 *     runs (no bundler, no `Date.now()`/random)
 *   - {@link HtmlAdapter.extractDts}    → `<Name>.d.ts` — a valid empty module: a
 *     vanilla-HTML component exports no TypeScript types (see below)
 *
 * ── Why no bundler / no host-global plugin ────────────────────────────────────
 * React and Vue need esbuild because their sources must be *compiled* (JSX / the
 * SFC template + scoped styles) and their bundles import a framework runtime from
 * a bare specifier (`react` / `vue`) that {@link hostReactGlobalsPlugin} /
 * `hostVueGlobalPlugin` must rewrite to a `window.*` host global — otherwise the
 * IIFE lowers to a throwing `require("react")` (the DRO-624 failure mode).
 *
 * Vanilla HTML has **neither problem**: the source is already browser-ready markup
 * with inline `<style>`/`<script>`, and there is no framework runtime to resolve —
 * so `renderPreview` needs no esbuild, no `external`, and no host-global plugin,
 * and the `require(...)` failure mode simply cannot arise. The M2-08 issue's own
 * scope note says as much: "renderPreview (the HTML itself is already browser-ready
 * — mostly a pass-through + optional JS/CSS inlining)". This keeps the adapter's
 * preview path dependency-free (no lazy `import("esbuild")` at all), so a preview
 * is produced synchronously in spirit — the method stays `async` only to satisfy
 * the {@link FrameworkAdapter} contract shared with the bundler-backed adapters.
 *
 * ── Preview global contract (parity with React/Vue) ───────────────────────────
 * The emitted IIFE exposes the component on `window.{@link PREVIEW_GLOBAL_NAME}`
 * (`GenieComponent`) as `{ default: mount, <Name>: mount, mount, html }`, the same
 * `{ default, <Name> }` shape React/Vue expose — so a JS mounter can treat all
 * three frameworks uniformly. `mount(target)` sets `target.innerHTML` to the
 * component markup and then **re-injects** any inline `<script>` (an `innerHTML`
 * assignment parses but never *executes* scripts), so interactive vanilla-HTML
 * components run their JS exactly as they would when the `.html` is loaded as an
 * iframe document. (The M4-03 grid's *primary* path loads the `.html` source
 * directly as an iframe `src`, where the browser runs scripts natively; this IIFE
 * is the parity artefact for a shared-document / programmatic mount.)
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
// HTML, Vue and React cards are mounted through the identical
// `window.GenieComponent` handle. (react.js has no heavy top-level imports —
// only `import type` — so this stays cheap and pulls no esbuild/ts-morph.)
import { PREVIEW_GLOBAL_NAME } from "./react.js";

/**
 * v2 tracking issue this adapter was implemented under (kept exported for
 * provenance and referenced by the conformance suite's URL-shape assertion).
 * Retained now that HTML is no longer a stub — mirrors how `vue.ts` kept
 * `VUE_TRACKING_ISSUE` after DRO-616 graduated Vue.
 */
export const HTML_TRACKING_ISSUE = "https://github.com/roshangautam/genie/issues/130";

/**
 * The runtime `mount(target)` the preview IIFE exposes. Written as a plain string
 * (not compiled) so the preview is deterministic bytes with no bundler in the
 * path. It:
 *   1. assigns the component markup to `target.innerHTML` (fragment-parses the
 *      source — a full `<!doctype>`/`<html>` document degrades gracefully, its
 *      `<style>` + body content preserved), then
 *   2. re-injects every inline `<script>` (attributes + body preserved) because
 *      an `innerHTML` assignment parses `<script>` elements but never runs them —
 *      re-creating each `<script>` node makes the browser execute it, so an
 *      interactive vanilla-HTML component behaves the same as when its `.html` is
 *      loaded as a document.
 * `target.ownerDocument` (not a captured `document`) is used to create the fresh
 * `<script>` so the mounter works in any window it is eval'd into (e.g. the M4
 * preview iframe), not just the one it was authored against.
 */
const MOUNT_FN = [
  "function mount(target) {",
  '  if (!target) throw new Error("genie html preview: mount(target) requires a target element.");',
  "  target.innerHTML = html;",
  '  var scripts = target.querySelectorAll("script");',
  "  for (var i = 0; i < scripts.length; i++) {",
  "    var old = scripts[i];",
  '    var fresh = target.ownerDocument.createElement("script");',
  "    for (var j = 0; j < old.attributes.length; j++) {",
  "      var attr = old.attributes[j];",
  "      fresh.setAttribute(attr.name, attr.value);",
  "    }",
  "    fresh.textContent = old.textContent;",
  "    old.parentNode.replaceChild(fresh, old);",
  "  }",
  "  return target;",
  "}",
].join("\n");

export class HtmlAdapter implements FrameworkAdapter {
  readonly framework: Framework = "html";

  /**
   * A comfortable default card for a vanilla-HTML component when the caller has
   * no better viewport. Matches the React/Vue adapters (and the RFC's default
   * preview grid cell, §7.5) so a framework switch never resizes a card by
   * default.
   */
  readonly defaultViewport: Viewport = { width: 400, height: 300 };

  /**
   * The framework directive `conjure` injects into the generation prompt (AC4):
   * name the target framework and the self-contained vanilla-HTML source shape the
   * model should emit. Unchanged from the M2-08 stub — it was always live metadata
   * (`conjure` reads `promptDirective` for every framework, stub or not), so
   * graduating the codegen methods leaves the directive exactly as it was.
   */
  readonly promptDirective: string = [
    "Target framework: html",
    "Emit a self-contained vanilla HTML component: semantic markup with inline " +
      "<style>, and vanilla JS in a <script> only if interactivity is required.",
  ].join("\n");

  /**
   * The canonical source file: `<Name>.html`, carrying the model-authored markup
   * verbatim. `text/html` is the MIME the whole kit pipeline already uses for
   * `.html` (the `COMPONENT_SCHEMA` fixtures, `validate`'s marker check, and the
   * `kit-files.ts` classifier's default for `.html`), so an adapter-emitted source
   * and a store-read source report the same type.
   *
   * For vanilla HTML this file is *also* the browser-ready `preview.html` the
   * M4-03 grid loads directly as an iframe `src` — there is no compile step
   * between source and preview, unlike `.tsx`/`.vue`.
   */
  renderSource(input: RenderInput): AdapterFile {
    return {
      path: componentPath(input, `${input.componentName}.html`),
      content: input.source,
      mimeType: "text/html",
    };
  }

  /**
   * Emit the browser-ready preview **IIFE** exposing the component on
   * `globalThis.${PREVIEW_GLOBAL_NAME}` as `{ default: mount, <Name>: mount,
   * mount, html }` — the same `{ default, <Name> }` shape React/Vue expose, so a
   * JS mounter treats every framework alike.
   *
   * No bundler is involved: vanilla HTML is already browser-ready and has no
   * framework runtime to resolve, so the IIFE is assembled by string-embedding the
   * source (JSON-encoded, so any quotes/newlines/`</script>` sequences are safe)
   * next to the shared {@link MOUNT_FN}. `async` only to satisfy the shared
   * {@link FrameworkAdapter} contract — there is no awaited work.
   *
   * Byte-stable across runs (the only variable input is the source itself), matching
   * the determinism the Vue adapter takes pains to preserve.
   */
  async renderPreview(input: RenderInput): Promise<AdapterFile> {
    const iife = [
      `var ${PREVIEW_GLOBAL_NAME} = (() => {`,
      `  var html = ${JSON.stringify(input.source)};`,
      ...MOUNT_FN.split("\n").map((line) => `  ${line}`),
      `  return { default: mount, ${JSON.stringify(input.componentName)}: mount, mount: mount, html: html };`,
      `})();`,
      // Mirror esbuild's `format:"iife" + globalName` behaviour: also pin the
      // component onto the global object so a host that reads `window.GenieComponent`
      // finds it regardless of the eval scope.
      `if (typeof globalThis !== "undefined") globalThis.${PREVIEW_GLOBAL_NAME} = ${PREVIEW_GLOBAL_NAME};`,
      "",
    ].join("\n");

    return {
      path: componentPath(input, `${input.componentName}.preview.js`),
      content: iife,
      mimeType: "text/javascript",
    };
  }

  /**
   * Emit a valid empty-module `.d.ts` (`export {};`). A vanilla-HTML component is
   * markup plus optional *inline* vanilla JS — it has no TypeScript source and no
   * ES-module exports, so there is genuinely no type surface to extract (unlike a
   * `.tsx`'s exported props interface or a Vue SFC's `defineProps` interface that
   * React/Vue recover with ts-morph). Rather than run a compiler that would always
   * yield nothing, this returns the same minimal, always-valid `.d.ts` artefact
   * React/Vue fall back to for a source with no exports — so every framework's
   * `extractDts` output is a well-formed `.d.ts`, never an empty or absent file.
   *
   * `async` (with no awaited work) purely to satisfy the shared
   * {@link FrameworkAdapter} contract, whose `extractDts` is `Promise`-returning
   * for React/Vue's lazy ts-morph load.
   */
  async extractDts(input: RenderInput): Promise<AdapterFile> {
    return {
      path: componentPath(input, `${input.componentName}.d.ts`),
      content: `export {};\n`,
      mimeType: "text/plain",
    };
  }
}
