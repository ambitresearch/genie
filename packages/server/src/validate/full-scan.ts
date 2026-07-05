/**
 * `validate`'s full-scan facet (M3-04 / DRO-260): the heavyweight walk that
 * runs the `@genie` marker check (M3-01), the "thin render" check, and the
 * "variants identical" perceptual-hash check across a kit's every `.html`
 * file and returns structured findings (D-A: this is one facet of the single
 * `validate` verb; the counter-persistence facet is M1-12 / `validate.ts`).
 *
 * Orchestration only — the individual checks are pure/DI'd modules this file
 * composes:
 *   - `validate/marker.ts` (M3-01, already shipped)          → `markerMissing`
 *   - `validate/render.ts`'s injectable {@link Renderer}      → `thin` + the
 *     screenshots `variantsIdentical` hashes
 *   - `validate/phash.ts` (this issue)                        → `variantsIdentical`
 *
 * ── Dependency injection: caller owns the seams (and the browser lifecycle) ───
 * `fullScan` takes a {@link FullScanDeps} bag — a `FullScanKitStore` (the read
 * slice of `KitStore`) and a `Renderer | null` — exactly as `refine.ts` takes
 * a `RefineKitStore`/`RegionCropper`. The CALLER (the `validate` MCP tool, or a
 * test) creates the one headless-Chromium `Renderer` reused across the whole
 * scan (AC7's < 5 s / 50-component budget) and is responsible for `close()`-ing
 * it afterward; `fullScan` never closes a renderer it did not create. Unit
 * tests inject an in-memory store + a stub renderer, so the suite runs fully
 * offline with no Playwright/Chromium.
 *
 * ── Graceful degradation (renderer === null) ─────────────────────────────────
 * AC4 (thin) and AC5 (variantsIdentical) need a real render; Playwright is an
 * OPTIONAL peer dependency (see `render.ts`). When the injected renderer is
 * `null` (Playwright/Chromium unavailable — a stripped install, a CI runner
 * missing the browser or its OS libs), the scan still returns `markerMissing`
 * (pure regex) and `total`, with `thin`/`variantsIdentical` empty — rather than
 * failing the whole `validate` call over an environment gap. Same posture as
 * `refine.ts`'s AC7 region crop degrading to no image.
 *
 * ── Read-only: never perturbs card bytes (RFC G-5) ───────────────────────────
 * Every check reads bytes the store already holds and renders them in a
 * throwaway page; nothing here writes to the kit. `validate` is a read-side
 * verb, so the G-5 "cards byte-identical across vehicles" guarantee is
 * structurally impossible to violate from this module.
 */
import { validateMarker, extractViewport } from "./marker.js";
import { computePHash, findDuplicateClusters, type HashedEntry } from "./phash.js";
import type { Renderer } from "./render.js";

/**
 * The read slice of `KitStore` this facet needs — `listFiles` to enumerate the
 * kit tree and `readFile` to pull each preview's bytes. Declared narrowly (not
 * the whole `KitStore`) so a unit test injects a two-method in-memory stub,
 * mirroring `refine.ts`'s `RefineKitStore`. A real `KitStore` (LocalFs / git
 * host) is structurally assignable, so `server.ts` passes its shared store
 * unchanged (the extra `readFile` fields — `encoding`, `mimeType` — are simply
 * ignored here).
 */
export interface FullScanKitStore {
  listFiles(kitId: string): Promise<Array<{ path: string }>>;
  readFile(kitId: string, path: string): Promise<{ content: string }>;
}

/** AC6 — the shape `validate`'s full-scan facet returns. */
export interface FullScanResult {
  /** Paths whose first line fails the M3-01 `@genie` marker regex (AC3). */
  markerMissing: string[];
  /** Paths whose rendered content height is below `meta.json`'s
   * `renderCheck.minHeight` (default 80px) (AC4). */
  thin: string[];
  /** Paths whose render perceptually hashes the same as another path's (AC5). */
  variantsIdentical: string[];
  /** Total `.html` files inspected — i.e. successfully read (AC6). */
  total: number;
  /** `markerMissing.length + thin.length + variantsIdentical.length` (AC6). */
  bad: number;
}

