/**
 * `ReactAdapter` (M2-08 · DRO-255 · AC2) — the v1 framework adapter.
 *
 * Lowers a neutral {@link RenderInput} (the component's `.tsx` source) into the
 * three React target artefacts:
 *   - {@link ReactAdapter.renderSource}  → `<Name>.tsx` (the canonical source)
 *   - {@link ReactAdapter.renderPreview} → `<Name>.preview.js` — an **esbuild IIFE
 *     bundle** exposing the component on `globalThis.GenieComponent` for the M4
 *     iframe grid to mount
 *   - {@link ReactAdapter.extractDts}    → `<Name>.d.ts` — the component's typings,
 *     extracted with **ts-morph** (declaration-only in-memory emit)
 *
 * ── Import-time safety ────────────────────────────────────────────────────────
 * `esbuild` and `ts-morph` are heavy transitive graphs. Neither is imported at
 * this module's top level — each is reached through a lazy `await import(...)`
 * *inside* the one method that needs it. So the registry
 * (`interface.ts#getAdapter`) can resolve a `ReactAdapter` — and `conjure` can
 * read its `promptDirective` / `defaultViewport` on the generation hot path —
 * without ever pulling the bundler or the TS compiler, which only load when a
 * preview/`.d.ts` is actually produced (M4 preview compile, refine post-process).
 */
import {
  componentPath,
  type AdapterFile,
  type FrameworkAdapter,
  type Framework,
  type RenderInput,
  type Viewport,
} from "./interface.js";

/**
 * ── Preview host contract (DRO-624 · AC1 — the single source of truth) ────────
 *
 * The `.preview.js` IIFE this adapter emits does NOT inline React. It expects
 * the **M4 iframe host page** to supply React on the iframe's global scope, and
 * to read the component back off the same global. The full contract:
 *
 *   The host page (M4-03 iframe grid) MUST, *before* loading `<Name>.preview.js`:
 *     1. `<script src="…/_vendor/react.production.min.js">`      → defines `window.React`
 *     2. `<script src="…/_vendor/react-dom.production.min.js">`  → defines `window.ReactDOM`
 *   …then load the preview bundle:
 *     3. `<script src="…/<Name>.preview.js">`  → assigns `window.${PREVIEW_GLOBAL_NAME}`
 *   …then mount:
 *     4. `ReactDOM.createRoot(el).render(React.createElement(window.${PREVIEW_GLOBAL_NAME}.default))`
 *
 * The bundle references React through those globals (`window.React` /
 * `window.ReactDOM`) — see {@link reactHostGlobalPlugin}. This is what closes the
 * gap the previous `external: [...]` config left open: esbuild rewrote bare
 * `import … from "react"` into `require("react")`, which throws
 * `Dynamic require of "react" is not supported` in a browser iframe (there is no
 * `require`). Mapping the imports to the host globals instead means the emitted
 * bundle runs with zero module-loader assumptions.
 *
 * Why globals (not externals, not an inlined copy):
 *   - **FR-056 / PRD §6.6.** The on-disk layout vendors
 *     `_vendor/react.production.min.js` + `_vendor/react-dom.production.min.js`
 *     and describes `<Name>.jsx` as an "IIFE stub re-exporting from window global"
 *     — i.e. the contract is explicitly global-based. This adapter implements
 *     exactly that shape.
 *   - **One React instance.** Every card in the grid shares the host's single
 *     React, rather than each preview inlining ~140 KB of its own copy.
 *
 * What the vendored `_vendor/*` files MUST publish (the M4/sync vendoring step
 * owns *producing* them; this adapter owns the *shape* they must satisfy):
 *   - `window.React`    — at least `createElement` + `Fragment` (what the jsx shim
 *     below calls). Hooks etc. ride along for components that use them.
 *   - `window.ReactDOM` — at least `createRoot` (React 18+ client API; the host's
 *     mount step calls `ReactDOM.createRoot(el).render(…)`).
 *   NB React 18+ dropped the legacy in-package UMD bundles, and 19 ships no
 *   official UMD at all — so "vendored `_vendor/*.js`" means *a build that assigns
 *   those globals* (e.g. a tiny IIFE wrapper: `window.React = <react>`,
 *   `window.ReactDOM = <react-dom/client>`), not necessarily a file lifted
 *   verbatim from the npm package. The global *names* are the contract; how the
 *   file is produced is M4/sync's choice.
 *
 * The React global exposes `createElement` / `Fragment` but NOT the
 * automatic-runtime `react/jsx-runtime` module — so the plugin bridges
 * `jsx`/`jsxs`/`Fragment` to `React.createElement` rather than to a (non-existent)
 * jsx-runtime global.
 */

