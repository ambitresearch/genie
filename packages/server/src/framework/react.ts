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
 *
 * The only esbuild reference at module scope is the `import type` below: it is a
 * types-only import (erased at compile under `verbatimModuleSyntax`), so it emits
 * no runtime `require("esbuild")` and does not defeat the lazy-load above.
 */
import type { Plugin } from "esbuild";

import {
  componentPath,
  type AdapterFile,
  type FrameworkAdapter,
  type Framework,
  type RenderInput,
  type Viewport,
} from "./interface.js";

/**
 * The global the preview IIFE binds the component to. M4's iframe grid reads
 * `window.GenieComponent` to mount the card; keeping the name here (not in M4)
 * makes the adapter the single source of truth for the preview contract.
 */
export const PREVIEW_GLOBAL_NAME = "GenieComponent";

/**
 * ── Preview host contract (DRO-624 · AC1) — the single source of truth ────────
 *
 * The `<Name>.preview.js` bundle this adapter emits does **not** carry its own
 * copy of React, nor does it `require("react")`. It resolves React from two
 * **host-provided browser globals** the preview iframe must define *before* the
 * bundle's `<script>` runs:
 *
 *   - `window.{@link REACT_HOST_GLOBAL}`      → the React runtime  (`window.React`)
 *   - `window.{@link REACT_DOM_HOST_GLOBAL}`  → the ReactDOM runtime (`window.ReactDOM`)
 *
 * and it exposes the compiled component on `window.{@link PREVIEW_GLOBAL_NAME}`
 * (`{ default, <Name> }`), which the M4-03 iframe grid mounts with the same host
 * `ReactDOM`.
 *
 * ── Why globals, not esbuild `external` ───────────────────────────────────────
 * The original M2-08 code marked React `external` under `format:"iife"`. esbuild
 * has no facility to map an external bare specifier to a browser global, so it
 * lowered `import … from "react"` (plus the `jsx:"automatic"` runtime import)
 * into `require("react")` / `require("react/jsx-runtime")` — calls that throw
 *   `Uncaught Error: Dynamic require of "react" is not supported`
 * the instant the IIFE evaluates inside the iframe (no CommonJS `require` there).
 * The bundle would never mount. (Flagged by Copilot on PR #131 `react.ts:103`,
 * merged unresolved; the M2-08 conformance test only asserted on bundle *text*,
 * so it never surfaced.) The fix — {@link hostReactGlobalsPlugin} — intercepts
 * those specifiers at bundle time and rewrites them to read the host globals.
 *
 * ── How the host provides the globals (PRD §6.6 / FR-056) ─────────────────────
 * Per the on-disk layout (PRD §6.6) each kit vendors the runtime under `_vendor/`:
 *   `_vendor/react.production.min.js` + `_vendor/react-dom.production.min.js`.
 * The iframe host page `<script>`-includes those UMD builds (which self-assign
 * `window.React` / `window.ReactDOM`) ahead of the component bundle. This is the
 * global-based contract FR-056 already describes for the aggregate
 * `_genie_bundle.js` (`window.<KitGlobal>.<Component>`); a single-component
 * preview is the same shape narrowed to one export exposed on
 * `window.{@link PREVIEW_GLOBAL_NAME}`.
 *
 * NOTE — **React 18, UMD**: the contract depends on a runtime that ships a UMD
 * build defining a `window.React` global. React 19 removed the UMD builds, so
 * the vendored `_vendor/react*.min.js` must be the React 18 UMD production
 * bundles (the adapter's execution test pins the same major).
 */
export const REACT_HOST_GLOBAL = "React";
export const REACT_DOM_HOST_GLOBAL = "ReactDOM";

/**
 * esbuild namespace the virtual React shim modules live in (kept off the real
 * filesystem so nothing resolves to an on-disk `node_modules`).
 */
const HOST_NAMESPACE = "genie-react-host-global";

