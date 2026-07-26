import { describe, expect, it } from "vitest";

import {
  assertRangePatchesCve202527210,
  CVE_2025_27210_SUPPORTED,
  CVE_2025_27210_VULNERABLE,
  isVulnerableVersion,
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

  it("🔒 rejects a range that re-admits a vulnerable release the tables do not list", () => {
    // Filtering a fixed set of representative releases cannot prove that a range
    // misses the vulnerable *intervals*: this one admits exactly one vulnerable
    // release, chosen precisely because it is not one of the sampled points.
    expect(() =>
      assertRangePatchesCve202527210("=22.16.0 || >=22.19.0 <23 || >=24.4.1", "demo"),
    ).toThrow(/still admits Node .*22\.16\.0/u);
  });

  it("🔒 rejects a window carved out of a line that was never patched", () => {
    // 23.x reached end-of-life without the fix, so *any* window inside it is
    // vulnerable — not just the 23.11.1 that happens to be sampled.
    expect(() =>
      assertRangePatchesCve202527210(">=22.19.0 <23 || >=23.2.0 <23.3.0 || >=24.4.1", "demo"),
    ).toThrow(/still admits Node 23\./u);
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

/**
 * The interval model is now the decision procedure, so it is pinned directly
 * rather than only through the ranges that happen to be declared today.
 */
describe("isVulnerableVersion", () => {
  it("agrees with both fixture tables", () => {
    // Catches an interval typo that the range locks would not notice, because
    // today's declared ranges exclude whole majors outright.
    expect(CVE_2025_27210_VULNERABLE.filter((v) => !isVulnerableVersion(v))).toEqual([]);
    expect(CVE_2025_27210_SUPPORTED.filter((v) => isVulnerableVersion(v))).toEqual([]);
  });

  it("flips at each of the three patch points and nowhere else", () => {
    expect(isVulnerableVersion("20.19.3")).toBe(true);
    expect(isVulnerableVersion("20.19.4")).toBe(false);
    expect(isVulnerableVersion("22.17.0")).toBe(true);
    expect(isVulnerableVersion("22.17.1")).toBe(false);
    expect(isVulnerableVersion("24.4.0")).toBe(true);
    expect(isVulnerableVersion("24.4.1")).toBe(false);
  });

  it("treats the odd-numbered lines as vulnerable for their whole life", () => {
    // 21.x and 23.x reached end-of-life without ever receiving the fix, so there
    // is no version of either that a published range may admit.
    for (const v of ["21.0.0", "21.7.3", "23.0.0", "23.11.1"]) {
      expect(isVulnerableVersion(v)).toBe(true);
    }
    // …while the patched tail of 20.x sits in the gap between the intervals.
    expect(isVulnerableVersion("20.19.4")).toBe(false);
    expect(isVulnerableVersion("20.99.0")).toBe(false);
  });
});
