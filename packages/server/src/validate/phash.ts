/**
 * Perceptual-hash helpers for the M3-04 (DRO-260) `validate` full-scan facet's
 * `variantsIdentical` check (AC5) — "the model generated 3 buttons that all
 * look the same".
 *
 * Pure arithmetic, no I/O: {@link computePHash} takes decoded RGBA pixels (the
 * caller renders + decodes the PNG — see `render.ts`), and {@link
 * findDuplicateClusters} takes already-computed hashes. Kept pure/offline so
 * this module — and its test suite — never touches Playwright, a browser, or
 * the filesystem, mirroring `validate/marker.ts`'s own "pure and offline" design
 * note.
 *
 * ── Algorithm choice: blockhash, not a DCT pHash ──────────────────────────────
 * `bmvbhash` (the `blockhash-core` package, the reference implementation of
 * blockhash.io's algorithm) divides the image into an NxN grid of blocks,
 * takes each block's average brightness, and bits the result against the
 * per-quadrant median. It is simpler and faster than a DCT-based pHash and
 * needs no native build step (no `sharp`/libvips) — genie's server stays a
 * pure-JS install, matching the rest of `dependencies` in package.json. The
 * accuracy tradeoff is fine for this AC: the goal is "flag near-identical
 * card renders", not general-purpose reverse image search.
 *
 * ── Tolerance calibration ─────────────────────────────────────────────────────
 * `DEFAULT_TOLERANCE_BITS` was calibrated empirically (real Chromium renders +
 * `bmvbhash(…, 16)`, i.e. a 256-bit hash), most recently re-measured post-#154
 * WITH fonts loaded (DRO-717 — an early fontless run misleadingly showed every
 * label variant at distance 0, because a browser with no font renders every
 * button at the same zero-glyph-advance width; the numbers below are the real,
 * font-loaded measurements):
 *   - Byte-identical HTML (the model re-emitting the exact same card twice)
 *     hashes to a Hamming distance of **0**.
 *   - A legitimately distinct restyle of the same component — an outline vs.
 *     filled button, a secondary size/radius variant — produces **~11–27 bits**.
 *   - Two cards differing ONLY in their label TEXT ("Save" vs "Delete account")
 *     also produce **~8–34 bits** — because a wider label lays the whole button
 *     out at a different width, which genuinely changes the block-grid
 *     structure. (This corrects an earlier version of this comment, which
 *     claimed label-only differences hash to distance 0 / cluster together —
 *     true only in the degenerate fontless render; false under real text.)
 * Those last two ranges OVERLAP, so no single `DEFAULT_TOLERANCE_BITS` can both
 * cluster every label variant AND avoid clustering every genuine restyle. We
 * therefore keep the tolerance TIGHT (**4 bits out of 256**, just above pure
 * render noise — antialiasing jitter, sub-pixel rounding — and far below the
 * smallest genuinely-different pair), and treat `variantsIdentical` as its
 * literal name: renders that are STRUCTURALLY identical (a true duplicate card
 * — same markup, or whitespace-only differences), not merely two buttons of the
 * same shape wearing different words. This preserves the doc's own long-standing
 * bias — a false negative just means a human's eyes catch it in the rendered
 * grid, while a false positive makes `validate` cry wolf on a legitimate
 * "Save"/"Cancel" pair.
 *
 * ── Hue-aware color veto (DRO-717, fixes finding 1) ───────────────────────────
 * blockhash is a LUMINANCE-structure hash: `bmvbhash` reduces each block to a
 * single brightness value (the `R+G+B` sum), with no hue term at all. Three
 * buttons of identical layout but visually distinct fills — clay `#c87c5e`,
 * blue `#345197`, red `#c5372f` — therefore hash to Hamming distance **0**
 * (confirmed on real renders), which would falsely cluster a primary/danger/
 * success button SET as `variantsIdentical`. This is structural, not a
 * tolerance-tuning problem: no `DEFAULT_TOLERANCE_BITS` recovers hue the hash
 * never encoded.
 *
 * The fix is an ADDITIVE second signal, not a different hash: alongside each
 * card's blockhash we carry a cheap {@link computeColorSignature} — the mean
 * RGB of its "ink" pixels (saturated, non-background — see the function doc for
 * why page background and white glyph fill are excluded). Two cards are treated
 * as near-duplicates only when they are BOTH blockhash-close AND color-close
 * (L1 within {@link DEFAULT_COLOR_TOLERANCE_L1}). The color signature was
 * calibrated on the same DRO-717 real renders: label variants of one fill drift
 * at most **~4.5** (blank space and white text excluded, so a growing button
 * doesn't move it), while every genuinely-different hue pair measured — the
 * issue trio included — sits at **≥33** (the tightest real pair, teal/green,
 * was 33.5; the issue trio spanned 115–269). A threshold of **20** sits
 * centered in that gap. The veto is strictly SUBTRACTIVE — it can only DROP a
 * pairing the blockhash alone would have made, never add one — so an entry
 * carrying no color signature falls back to the exact pre-DRO-717 behavior.
 *
 * `blockhash-core` ships its own `index.d.ts` (a small, pure-JS package, no
 * native build step — genie's server stays a pure-JS install, matching the
 * rest of `dependencies` in package.json), so the named import below needs no
 * ambient shim.
 */