/**
 * The global the preview IIFE binds the component to. M4's iframe grid reads
 * `window.GenieComponent` to mount the card; keeping the name here (not in M4)
 * makes the adapter the single source of truth for the preview contract.
 *
 * (FR-056 envisions per-kit component namespacing, `window.<KitGlobal>.<Component>`;
 * that kit-bundle assembly is M4/sync's concern. A single-component preview
 * bundle uses this fixed global — the mount step reads `.default` off it.)
 */
export const PREVIEW_GLOBAL_NAME = "GenieComponent";

/**
 * The host globals the preview bundle resolves React / ReactDOM from — the
 * `window.<name>` the vendored `_vendor/*` files publish (see {@link REACT_VENDOR_FILES}).
 * Exported so M4's host page and the execution test reference the same names the
 * bundle was compiled against, with no drift.
 */
export const REACT_HOST_GLOBAL = "React";
export const REACT_DOM_HOST_GLOBAL = "ReactDOM";

/**
 * The vendored runtime files the host page must load before a preview bundle
 * (PRD §6.6 `_vendor/`). Named here so the adapter — the source of truth for the
 * preview contract — also owns *what* the host is expected to provide.
 */
export const REACT_VENDOR_FILES = [
  "_vendor/react.production.min.js",
  "_vendor/react-dom.production.min.js",
] as const;

/**
 * The React module specifiers the preview bundle imports and the plugin rewrites
 * to host globals. `react` / `react-dom` (+ `react-dom/client`) map to their
 * `window.*` global; the two automatic-runtime jsx modules are bridged to
 * `React.createElement` (the host React global has no jsx-runtime export).
 */
const REACT_HOST_MODULE_FILTER = /^(react|react-dom)(\/(client|jsx-runtime|jsx-dev-runtime))?$/;
const JSX_RUNTIME_SPECIFIERS = new Set(["react/jsx-runtime", "react/jsx-dev-runtime"]);
/** Namespace the plugin parks resolved React specifiers under. */
const REACT_HOST_NAMESPACE = "genie-react-host-global";

/**
 * esbuild plugin implementing the host-global contract (DRO-624 · AC2). Instead
 * of marking React `external` — which makes esbuild emit `require("react")`,
 * fatal in a browser iframe — every React specifier is resolved into a virtual
 * module whose body reads the host global:
 *
 *   - `react`                       → `module.exports = window.React`
 *   - `react-dom`, `react-dom/client` → `module.exports = window.ReactDOM`
 *   - `react/jsx-runtime` /
 *     `react/jsx-dev-runtime`        → a shim mapping `jsx`/`jsxs`/`jsxDEV`/`Fragment`
 *                                       onto `window.React.createElement` / `.Fragment`
 *
 * The jsx shim exists because the host `window.React` global publishes
 * `createElement` but not a `react/jsx-runtime` module; `jsx(type, config, key)` is
 * a stable React signature (key arrives as a positional 3rd arg, folded into props).
 * It also marks each produced element key-validated (`_store.validated`) — matching
 * the real automatic runtime, whose whole point over `createElement` is that the
 * compiler already guaranteed keys, so React skips the dev-only per-child key check.
 * (Guarded: a no-op on any React whose element shape lacks a writable `_store`, and
 * irrelevant to the production runtime, which has no such check.)
 */
