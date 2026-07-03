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
 * The global the preview IIFE binds the component to. M4's iframe grid reads
 * `window.GenieComponent` to mount the card; keeping the name here (not in M4)
 * makes the adapter the single source of truth for the preview contract.
 */
export const PREVIEW_GLOBAL_NAME = "GenieComponent";

/**
 * React preview host provides `react` / `react-dom` as externals (M4 supplies
 * them on the iframe global scope), so the bundle stays small and shares one
 * React instance with the host rather than inlining its own copy.
 */
const REACT_EXTERNALS = ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"];

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
   * `globalThis.${PREVIEW_GLOBAL_NAME}` (AC2). Uses esbuild's `bundle` build with
   * React marked external and the automatic JSX runtime, so the output is a
   * single self-contained script the M4 iframe can `<script>`-include.
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
      // React (and its jsx-runtime) are provided by the preview host, not inlined.
      external: REACT_EXTERNALS,
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