import { bmvbhash } from "blockhash-core";

/** Decoded RGBA pixel buffer — what a PNG decoder (`pngjs`) hands back, and
 * what {@link computePHash} (via `blockhash-core`'s `bmvbhash`) consumes. */
export interface RGBAImage {
  /** Raw pixel bytes, 4 per pixel (R,G,B,A), row-major. */
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Grid resolution `bmvbhash` divides the image into (an N×N block grid,
 * yielding an N²-bit hash). 16 → a 256-bit hash — fine-grained enough to
 * distinguish real layout differences while staying cheap to compute for a
 * batch of dozens of components (AC7's < 5 s / 50-component budget).
 */
const HASH_BITS = 16;

/**
 * Perceptual hashes within this many bits (out of 256, i.e. ~1.5%) are
 * treated as "the same rendered card" for AC5's `variantsIdentical` check.
 * See the module doc above for the empirical calibration behind this number.
 */
export const DEFAULT_TOLERANCE_BITS = 4;

/**
 * Perceptual-hash an already-decoded RGBA image via the blockhash algorithm
 * (AC5). Returns a hex string; two structurally-identical images always hash
 * identically (verified deterministic), and the hash space is the fixed
 * `HASH_BITS²` bits `bmvbhash` always emits for a given `bits` argument, so
 * every hash this module produces is directly comparable via {@link
 * hammingDistance}.
 */
export function computePHash(image: RGBAImage): string {
  return bmvbhash({ data: image.data, width: image.width, height: image.height }, HASH_BITS);
}

/**
 * A card's mean "ink" color (DRO-717) — the second signal the color veto in
 * {@link findDuplicateClusters} compares alongside the blockhash. Mean R/G/B
 * over the saturated, non-background pixels of a render (see {@link
 * computeColorSignature} for the exclusion rule). `undefined` when a render has
 * no ink pixels at all (a blank/near-empty card), in which case the veto
 * abstains and the pairing falls back to blockhash alone.
 */
export interface ColorSignature {
  r: number;
  g: number;
  b: number;
}

/**
 * L1 (Manhattan) distance below which two {@link ColorSignature}s are treated
 * as "the same fill color" for the hue-veto in {@link findDuplicateClusters}
 * (DRO-717). Calibrated on real DRO-717 renders (see the module doc's
 * "Hue-aware color veto" section): label variants of a single fill drift ≤ ~4.5,
 * every genuinely-distinct hue pair measured ≥ ~33 — a threshold of 20 sits
 * centered in that gap, ~4× above label-variant noise and comfortably below the
 * tightest real hue difference.
 */
export const DEFAULT_COLOR_TOLERANCE_L1 = 20;

/**
 * Thresholds (DRO-717) for {@link computeColorSignature}'s "is this pixel ink?"
 * test. A pixel is EXCLUDED from the mean when it is either barely-opaque
 * (`alpha < ALPHA_MIN` — antialiased edges, transparent margin) or
 * bright-and-low-chroma (`min(R,G,B) > BRIGHT_MIN` AND `max−min < CHROMA_MAX`).
 * The second clause drops both the light page background a preview renders
 * against AND the white glyph fill of the label text — the two things that,
 * left in, would (a) dominate a small button's mean and (b) shift it as the
 * label grows, which is exactly the width-sensitivity that disqualifies a
 * whole-canvas mean as a hue signal. What survives is the saturated button
 * fill, whose mean is stable across label-length changes (measured drift ≤ ~4.5)
 * yet cleanly separates distinct hues (≥ ~33).
 */
const INK_ALPHA_MIN = 128;
const INK_BRIGHT_MIN = 200;
const INK_CHROMA_MAX = 24;

/**
 * Compute a render's mean "ink" color (DRO-717) — the hue signal the color veto
 * in {@link findDuplicateClusters} pairs with the blockhash. Averages R/G/B over
 * only the saturated, non-background pixels (see {@link INK_ALPHA_MIN} et al.
 * for the exclusion rule and the module doc for why background + white text are
 * dropped rather than averaged in). Returns `undefined` when NO pixel qualifies
 * as ink (a fully blank or near-white card) — the caller then compares such a
 * card on blockhash alone, since it has no hue to veto on.
 *
 * Pure arithmetic over the same decoded RGBA buffer {@link computePHash}
 * consumes — no I/O, one linear pass, so it adds negligibly to AC7's per-render
 * budget.
 */
export function computeColorSignature(image: RGBAImage): ColorSignature | undefined {
  const d = image.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < d.length; i += 4) {
    const R = d[i]!;
    const G = d[i + 1]!;
    const B = d[i + 2]!;
    const A = d[i + 3]!;
    if (A < INK_ALPHA_MIN) continue;
    const mn = Math.min(R, G, B);
    const mx = Math.max(R, G, B);
    if (mn > INK_BRIGHT_MIN && mx - mn < INK_CHROMA_MAX) continue; // background / white text
    r += R;
    g += G;
    b += B;
    n += 1;
  }
  if (n === 0) return undefined;
  return { r: r / n, g: g / n, b: b / n };
}

/**
 * L1 (Manhattan) distance between two {@link ColorSignature}s — the metric the
 * color veto thresholds against {@link DEFAULT_COLOR_TOLERANCE_L1}. Manhattan,
 * not Euclidean, because the calibration gap is wide (≤4.5 vs ≥33) so the
 * cheaper sum-of-abs-differences is more than discriminating enough, and it
 * keeps the whole comparison integer-friendly.
 */
export function colorDistanceL1(a: ColorSignature, b: ColorSignature): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/**
 * Count differing BITS (not hex characters) between two equal-length hex hash
 * strings (AC5). Both {@link computePHash}'s output and this function operate
 * over the same fixed-width hash space, so a caller never mixes hashes from a
 * different `HASH_BITS` setting — but the length check below still guards the
 * case defensively rather than silently truncating.
 *
 * Hex, not raw bit-strings, because that's the wire/storage-friendly form
 * `computePHash` returns; comparing correctly still requires decoding to bits
 * per nibble (a naive per-CHARACTER diff would undercount — e.g. `0x0` vs
 * `0xf` differ in ALL 4 bits of that nibble but are only "1 character" apart).
 */
export function hammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== hexB.length) {
    throw new Error(
      `hammingDistance: hash length mismatch (${hexA.length} vs ${hexB.length}) — hashes must come from the same hash configuration.`,
    );
  }
  const a = BigInt(`0x${hexA}`);
  const b = BigInt(`0x${hexB}`);
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

