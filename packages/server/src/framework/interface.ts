/**
 * `FrameworkAdapter` (M2-08 · DRO-255) — the seam that abstracts `conjure`'s
 * framework-specific bits so **React lands in v1** and **Vue / vanilla HTML** can
 * be added later *without refactoring the generation pipeline*.
 *
 * ── Why an adapter, and what it does *not* touch ─────────────────────────────
 * `conjure` (M2-03) is pure generation: the configured LLM returns the whole
 * validated `COMPONENT_SCHEMA` file set (source + `<Name>.html` preview + manifest
 * metadata), and `conjure` never post-processes it. The *only* framework-specific
 * bit `conjure` carries today is the "Target framework: …" prompt directive. This
 * adapter owns that directive (via {@link FrameworkAdapter.promptDirective}) plus
 * the three codegen operations a *future* pipeline (M4 preview compile, refine
 * post-processing) will need per framework:
 *
 *   - {@link FrameworkAdapter.renderSource}  — the canonical source file
 *   - {@link FrameworkAdapter.renderPreview} — a browser-ready preview bundle (IIFE)
 *   - {@link FrameworkAdapter.extractDts}    — the component's `.d.ts` typings
 *
 * plus one piece of sizing metadata (not codegen):
 *
 *   - {@link FrameworkAdapter.defaultViewport} — the card size for this framework
 *
 * Cribs the staged-IR shape from `Kinglions/ui-design-to-code-mcp` (research §5
 * prior art #3: `ingest_* → build_semantic_ir → build_cross_platform_nodes →
 * build_target_*`): {@link RenderInput} is the neutral semantic node the three
 * `render*`/`extract*` methods lower into a concrete target artefact.
 *
 * Only {@link ReactAdapter} implements the codegen methods in v1. {@link VueAdapter}
 * and {@link HtmlAdapter} construct fine and expose their identity + viewport
 * (so `conjure`'s adapter selection never breaks for them), but their codegen
 * methods throw a structured {@link NotYetImplementedError} with a link to the
 * tracking issue (AC3).
 */

/**
 * The frameworks `conjure` can target (research §3.1: `"react" | "vue" | "html"`).
 * Single source of truth: `conjure` re-exports these as `CONJURE_FRAMEWORKS` /
 * `ConjureFramework` so the tool boundary and the adapter registry can never drift.
 */
