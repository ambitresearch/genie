import { describe, expect, it } from "vitest";

import {
  assertRangePatchesCve202527210,
  CVE_2025_27210_SUPPORTED,
  CVE_2025_27210_VULNERABLE,
  satisfiesRange,
} from "./node-cve.js";

/**
 * `satisfiesRange` decides a security assertion in two other suites, so it is
 * pinned here rather than trusted. Without this, a bug in the evaluator would
 * make every lock that depends on it pass vacuously — the same "a derived claim
 * outlived the thing it described" failure this PR is about, one layer down.
 */
describe("satisfiesRange", () => {
  it("compares numerically, not lexically", () => {
    // The bug a string compare would introduce: "9" > "10".
    expect(satisfiesRange("10.0.0", ">=9.0.0")).toBe(true);
    expect(satisfiesRange("22.9.0", ">=22.17.1")).toBe(false);
    expect(satisfiesRange("22.100.0", ">=22.17.1")).toBe(true);
  });

  it("treats a missing minor/patch as zero", () => {
    expect(satisfiesRange("23.0.0", "<23")).toBe(false);
    expect(satisfiesRange("22.99.99", "<23")).toBe(true);
    expect(satisfiesRange("22.0.0", ">=22")).toBe(true);
  });

  it("ANDs space-separated comparators and ORs across ||", () => {
    const range = ">=22.19.0 <23 || >=24.4.1";
    expect(satisfiesRange("22.19.0", range)).toBe(true);
    expect(satisfiesRange("22.18.9", range)).toBe(false); // below the floor
    expect(satisfiesRange("23.11.1", range)).toBe(false); // excluded by `<23`
    expect(satisfiesRange("24.4.0", range)).toBe(false); // below the 24.x patch
    expect(satisfiesRange("24.4.1", range)).toBe(true);
  });

  it("is exact at every boundary it is asked to police", () => {
    // Each pair straddles one CVE patch point by a single patch release.
    expect(satisfiesRange("20.19.3", ">=20.19.4")).toBe(false);
    expect(satisfiesRange("20.19.4", ">=20.19.4")).toBe(true);
    expect(satisfiesRange("22.17.0", ">=22.17.1")).toBe(false);
    expect(satisfiesRange("22.17.1", ">=22.17.1")).toBe(true);
    expect(satisfiesRange("24.4.0", ">=24.4.1")).toBe(false);
    expect(satisfiesRange("24.4.1", ">=24.4.1")).toBe(true);
  });

  it("rejects input it cannot parse instead of guessing", () => {
    expect(() => satisfiesRange("22.x", ">=22")).toThrow(/unparseable version/u);
    expect(() => satisfiesRange("22.19.0", "^22.19.0")).toThrow(/unparseable version/u);
  });
});

describe("assertRangePatchesCve202527210", () => {
  it("🔒 rejects a floor-only range that still admits a later vulnerable line", () => {
    // The exact defect this helper exists to catch: `>=22.19.0` looks patched
    // because its floor is above 22.17.1, but it is satisfied by Node 24.2.0,
    // which was not patched until 24.4.1.
    expect(() => assertRangePatchesCve202527210(">=22.19.0", "demo")).toThrow(
      /still admits Node .*24\.0\.0/u,
    );
  });

  it("🔒 rejects a range that is safe only because it admits nothing", () => {
    expect(() => assertRangePatchesCve202527210(">=999.0.0", "demo")).toThrow(
      /excludes patched Node/u,
    );
  });

  it("accepts the per-line range that covers both supported majors", () => {
    expect(() => assertRangePatchesCve202527210(">=22.19.0 <23 || >=24.4.1", "demo")).not.toThrow();
  });

  it("keeps the vulnerable and supported tables disjoint", () => {
    // A version in both tables would make every assertion unsatisfiable, so the
    // fixtures themselves are pinned.
    const overlap = CVE_2025_27210_SUPPORTED.filter((v) =>
      (CVE_2025_27210_VULNERABLE as readonly string[]).includes(v),
    );
    expect(overlap).toEqual([]);
  });
});
