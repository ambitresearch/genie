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
  computePHash,
  DEFAULT_TOLERANCE_BITS,
  findDuplicateClusters,
  hammingDistance,
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
