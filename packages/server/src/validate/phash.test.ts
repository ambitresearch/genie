/**
 * Tests for the M3-04 (DRO-260) perceptual-hash helpers
 * (`packages/server/src/validate/phash.ts`).
 *
 * Covers:
 *   - `computePHash` produces a stable, deterministic hash for the same image.
 *   - `hammingDistance` counts differing BITS (not hex characters) between two
 *     equal-length hex hash strings.
 *   - `findDuplicateClusters` (AC5) groups paths whose renders are within
 *     tolerance, including transitive (A~B~C) clusters, and leaves singletons
 *     (no near-duplicate) out of the result.
 *
 * The tolerance constant (`DEFAULT_TOLERANCE_BITS`) is calibrated against real
 * Playwright + blockhash-core measurements (recorded in phash.ts's own doc
 * comment) — this file pins the ARITHMETIC (clustering/distance), not a
 * render, so it stays offline and fast.
 */
import { describe, expect, it } from "vitest";
import {
  colorDistanceL1,
  computeColorSignature,
  computePHash,
  DEFAULT_COLOR_TOLERANCE_L1,
  DEFAULT_TOLERANCE_BITS,
  findDuplicateClusters,
  hammingDistance,
  type ColorSignature,
  type HashedEntry,
  type RGBAImage,
} from "./phash.js";

/** A two-tone image: left half one color, right half another — gives the
 * block-hash algorithm actual structure to distinguish (a flat solid color
 * hashes the same regardless of which color, since every block ties at the
 * image-wide median). */
function splitImage(
  width: number,
  height: number,
  left: [number, number, number, number],
  right: [number, number, number, number],
): RGBAImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const color = x < width / 2 ? left : right;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = color[3];
    }
  }
  return { data, width, height };
}

/** A solid image on a light "page" background with a centered saturated block —
 * a stand-in for a rendered button (fill) on a preview background. The
 * background + margin are `bg`; the centered `blockFrac` region is `fill`.
 * Mirrors what `computeColorSignature` sees: it should ignore the near-white
 * background and report ~`fill`. */