/**
 * The automatic-JSX runtime, re-expressed against `window.React`.
 *
 * `jsx:"automatic"` makes esbuild import `jsx` / `jsxs` / `Fragment` from
 * `react/jsx-runtime`, but a vendored UMD `window.React` only exposes the classic
 * `createElement` / `Fragment` — it has no `jsx-runtime` entry. This shim bridges
 * the two: it re-implements the automatic runtime's `jsx(type, props, key)` in
 * terms of `React.createElement`. `props.children` (where the automatic runtime
 * puts children) flows straight through, and a defined `key` is merged into the
 * config so `createElement` picks it up as the reserved key prop.
 */
const JSX_RUNTIME_SHIM = [
  `var React = window.${REACT_HOST_GLOBAL};`,
  `if (!React) throw new Error(${JSON.stringify(hostMissingMessage(REACT_HOST_GLOBAL))});`,
  `function jsx(type, props, key) {`,
  `  return React.createElement(type, key === void 0 ? props : Object.assign({}, props, { key: key }));`,
  `}`,
  `exports.jsx = jsx;`,
  `exports.jsxs = jsx;`,
  `exports.jsxDEV = jsx;`,
  `exports.Fragment = React.Fragment;`,
].join("\n");

/** A clear, actionable error when the iframe forgot to load a vendored global. */
function hostMissingMessage(global: string): string {
  return (
    `genie preview host contract violated: window.${global} is not defined. ` +
    `The preview iframe must load the vendored _vendor/${global === REACT_HOST_GLOBAL ? "react" : "react-dom"}.production.min.js ` +
    `(React 18 UMD) before the component bundle — see the preview host contract in react.ts.`
  );
}

/** CJS body for a virtual module that re-exports a host global. */
function hostGlobalModule(global: string): string {
  return [
    `if (!window.${global}) throw new Error(${JSON.stringify(hostMissingMessage(global))});`,
    `module.exports = window.${global};`,
  ].join("\n");
}

/**
 * esbuild plugin implementing the {@link REACT_HOST_GLOBAL} contract (DRO-624 ·
 * AC2). It intercepts every React bare specifier the source (or the automatic
 * JSX transform) can reference and resolves it to an in-memory virtual module
 * that reads the corresponding host global — so the emitted IIFE contains **no**
 * `require("react")` and instead references `window.React` / `window.ReactDOM`.
 *
 *   - `react`                         → `window.React`
 *   - `react-dom`, `react-dom/client` → `window.ReactDOM`
 *   - `react/jsx-runtime`, `…/jsx-dev-runtime` → {@link JSX_RUNTIME_SHIM}
 */
export function hostReactGlobalsPlugin(): Plugin {
  return {
    name: "genie-react-host-globals",
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: HOST_NAMESPACE }));
      build.onResolve({ filter: /^react-dom(\/client)?$/ }, () => ({
        path: "react-dom",
        namespace: HOST_NAMESPACE,
      }));
      build.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, () => ({
        path: "jsx-runtime",
        namespace: HOST_NAMESPACE,
      }));

      build.onLoad({ filter: /.*/, namespace: HOST_NAMESPACE }, (args) => {
        if (args.path === "react") {
          return { contents: hostGlobalModule(REACT_HOST_GLOBAL), loader: "js" };
        }
        if (args.path === "react-dom") {
          return { contents: hostGlobalModule(REACT_DOM_HOST_GLOBAL), loader: "js" };
        }
        return { contents: JSX_RUNTIME_SHIM, loader: "js" };
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
   * `globalThis.${PREVIEW_GLOBAL_NAME}` (AC2). React is resolved from the host
   * iframe's globals via {@link hostReactGlobalsPlugin} — see the *Preview host
   * contract* above — so the output is a single self-contained script the M4
   * iframe can `<script>`-include and mount with its own vendored React, with no
   * `Dynamic require of "react"` at runtime (DRO-624).
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
      // React / ReactDOM / the JSX runtime are rewritten to the preview host's
      // browser globals (window.React / window.ReactDOM) rather than inlined or
      // left as throwing `require(...)` calls — see the Preview host contract.
      plugins: [hostReactGlobalsPlugin()],
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