/** Injected dependencies for {@link fullScan}. */
export interface FullScanDeps {
  /** Read port over the kit (AC3 enumerate + read). Required. */
  kitStore: FullScanKitStore;
  /**
   * The one headless renderer reused across the scan (AC4/AC5), or `null` to
   * run marker-only (graceful degradation — see the module doc). The caller
   * owns this instance's lifecycle (create once per scan, `close()` after).
   */
  renderer: Renderer | null;
  /** pHash tolerance override (bits) — defaults to `phash.ts`'s calibrated
   * `DEFAULT_TOLERANCE_BITS`. Exposed for tuning/tests. */
  toleranceBits?: number;
}

/** The `validate` verb's input (AC2). `planId` is accepted per the verb's
 * declared `validate({ kitId, planId? })` signature (a scan MAY run mid-write-
 * sequence) but is not otherwise consumed by this facet — no AC ties scan
 * behavior to it, and the full-kit scan reads the committed readable surface. */
export interface FullScanInput {
  kitId: string;
  planId?: string;
}

/** Default "thin" gate (AC4) when a component's `meta.json` doesn't specify
 * `renderCheck.minHeight` — `docs/plan/04-tech-design-rfc.md` §7.3 / PRD FR-051. */
const DEFAULT_MIN_HEIGHT = 80;

/** Render viewport used for both the thin-height measurement and the
 * perceptual-hash screenshot when a component names NEITHER an `@genie`
 * marker `viewport="WxH"` token NOR a `meta.json` `viewport` override — the
 * last-resort fallback, same default `refine.ts`'s `deriveRenderViewport`
 * falls back to, so a kit that specifies no size anywhere still gets a
 * consistent, reasonably-sized render across every tool that renders it.
 *
 * ── DRO-711 QA finding: this is now the THIRD-choice source, not the second ──
 * Real-Chromium QA (DRO-711, post-merge hardening of DRO-260/PR #152) found
 * that `conjure.ts` — genie's only real component-authoring path — never
 * synthesizes a `meta.json` itself; the LLM system prompt only *encourages*
 * one ("You may also add … a `meta.json`") and the output JSON Schema does
 * NOT require it (`files` needs just one `<Name>.html` match). So in
 * practice, on any kit whose model output omitted `meta.json` — the common
 * case, not an edge case — the OLD code (which read `meta.json` only, never
 * the marker) silently rendered every card at this generic 400×300 canvas
 * regardless of the component's real declared size. Two confirmed effects:
 *   - **Genuine thin false positives on responsive/percentage-sized content.**
 *     A card whose body uses `width: 100%` (or similar) wraps its text
 *     differently — and so measures a genuinely different `contentHeight` —
 *     depending on which viewport it's rendered at. A 240×120-declared card
 *     measured 120px tall at its OWN size but only 72px (under the 80px
 *     `DEFAULT_MIN_HEIGHT`) forced into the old hardcoded 400×300 canvas —
 *     a real, viewport-CAUSED thin misclassification, confirmed on real
 *     Chromium renders.
 *   - **AC5 pHash dilution.** The screenshot fed to `computePHash` is the
 *     WHOLE canvas, so an oversized, mostly-blank canvas shrinks a small
 *     component's contribution to the block-grid signal. A legitimately-
 *     distinct outline-vs-filled button variant hashed only 4 bits apart (AT
 *     `DEFAULT_TOLERANCE_BITS`, not above it — a false "identical" pairing)
 *     at 400×300, vs. 12 bits apart when rendered at the marker's own
 *     declared 320×96.
 *   (NOT claimed: that this fix changes the thin verdict for every small,
 *   FIXED-size element, e.g. a single-line button with hardcoded padding —
 *   that box measures the same height regardless of the surrounding canvas,
 *   confirmed on real renders. Whether `DEFAULT_MIN_HEIGHT` itself is well
 *   calibrated for small-but-legitimate fixed-size components is a SEPARATE,
 *   still-open question a DRO-711 follow-up issue tracks — this fix only
 *   corrects which viewport reaches the renderer, not the 80px threshold.)
 *
 * The fix: `extractViewport` (already shipped, already used by `refine.ts`'s
 * `deriveRenderViewport` and `manifest/compiler.ts`) reads the marker line's
 * OWN `viewport="WxH"` token — present on every well-formed `@genie` card,
 * because the system prompt asks the model for one and `manifestEntry`
 * echoes it independently of `meta.json`. That becomes the primary viewport
 * source; a `meta.json` `viewport` (when the model DID emit one) still wins
 * as an explicit override (mirrors `compileManifest`'s own precedent: the
 * marker token is authoritative, `meta.json` only supplements); this
 * `DEFAULT_VIEWPORT` is now the last resort for the rare marker with no
 * viewport attribute at all. */