function fillOnBackground(
  width: number,
  height: number,
  fill: [number, number, number],
  bg: [number, number, number] = [246, 246, 248],
  blockFrac = 0.5,
): RGBAImage {
  const data = new Uint8Array(width * height * 4);
  const x0 = Math.floor((width * (1 - blockFrac)) / 2);
  const x1 = width - x0;
  const y0 = Math.floor((height * (1 - blockFrac)) / 2);
  const y1 = height - y0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inBlock = x >= x0 && x < x1 && y >= y0 && y < y1;
      const c = inBlock ? fill : bg;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe("computePHash", () => {
  it("is deterministic — the same image hashes identically every time", () => {
    const image = splitImage(64, 64, [200, 124, 94, 255], [32, 64, 96, 255]);
    expect(computePHash(image)).toBe(computePHash(image));
  });

  it("produces a hex string", () => {
    const image = splitImage(64, 64, [200, 124, 94, 255], [32, 64, 96, 255]);
    expect(computePHash(image)).toMatch(/^[0-9a-f]+$/);
  });

  it("hashes two structurally-identical images to the exact same value", () => {
    const a = splitImage(64, 64, [200, 124, 94, 255], [32, 64, 96, 255]);
    const b = splitImage(64, 64, [200, 124, 94, 255], [32, 64, 96, 255]);
    expect(computePHash(a)).toBe(computePHash(b));
  });

  it("hashes visually-different images to different values", () => {
    const a = splitImage(64, 64, [200, 124, 94, 255], [32, 64, 96, 255]);
    const b = splitImage(64, 64, [32, 64, 96, 255], [200, 124, 94, 255]); // colors swapped
    expect(computePHash(a)).not.toBe(computePHash(b));
  });
});

describe("hammingDistance", () => {
  it("is 0 for identical hashes", () => {
    expect(hammingDistance("ff00", "ff00")).toBe(0);
  });

  it("counts differing BITS, not differing hex characters", () => {
    // 0x0 vs 0xf differ in all 4 bits of one nibble, but that is ONE differing
    // hex character — the distance must be 4 (bits), not 1 (characters).
    expect(hammingDistance("0", "f")).toBe(4);
  });

  it("counts total bits across a multi-character hash", () => {
    // "00" vs "ff": both nibbles fully differ -> 8 bits.
    expect(hammingDistance("00", "ff")).toBe(8);
  });

  it("is symmetric", () => {
    expect(hammingDistance("a3f1", "0c9e")).toBe(hammingDistance("0c9e", "a3f1"));
  });

  it("throws on unequal-length hashes (not a meaningful comparison)", () => {
    expect(() => hammingDistance("ff", "fff")).toThrow();
  });
});

describe("findDuplicateClusters", () => {
  function entry(path: string, hash: string): HashedEntry {
    return { path, hash };
  }

  it("returns [] for a single component (nothing to compare against)", () => {
    expect(findDuplicateClusters([entry("a.html", "ffff")])).toEqual([]);
  });

  it("returns [] when every hash is far apart (no duplicates)", () => {
    const result = findDuplicateClusters(
      [entry("a.html", "0000"), entry("b.html", "ffff")],
      DEFAULT_TOLERANCE_BITS,
    );
    expect(result).toEqual([]);
  });

  it("groups two paths whose hashes are within tolerance", () => {
    // "0000" vs "0001" differ by 1 bit — within any tolerance >= 1.
    const result = findDuplicateClusters([entry("a.html", "0000"), entry("b.html", "0001")], 4);
    expect(result).toEqual(["a.html", "b.html"]);
  });

  it("excludes a path whose distance exceeds tolerance", () => {
    const result = findDuplicateClusters(
      [entry("a.html", "0000"), entry("b.html", "000f")], // 4 bits apart
      3, // tolerance stricter than the actual distance
    );
    expect(result).toEqual([]);
  });

  it("includes a path exactly AT the tolerance boundary (<=, not <)", () => {
    const result = findDuplicateClusters(
      [entry("a.html", "0000"), entry("b.html", "000f")], // exactly 4 bits apart
      4,
    );
    expect(result).toEqual(["a.html", "b.html"]);
  });

  it("groups a transitive chain (A~B~C) into one cluster even if A and C alone exceed tolerance", () => {
    // a<->b: 1 bit; b<->c: 1 bit; a<->c: 2 bits. With tolerance=1, a and c are
    // NOT directly within tolerance of each other, but both are within
    // tolerance of b — the whole chain must still cluster together.
    const result = findDuplicateClusters(
      [entry("a.html", "0000"), entry("b.html", "0001"), entry("c.html", "0003")],
      1,
    );
    expect(result.sort()).toEqual(["a.html", "b.html", "c.html"]);
  });

  it("leaves a singleton out of the array even when other pairs cluster", () => {
    const result = findDuplicateClusters(
      [entry("dup-a.html", "0000"), entry("dup-b.html", "0000"), entry("unique.html", "ffff")],
      DEFAULT_TOLERANCE_BITS,
    );
    expect(result.sort()).toEqual(["dup-a.html", "dup-b.html"]);
  });

  it("returns paths sorted for deterministic output", () => {
    const result = findDuplicateClusters(
      [entry("z.html", "0000"), entry("a.html", "0000")],
      DEFAULT_TOLERANCE_BITS,
    );
    expect(result).toEqual(["a.html", "z.html"]);
  });

  it("de-duplicates: a path in a 3+ member cluster appears exactly once", () => {
    const result = findDuplicateClusters(
      [entry("a.html", "0000"), entry("b.html", "0000"), entry("c.html", "0000")],
      DEFAULT_TOLERANCE_BITS,
    );
    expect(result).toEqual(["a.html", "b.html", "c.html"]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("handles an empty entry list", () => {
    expect(findDuplicateClusters([])).toEqual([]);
  });
});

describe("computeColorSignature (DRO-717)", () => {
  it("reports the fill color, ignoring the near-white page background", () => {
    // A blue button on a light page — the signature should be ~the blue fill,
    // NOT a blend pulled toward the background.
    const img = fillOnBackground(64, 64, [52, 81, 151]);
    const sig = computeColorSignature(img);
    expect(sig).toBeDefined();
    // Well within a few units of the true fill (only the sampled block is blue).
    expect(colorDistanceL1(sig!, { r: 52, g: 81, b: 151 })).toBeLessThan(5);
  });

  it("is stable as the fill AREA grows (label-length robustness)", () => {
    // Same fill, different coverage (a short vs. long label makes the button
    // wider). The ink signature must barely move — this is the property that
    // lets the veto keep label variants clustered while still separating hues.
    const small = computeColorSignature(fillOnBackground(64, 64, [52, 81, 151], undefined, 0.3));
    const large = computeColorSignature(fillOnBackground(64, 64, [52, 81, 151], undefined, 0.8));
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    expect(colorDistanceL1(small!, large!)).toBeLessThan(5);
  });

  it("separates the DRO-717 hue trio (clay / blue / red) that blockhash cannot", () => {
    const clay = computeColorSignature(fillOnBackground(64, 64, [200, 124, 94]))!;
    const blue = computeColorSignature(fillOnBackground(64, 64, [52, 81, 151]))!;
    const red = computeColorSignature(fillOnBackground(64, 64, [197, 55, 47]))!;
    // Every pair is far above DEFAULT_COLOR_TOLERANCE_L1 (the veto WILL fire).
    expect(colorDistanceL1(clay, blue)).toBeGreaterThan(DEFAULT_COLOR_TOLERANCE_L1);
    expect(colorDistanceL1(clay, red)).toBeGreaterThan(DEFAULT_COLOR_TOLERANCE_L1);
    expect(colorDistanceL1(blue, red)).toBeGreaterThan(DEFAULT_COLOR_TOLERANCE_L1);
  });

  it("returns undefined for a fully-blank (near-white) render — nothing to veto on", () => {
    // All background, no saturated ink → no hue signal.
    const blank = fillOnBackground(32, 32, [247, 247, 249], [247, 247, 249]);
    expect(computeColorSignature(blank)).toBeUndefined();
  });

  it("excludes white text (bright + low-chroma) from the mean, not just the background", () => {
    // A dark fill speckled with white "glyph" pixels: the white must be dropped
    // so the signature reports the dark fill, not a washed-out average.
    const img = fillOnBackground(64, 64, [40, 40, 40], [246, 246, 248], 0.6);
    // paint a few white pixels inside the block (simulating label glyphs)
    for (let k = 0; k < 40; k++) {
      const i = ((20 * 64 + 20 + k) * 4) as number;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
    const sig = computeColorSignature(img)!;
    // Still close to the dark fill, not pulled toward white.
    expect(colorDistanceL1(sig, { r: 40, g: 40, b: 40 })).toBeLessThan(15);
  });
});

describe("colorDistanceL1 (DRO-717)", () => {
  it("is 0 for identical signatures", () => {
    expect(colorDistanceL1({ r: 10, g: 20, b: 30 }, { r: 10, g: 20, b: 30 })).toBe(0);
  });

  it("sums per-channel absolute differences", () => {
    expect(colorDistanceL1({ r: 0, g: 0, b: 0 }, { r: 1, g: 2, b: 3 })).toBe(6);
  });

  it("is symmetric", () => {
    const a: ColorSignature = { r: 200, g: 124, b: 94 };
    const b: ColorSignature = { r: 52, g: 81, b: 151 };
    expect(colorDistanceL1(a, b)).toBe(colorDistanceL1(b, a));
  });
});

describe("findDuplicateClusters — hue veto (DRO-717)", () => {
  const blue: ColorSignature = { r: 52, g: 81, b: 151 };
  const red: ColorSignature = { r: 197, g: 55, b: 47 };
  const clay: ColorSignature = { r: 200, g: 124, b: 94 };

  function entry(path: string, hash: string, color?: ColorSignature): HashedEntry {
    return color ? { path, hash, color } : { path, hash };
  }

  it("does NOT cluster same-layout, different-hue cards (finding 1 fixed)", () => {
    // Identical blockhash (distance 0) but visually distinct fills — the exact
    // hue-blind false positive DRO-717 reports. The color veto must split them.
    const result = findDuplicateClusters([
      entry("primary.html", "0000", blue),
      entry("danger.html", "0000", red),
      entry("warning.html", "0000", clay),
    ]);
    expect(result).toEqual([]);
  });

  it("STILL clusters same-layout, same-hue cards (true duplicates survive the veto)", () => {
    // Same blockhash AND same fill → a genuine duplicate card. The veto abstains
    // (colors agree) and clustering proceeds exactly as before.
    const result = findDuplicateClusters([
      entry("a.html", "0000", blue),
      entry("b.html", "0000", { r: 53, g: 82, b: 150 }), // trivial render drift
    ]);
    expect(result).toEqual(["a.html", "b.html"]);
  });

  it("clusters same-hue but splits a third different-hue card in the same set", () => {
    const result = findDuplicateClusters([
      entry("blue-1.html", "0000", blue),
      entry("blue-2.html", "0000", blue),
      entry("red-1.html", "0000", red),
    ]);
    expect(result).toEqual(["blue-1.html", "blue-2.html"]);
  });

  it("abstains from the veto when either entry has no color signature (back-compat)", () => {
    // A caller that supplies no colors (e.g. the arithmetic-only tests above)
    // gets the pre-DRO-717 blockhash-only behavior: these cluster on hash alone.
    const result = findDuplicateClusters([entry("a.html", "0000"), entry("b.html", "0000")]);
    expect(result).toEqual(["a.html", "b.html"]);
  });

  it("abstains for the pair when only ONE of the two entries lacks a color", () => {
    // Mixed: one entry has a color, the other doesn't → veto abstains, hash wins.
    const result = findDuplicateClusters([
      entry("colored.html", "0000", blue),
      entry("colorless.html", "0000"),
    ]);
    expect(result).toEqual(["colored.html", "colorless.html"]);
  });

  it("respects a custom colorToleranceL1 override", () => {
    // With a huge color tolerance the veto never fires → hue-blind clustering.
    const loose = findDuplicateClusters(
      [entry("a.html", "0000", blue), entry("b.html", "0000", red)],
      DEFAULT_TOLERANCE_BITS,
      1000,
    );
    expect(loose).toEqual(["a.html", "b.html"]);
    // With a zero color tolerance even a trivially-different fill is vetoed.
    const strict = findDuplicateClusters(
      [entry("a.html", "0000", blue), entry("b.html", "0000", { r: 53, g: 81, b: 151 })],
      DEFAULT_TOLERANCE_BITS,
      0,
    );
    expect(strict).toEqual([]);
  });

  it("does not union two same-hue cards whose blockhash already exceeds tolerance", () => {
    // The veto only SUBTRACTS: agreeing colors never rescue a blockhash miss.
    const result = findDuplicateClusters([
      entry("a.html", "0000", blue),
      entry("b.html", "ffff", blue), // 16 bits apart, same color
    ]);
    expect(result).toEqual([]);
  });
});