/** One kit file's path plus its precomputed perceptual hash — the input
 * {@link findDuplicateClusters} clusters. `color` is the DRO-717 hue-veto
 * signal ({@link computeColorSignature}); OPTIONAL and backward-compatible — an
 * entry without it is compared on blockhash alone, exactly as before the veto
 * existed. Production (`full-scan.ts`) always supplies it; arithmetic-only tests
 * may omit it. */
export interface HashedEntry {
  path: string;
  hash: string;
  color?: ColorSignature;
}

/**
 * Group `entries` into near-duplicate clusters (AC5: pairs — generalized here
 * to clusters, since 3+ near-identical renders is exactly the failure mode
 * the AC's own example describes) and return the FLAT, deduplicated,
 * sorted list of every path that landed in a cluster of size >= 2. A path
 * with no near-duplicate (a singleton) is omitted entirely — `variantsIdentical`
 * is "these paths render the same as some other path", not a roster of every
 * file scanned.
 *
 * Clustering is transitive (union-find): if A is within tolerance of B, and B
 * is within tolerance of C, all three land in ONE cluster even if A and C
 * alone exceed tolerance — the natural reading of "these components all look
 * the same" when three-plus near-duplicates form a chain rather than every
 * pair being mutually within tolerance.
 *
 * ── Two-signal near-duplicate test (DRO-717) ─────────────────────────────────
 * Two entries are unioned only when they are near-duplicates on BOTH signals:
 *   1. blockhash Hamming distance <= `toleranceBits` (layout/luminance), AND
 *   2. `colorDistanceL1` <= `colorToleranceL1` (hue) — the DRO-717 veto that
 *      stops the hue-blind blockhash from clustering a primary/danger/success
 *      button set (identical layout, distinct fills) as identical.
 * The color check is a pure VETO: it can only PREVENT a union the blockhash
 * would have made, never create one. It abstains (does not veto) when EITHER
 * entry lacks a color signature — so a caller that supplies no colors (e.g. an
 * arithmetic-only test) gets the exact pre-DRO-717 blockhash-only behavior.
 *
 * Why the veto doesn't cause false NEGATIVES (dropping a real duplicate): for a
 * SAME-fill pair, the ink-color distance co-varies with the button's coverage,
 * which co-varies with the blockhash. Two same-fill cards only drift apart in
 * ink color once their rendered widths differ enough — and by then their
 * blockhash has ALREADY diverged past `toleranceBits`, so the union was never on
 * the table for the veto to remove (measured on real dark- and light-background
 * renders: a same-fill pair reaching colorL1 ≈ 39 was already ~35 blockhash bits
 * apart). The veto therefore only ever bites the case it targets — blockhash
 * says "close" while hue says "different", i.e. the hue-blind false positive.
 *
 * O(n²) pairwise comparisons — acceptable for AC7's ~50-component budget (at
 * most ~1225 comparisons, each a cheap XOR+popcount over a 256-bit BigInt plus
 * a three-term color subtraction); would need a smarter index (e.g. an LSH
 * bucket) at kit sizes multiple orders of magnitude larger than genie's target.
 */