const DEFAULT_VIEWPORT = { width: 400, height: 300 };

/** The `renderCheck.minHeight` / `viewport` fields `full-scan.ts` resolves per
 * component (RFC §7.3 / PRD FR-051, plus the marker-viewport precedence the
 * DRO-711 doc comment above explains). Every field is optional and
 * independently defaulted — a malformed or partial `meta.json`, or a marker
 * with no `viewport` attribute, degrades to the next fallback rather than
 * failing the scan. */
interface ParsedComponentMeta {
  minHeight: number;
  viewport: { width: number; height: number };
}

/**
 * Resolve a component's `{ minHeight, viewport }` for the render pass.
 *
 * Precedence (DRO-711 fix — see {@link DEFAULT_VIEWPORT}'s doc for the real-
 * render QA evidence behind this order):
 *   1. `meta.json`'s `viewport` / `renderCheck.minHeight`, when present and
 *      well-formed — an explicit per-component override always wins.
 *   2. The `@genie` marker's own `viewport="WxH"` token (`markerFirstLine`,
 *      via `extractViewport`) — present on every well-formed card in
 *      practice (the system prompt asks the model for one), so this is the
 *      REALISTIC default, not the generic fallback. Used for viewport only;
 *      the marker convention has no `minHeight` attribute, so `minHeight`
 *      still falls through to step 3 unless `meta.json` set it.
 *   3. `DEFAULT_VIEWPORT` / `DEFAULT_MIN_HEIGHT` — the last-resort constants,
 *      now reached only when NEITHER a marker viewport NOR a meta.json
 *      viewport is available (a marker with no `viewport` attribute at all).
 *
 * Each field defaults INDEPENDENTLY at every step — a broken `minHeight`
 * doesn't discard a good `viewport` and vice-versa.
 */
function parseComponentMeta(raw: string | undefined, markerFirstLine: string): ParsedComponentMeta {
  const markerViewport = extractViewport(markerFirstLine);
  const result: ParsedComponentMeta = {
    minHeight: DEFAULT_MIN_HEIGHT,
    viewport: markerViewport ? { ...markerViewport } : { ...DEFAULT_VIEWPORT },
  };
  if (raw === undefined) return result;
  try {
    const parsed = JSON.parse(raw) as {
      renderCheck?: { minHeight?: unknown };
      viewport?: { width?: unknown; height?: unknown };
    };
    const minHeight = parsed.renderCheck?.minHeight;
    if (typeof minHeight === "number" && Number.isFinite(minHeight) && minHeight >= 0) {
      result.minHeight = minHeight;
    }
    const w = parsed.viewport?.width;
    const h = parsed.viewport?.height;
    if (
      typeof w === "number" &&
      typeof h === "number" &&
      Number.isFinite(w) &&
      Number.isFinite(h) &&
      w > 0 &&
      h > 0
    ) {
      result.viewport = { width: w, height: h };
    }
  } catch {
    // Malformed meta.json — keep whatever step 1/2 already resolved.
  }
  return result;
}

/** Derive a `.html` file's sibling `meta.json` kit-relative path — same
 * directory, fixed basename (the `components/<group>/<Name>/meta.json`
 * convention every M3-adjacent module assumes, e.g. `manifest/compiler.ts`'s
 * sibling-read). A root-level `.html` (no `/`) maps to a root `meta.json`. */
function siblingMetaPath(htmlPath: string): string {
  const lastSlash = htmlPath.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : htmlPath.slice(0, lastSlash + 1);
  return `${dir}meta.json`;
}

/** Read `path` from the kit, tolerating absence (or any other read failure) as
 * `undefined` — every caller here treats the file as optional/best-effort. */
async function readOptional(
  store: FullScanKitStore,
  kitId: string,
  path: string,
): Promise<string | undefined> {
  try {
    const file = await store.readFile(kitId, path);
    return file.content;
  } catch {
    return undefined;
  }
}

/** Simple bounded-concurrency map — renders are I/O + CPU bound in a real
 * browser process, so unbounded `Promise.all` over a large kit would spin up
 * far more concurrent pages than helps; a small worker pool keeps AC7's < 5 s
 * / 50-component budget without serializing every render either. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Render concurrency for the thin/pHash pass (see {@link mapWithConcurrency}'s doc). */
