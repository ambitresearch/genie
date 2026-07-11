/**
 * `ensureManifest` — the single entry point for "compile the kit's manifest and
 * make sure `.genie/manifest.json` reflects it" (design: 2026-07-05 chat-
 * invocation, piece A).
 *
 * ## Why this exists
 *
 * Manifest compilation ({@link compileManifest}) already writes
 * `.genie/manifest.json` atomically as its final step. But historically the
 * ONLY caller that triggered a compile at request time was the `ui://genie/grid`
 * resource handler ({@link file://../ui/grid-resource.ts}). The `preview` tool
 * booted the viewer WITHOUT compiling, so a caller that opened the Vite /
 * `file://` vehicle — or an MCP Inspector that cannot read `ui://` resources at
 * all — saw an EMPTY grid, and `list_components` (which reads the compiled
 * manifest) returned `[]` until some unrelated `ui://` read happened to compile
 * it. That order-dependence was the root of the "preview shows nothing" bug.
 *
 * Routing BOTH the `preview` tool and the grid resource through this one helper
 * removes the divergence: there is exactly one way a manifest gets produced +
 * persisted at request time, so the two surfaces can never drift on how (or
 * whether) they compile.
 *
 * ## Contract
 *
 * Given a kit directory, compile it from what's on disk right now and return the
 * resulting {@link Manifest}. Persistence of `.genie/manifest.json` is inherited
 * from {@link compileManifest} (its atomic stage-then-rename write) — this
 * wrapper adds no write of its own; it exists to (a) give callers the
 * manifest-only shape they want without each re-destructuring `{ manifest }`,
 * and (b) be the named seam both the tool and the resource depend on.
 *
 * The `skipped` diagnostics from a compile are intentionally dropped here — the
 * two callers (`preview`, grid resource) only need the manifest to render;
 * surfacing skipped/invalid components is `validate`'s job, not the view path's.
 */
import { compileManifest, type Manifest } from "./compiler.js";

/**
 * Compile `kitDir`'s manifest from disk and persist `.genie/manifest.json`
 * (persistence via {@link compileManifest}). Returns the compiled manifest.
 *
 * Throws whatever {@link compileManifest} throws (e.g. an unreadable kit dir);
 * callers that must degrade to an empty grid rather than error — like the grid
 * resource — catch it themselves, preserving their existing failure semantics.
 */
export async function ensureManifest(kitDir: string): Promise<Manifest> {
  const { manifest } = await compileManifest(kitDir);
  return manifest;
}
