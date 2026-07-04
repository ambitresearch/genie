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
 * `DEFAULT_TOLERANCE_BITS` was calibrated empirically (real Playwright renders
 * + `bmvbhash(…, 16)`, i.e. a 256-bit hash) against two kinds of pairs:
 *   - Genuinely-identical-looking renders (byte-identical HTML, or the model
 *     literally re-emitting the same button 3 times with only the label text
 *     differing) hash to a Hamming distance of **0**.
 *   - The SMALLEST visually-real difference tried (a barely-visible 1px
 *     near-transparent border, or a subtle border-radius change alone) still
 *     produced a distance of **~17–24 bits**.
 *   - A legitimately distinct variant (a secondary/outline button style, a
 *     dark-theme swap) produced **20–80 bits**.
 * A tolerance of **4 bits (out of 256)** sits just above pure render noise
 * (antialiasing jitter, sub-pixel rounding — expected to be single-digit at
 * most) while staying far below the smallest genuinely-different pair
 * observed. This intentionally biases toward NOT flagging a real design
 * variation as a duplicate (AC5's own example — "3 buttons that all look the
 * same" — describes a gross, not a subtle, failure mode); a false negative
 * here just means a human's own eyes catch it in the rendered grid, while a
 * false positive would make `validate` cry wolf on legitimate variants.
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
 * {@link findDuplicateClusters} clusters. */
export interface HashedEntry {
  path: string;
  hash: string;
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
 * O(n²) pairwise comparisons — acceptable for AC7's ~50-component budget (at
 * most ~1225 comparisons, each a cheap XOR+popcount over a 256-bit BigInt);
 * would need a smarter index (e.g. an LSH bucket) at kit sizes multiple
 * orders of magnitude larger than genie's target.
 */
export function findDuplicateClusters(
  entries: HashedEntry[],
  toleranceBits: number = DEFAULT_TOLERANCE_BITS,
): string[] {
  const n = entries.length;
  if (n < 2) return [];

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
      if (hammingDistance(entries[i]!.hash, entries[j]!.hash) <= toleranceBits) {
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