function reactHostGlobalPlugin(): import("esbuild").Plugin {
  return {
    name: REACT_HOST_NAMESPACE,
    setup(build) {
      build.onResolve({ filter: REACT_HOST_MODULE_FILTER }, (args) => ({
        path: args.path,
        namespace: REACT_HOST_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: REACT_HOST_NAMESPACE }, (args) => {
        if (JSX_RUNTIME_SPECIFIERS.has(args.path)) {
          // Bridge the automatic JSX runtime onto the host global's createElement.
          return {
            loader: "js",
            contents: [
              `var React = window.${REACT_HOST_GLOBAL};`,
              "function jsx(type, config, maybeKey) {",
              "  var props = maybeKey === void 0 ? config : Object.assign({}, config, { key: maybeKey });",
              "  var element = React.createElement(type, props);",
              "  // Match the real jsx-runtime: mark compiler-emitted elements as",
              "  // key-validated so React skips its dev-only per-child key check.",
              "  try { if (element && element._store) element._store.validated = 1; } catch (e) {}",
              "  return element;",
              "}",
              "exports.Fragment = React.Fragment;",
              "exports.jsx = jsx;",
              "exports.jsxs = jsx;",
              "exports.jsxDEV = jsx;",
            ].join("\n"),
          };
        }
        const globalName = args.path.startsWith("react-dom")
          ? REACT_DOM_HOST_GLOBAL
          : REACT_HOST_GLOBAL;
        return { loader: "js", contents: `module.exports = window.${globalName};` };
      });
    },
  };
}

export class ReactAdapter implements FrameworkAdapter {
  readonly framework: Framework = "react";

  /**
   * A comfortable default card for a React component when the caller has no
   * better viewport. Matches the RFC's default preview grid cell (§7.5).
   */
  readonly defaultViewport: Viewport = { width: 400, height: 300 };

  /**
   * The framework directive `conjure` injects into the generation prompt (AC4):
   * name the target framework and the React source shape the model should emit.
   */
  readonly promptDirective: string = [
    "Target framework: react",
    "Emit an idiomatic React function component in TypeScript (.tsx). Type its props " +
      "with an exported interface, and prefer semantic HTML with className-based styling.",
  ].join("\n");

  /**
   * The canonical source file: `<Name>.tsx`, carrying the model-authored source
   * verbatim. `text/tsx` mirrors the mimeType the M2-03 fixtures already use for
   * `.tsx` entries.
   */
  renderSource(input: RenderInput): AdapterFile {
    return {
      path: componentPath(input, `${input.componentName}.tsx`),
      content: input.source,
      mimeType: "text/tsx",
    };
  }

  /**
   * Bundle the component to a browser-ready **IIFE** exposing it on
   * `globalThis.${PREVIEW_GLOBAL_NAME}` (AC2), resolving React from the host
   * globals per the preview host contract documented at the top of this module.
   * The output is a single self-contained script the M4 iframe can
   * `<script>`-include after the vendored `_vendor/react*` globals are present —
   * with **no `require`/module loader** assumptions (that was DRO-624: the old
   * `external: [react]` config emitted `require("react")`, which throws
   * `Dynamic require of "react" is not supported` in a browser iframe).
   *
   * esbuild is imported lazily here (not at module top) so resolving a
   * `ReactAdapter` — which the registry does on first `getAdapter("react")` —
   * doesn't pull esbuild's native binary until a preview is actually built.
   */
  async renderPreview(input: RenderInput): Promise<AdapterFile> {
    const esbuild = (await import("esbuild")).default;
    const result = await esbuild.build({
      stdin: {
        contents: input.source,
        loader: "tsx",
        sourcefile: `${input.componentName}.tsx`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      globalName: PREVIEW_GLOBAL_NAME,
      platform: "browser",
      jsx: "automatic",
      // React (and its jsx-runtime) are resolved from the host globals the M4
      // iframe provides — see reactHostGlobalPlugin / the module-top contract.
      plugins: [reactHostGlobalPlugin()],
      logLevel: "silent",
    });
    const output = result.outputFiles[0];
    if (!output) {
      // esbuild returns at least one output file on success; this guards the
      // types, it is not an expected runtime branch.
      throw new Error("esbuild produced no preview output for the React component.");
    }
    return {
      path: componentPath(input, `${input.componentName}.preview.js`),
      content: output.text,
      mimeType: "text/javascript",
    };
  }

  /**
   * Extract the component's `.d.ts` typings with ts-morph (AC2), via an
   * in-memory declaration-only emit so nothing touches disk. The virtual project
   * carries `jsx: react-jsx` + `skipLibCheck` so a `.tsx` source with JSX and
   * bare `react` imports emits declarations even without `@types/react` present
   * in the virtual FS (we never type-check, only emit declarations).
   *
   * ts-morph is imported lazily (not at module top) for the same reason as
   * esbuild in {@link renderPreview}: keep resolving the adapter cheap.
   */
  async extractDts(input: RenderInput): Promise<AdapterFile> {
    const { Project, ts } = await import("ts-morph");
    const project = new Project({
      useInMemoryFileSystem: true,
      // `skipLibCheck` + declaration-only emit means missing lib/@types never
      // block emission; we want the *shape*, not a clean type-check.
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        skipLibCheck: true,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    });
    const sourceName = `${input.componentName}.tsx`;
    project.createSourceFile(sourceName, input.source, { overwrite: true });
    const emitted = project.emitToMemory({ emitOnlyDtsFiles: true });
    const dtsFile = emitted.getFiles().find((f) => f.filePath.endsWith(".d.ts"));
    const content =
      dtsFile?.text ??
      // Fallback: a source with no exported declarations legitimately yields no
      // `.d.ts`. Emit a minimal module marker rather than an empty file so the
      // artefact is always a valid `.d.ts`.
      `export {};\n`;
    return {
      path: componentPath(input, `${input.componentName}.d.ts`),
      content,
      mimeType: "text/plain",
    };
  }
}