export function findDuplicateClusters(
  entries: HashedEntry[],
  toleranceBits: number = DEFAULT_TOLERANCE_BITS,
  colorToleranceL1: number = DEFAULT_COLOR_TOLERANCE_L1,
): string[] {
  const n = entries.length;
  if (n < 2) return [];

  /**
   * The DRO-717 hue veto: `true` when the two entries' fills are close enough
   * to be "the same color". Abstains (returns `true`) when either entry has no
   * color signature, so a color-less caller keeps blockhash-only behavior.
   */
  function colorAgrees(a: HashedEntry, b: HashedEntry): boolean {
    if (!a.color || !b.color) return true;
    return colorDistanceL1(a.color, b.color) <= colorToleranceL1;
  }

  // Union-find over entry INDICES (not paths) so duplicate paths in the input
  // can never collide as map keys.
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!; // path-halving
      i = parent[i]!;
    }
    return i;
  }
  function union(i: number, j: number): void {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (hammingDistance(a.hash, b.hash) <= toleranceBits && colorAgrees(a, b)) {
        union(i, j);
      }
    }
  }

  // Group entry indices by cluster root; keep only clusters with >= 2 members.
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const members = clusters.get(root);
    if (members) members.push(i);
    else clusters.set(root, [i]);
  }

  const result: string[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    for (const idx of members) result.push(entries[idx]!.path);
  }
  return result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