export const FRAMEWORKS = ["react", "vue", "html"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

/** Default target framework (AC2 — React is the v1 framework). */
export const DEFAULT_FRAMEWORK: Framework = "react";

/**
 * Card/preview dimensions for a framework. Mirrors the `Viewport` `$def` in
 * `COMPONENT_SCHEMA` (M2-02) so an adapter-supplied fallback slots straight into
 * a `manifestEntry.viewport` without a shape conversion.
 */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * The neutral, framework-agnostic description of the component to lower — the
 * "semantic IR node" the adapter's target methods consume. `source` is the
 * framework's own source text (for React: the `.tsx`); `componentName` is
 * PascalCase and `group` is kebab-case, matching `COMPONENT_SCHEMA`.
 */
export interface RenderInput {
  componentName: string;
  group: string;
  source: string;
}

/**
 * A single emitted file. Deliberately the exact shape of a `COMPONENT_SCHEMA`
 * `files[]` entry (`{ path, content, mimeType }`) so adapter output composes
 * directly into a component's file set, and every `path` matches the schema's
 * `components/<group>/<Name>/…` `PATH_PATTERN`.
 */
export interface AdapterFile {
  path: string;
  content: string;
  mimeType: string;
}

/**
 * The framework adapter contract (AC1). Metadata (`framework`, `defaultViewport`)
 * is always available — `conjure` reads it during adapter selection for *every*
 * framework, including the stubs. The three codegen methods are what a stub
 * leaves unimplemented.
 */
export interface FrameworkAdapter {
  /** This adapter's framework identity (drives `conjure`'s prompt directive). */
  readonly framework: Framework;
  /** Default card size when a caller has no better viewport (AC1). */
  readonly defaultViewport: Viewport;
  /**
   * The framework-specific instruction block `conjure` injects into the user
   * message (AC4 — the one framework-specific bit `conjure` carries today, now
   * owned by the adapter). Begins with `Target framework: <framework>` so the
   * generation prompt names the target unambiguously, then adds any per-framework
   * source-shape guidance. Available on **every** adapter (stubs included) — it
   * is metadata the *model* uses, not codegen, so `conjure` (pure LLM generation)
   * works for all three frameworks even while Vue/HTML codegen is stubbed.
   */
  readonly promptDirective: string;
  /** Lower the IR to the canonical source file (React: `<Name>.tsx`) (AC1). */
  renderSource(input: RenderInput): AdapterFile;
  /** Bundle the component to a browser-ready preview IIFE (AC1/AC2). Async: it
   * lazy-loads esbuild so resolving an adapter never pulls the bundler until a
   * preview is actually built. */
  renderPreview(input: RenderInput): Promise<AdapterFile>;
  /** Extract the component's `.d.ts` typings (React: via `ts-morph`) (AC1/AC2).
   * Async for the same lazy-load reason as {@link renderPreview}. */
  extractDts(input: RenderInput): Promise<AdapterFile>;
}

/**
 * Structured error a stub adapter throws from its codegen methods (AC3). Carries
 * the `framework` and a `trackingIssue` URL so a caller (or the MCP tool
 * boundary) can surface *which* framework is missing and *where* to follow its
 * v2 implementation — not just an opaque "not implemented".
 */
export class NotYetImplementedError extends Error {
  readonly code = "ERR_FRAMEWORK_NOT_IMPLEMENTED" as const;
  constructor(
    readonly framework: Framework,
    readonly trackingIssue: string,
  ) {
    super(
      `The "${framework}" framework adapter is not implemented yet — React is the ` +
        `only framework supported in v1. Track its v2 implementation at ${trackingIssue}.`,
    );
    this.name = "NotYetImplementedError";
  }
}

/**
 * Build the shared `components/<group>/<Name>/<basename>` path every adapter
 * file lives under, so the on-disk layout stays identical across frameworks and
 * matches `COMPONENT_SCHEMA`'s `PATH_PATTERN`.
 */
export function componentPath(input: RenderInput, basename: string): string {
  return `components/${input.group}/${input.componentName}/${basename}`;
}

// ── Registry (AC4) ─────────────────────────────────────────────────────────────
//
// Lazy singletons: adapters are cheap to construct, but keeping one instance
// each avoids re-allocating on every `conjure` call. Populated on first
// `getAdapter` via dynamic import so `interface.ts` stays free of a static
// dependency on the concrete adapters (and their esbuild/ts-morph imports).

const cache = new Map<Framework, FrameworkAdapter>();

/**
 * Resolve the {@link FrameworkAdapter} for a framework (AC4). `conjure` calls
 * this to pick the adapter from its `framework` input. Throws `RangeError` for a
 * value outside {@link FRAMEWORKS} — but `conjure`'s Zod enum already rejects
 * those upstream, so in practice this only ever sees a valid framework.
 */
export async function getAdapter(framework: Framework): Promise<FrameworkAdapter> {
  const cached = cache.get(framework);
  if (cached) return cached;

  let adapter: FrameworkAdapter;
  switch (framework) {
    case "react": {
      const { ReactAdapter } = await import("./react.js");
      adapter = new ReactAdapter();
      break;
    }
    case "vue": {
      const { VueAdapter } = await import("./vue.js");
      adapter = new VueAdapter();
      break;
    }
    case "html": {
      const { HtmlAdapter } = await import("./html.js");
      adapter = new HtmlAdapter();
      break;
    }
    default: {
      // Exhaustiveness guard: if `Framework` gains a member, this errors at
      // compile time (never at runtime for a Zod-validated input).
      const never: never = framework;
      throw new RangeError(`Unknown framework: ${String(never)}`);
    }
  }
  cache.set(framework, adapter);
  return adapter;
}