const RENDER_CONCURRENCY = 6;

/** Stable lexicographic sort (ASCII) for deterministic finding arrays. */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Run genie's full validator suite (AC3–AC6) against every readable `.html`
 * file in `input.kitId`.
 *
 * Two passes:
 *   1. **Read + marker (AC3).** List the kit, keep `.html` paths (sorted), read
 *      each. A path that `listFiles` advertised but `readFile` can't return
 *      (a race with a concurrent delete, a permission error) is SKIPPED
 *      entirely — not counted toward `total`, not reported as `markerMissing`
 *      (asserting a registration-contract violation on bytes you can't read
 *      would be a false positive). Every successfully-read file counts toward
 *      `total`; those whose first line fails the `@genie` regex land in
 *      `markerMissing`.
 *   2. **Render → thin + variants (AC4/AC5).** When a renderer is present,
 *      render EVERY readable file (including marker-missing ones — a card can be
 *      both unregistered AND thin, and each finding is reported independently),
 *      measure content height against the per-component `minHeight`, and
 *      perceptual-hash the screenshot for cross-file duplicate clustering. A
 *      single file that fails to render is tolerated (skipped from thin/variants)
 *      rather than aborting the whole scan.
 *
 * `bad` is the literal `markerMissing.length + thin.length +
 * variantsIdentical.length` the spec defines — the arrays MAY overlap (a
 * marker-missing thin card counts in both), matching the M1-12 counter facet's
 * `bad` field this shares a persistence path with.
 */
export async function fullScan(deps: FullScanDeps, input: FullScanInput): Promise<FullScanResult> {
  const { kitStore, renderer } = deps;
  const { kitId } = input;

  // ── Pass 1: enumerate + read + marker check (AC3) ───────────────────────────
  const entries = await kitStore.listFiles(kitId);
  const htmlPaths = entries
    .map((e) => e.path)
    .filter((p) => p.endsWith(".html"))
    .sort(byPath);

  const markerMissing: string[] = [];
  /** Successfully-read previews carried into the render pass. */
  const readable: Array<{ path: string; content: string }> = [];
  for (const path of htmlPaths) {
    const content = await readOptional(kitStore, kitId, path);
    if (content === undefined) continue; // unreadable → not inspected, not counted
    readable.push({ path, content });
    if (!validateMarker(path, content).ok) markerMissing.push(path);
  }
  // htmlPaths was sorted, so markerMissing is already ascending — keep the sort
  // explicit so the guarantee survives any future reordering of pass 1.
  markerMissing.sort(byPath);
  const total = readable.length;

  // ── Pass 2: render → thin (AC4) + variantsIdentical (AC5) ───────────────────
  const thin: string[] = [];
  let variantsIdentical: string[] = [];

  if (renderer) {
    const rendered = await mapWithConcurrency(
      readable,
      RENDER_CONCURRENCY,
      async ({ path, content }) => {
        const metaRaw = await readOptional(kitStore, kitId, siblingMetaPath(path));
        // DRO-711 fix: pass the preview's own first line so parseComponentMeta
        // can prefer its marker `viewport="WxH"` token over the generic
        // DEFAULT_VIEWPORT when meta.json is absent/silent on viewport (see
        // parseComponentMeta's doc for why this is the common case, not an
        // edge case). `content.split("\n", 1)[0]` mirrors validateMarker's own
        // first-line extraction above.
        const firstLine = content.split("\n", 1)[0] ?? "";
        const meta = parseComponentMeta(metaRaw, firstLine);
        try {
          const card = await renderer.render(content, meta.viewport);
          return { path, minHeight: meta.minHeight, card };
        } catch {
          // A single file that fails to render (malformed markup crashing the
          // page, a screenshot timeout) must not abort the scan — drop its
          // AC4/AC5 contribution. It still got its AC3 marker check + total above.
          return null;
        }
      },
    );

    for (const r of rendered) {
      if (r && r.card.contentHeight < r.minHeight) thin.push(r.path);
    }
    thin.sort(byPath);

    const hashedEntries: HashedEntry[] = [];
    for (const r of rendered) {
      if (r) hashedEntries.push({ path: r.path, hash: computePHash(r.card.image) });
    }
    variantsIdentical = findDuplicateClusters(hashedEntries, deps.toleranceBits);
  }

  const bad = markerMissing.length + thin.length + variantsIdentical.length;

  return { markerMissing, thin, variantsIdentical, total, bad };
}
