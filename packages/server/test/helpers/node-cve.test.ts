import { describe, expect, it } from "vitest";

import {
  assertRangePatchesCve202527210,
  findOpenEndedNodeFloors,
  CVE_2025_27210_SUPPORTED,
  CVE_2025_27210_VULNERABLE,
  isVulnerableVersion,
  nodeFloorOverclaim,
  renderNodeRequirement,
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

/**
 * Round 15 (#277): the evaluator dropped empty `||` arms, so a range with a
 * stray trailing `||` was scored on its non-empty arms alone. npm does not read
 * it that way. Verified against `semver@7.8.5`, the resolver npm itself uses:
 *
 *   validRange("")                            === "*"
 *   validRange(">=22.19.0 <23 || >=24.4.1 ||") === "*"
 *   satisfies("23.11.1", <that range>)         === true
 *
 * So the typo does not weaken the range, it **erases** it — one empty arm makes
 * the whole thing a wildcard admitting every vulnerable release. A helper whose
 * only job is to certify published ranges must never score such a range as safe.
 *
 * `semver` is not a dependency of this workspace (it is only present
 * transitively), so the oracle's answers are pinned as constants here rather
 * than imported, which would be a phantom dependency.
 */
describe("satisfiesRange — empty comparator sets are wildcards", () => {
  const TRAILING_PIPE = ">=22.19.0 <23 || >=24.4.1 ||";

  it("🔒 treats an empty range as matching every version", () => {
    // `validRange("") === "*"`.
    for (const v of ["0.0.1", "18.0.0", "23.11.1", "99.99.99"]) {
      expect(satisfiesRange(v, "")).toBe(true);
      expect(satisfiesRange(v, "   ")).toBe(true);
    }
  });

  it("🔒 lets one empty arm widen the whole range to a wildcard", () => {
    // Every version the non-empty arms exclude is nonetheless admitted, because
    // the empty arm alone satisfies the `||`.
    for (const v of ["23.11.1", "24.0.0", "24.4.0", "20.0.0"]) {
      expect(satisfiesRange(v, TRAILING_PIPE)).toBe(true);
    }
    expect(satisfiesRange("22.19.0", TRAILING_PIPE)).toBe(true);
  });

  it("🔒 refuses to certify a range a stray `||` has widened", () => {
    // The security-level consequence, and the reason the two tests above are
    // not merely pedantic: without this the helper green-lights a published
    // `engines.node` that accepts every CVE-2025-27210-vulnerable release.
    expect(() => assertRangePatchesCve202527210(TRAILING_PIPE, "trailing-pipe")).toThrow(
      /still admits Node/u,
    );
    // The same range with the stray `||` removed is the one this repo actually
    // publishes, and it must still certify — so the throw above is attributable
    // to the empty arm alone, not to some unrelated defect in the comparators.
    expect(() =>
      assertRangePatchesCve202527210(">=22.19.0 <23 || >=24.4.1", "published"),
    ).not.toThrow();
  });

  it("🔒 attributes a floor to Node before reporting it", () => {
    // The function is named for Node but matched any `>=x.y` in the text, so a
    // documentation sweep built on it reported design tokens and unrelated tool
    // versions as Node prerequisites. That is why the doc check carried a
    // hand-written file list instead of scanning: the scan was unusable. The
    // list then omitted the root CONTRIBUTING.md, and the lock passed while a
    // linked public guide advertised an unsupported runtime.
    expect(findOpenEndedNodeFloors("contrast ratio >= 4.5.0 against the surface")).toEqual([]);
    expect(findOpenEndedNodeFloors("requires pnpm 10.34.4 or newer")).toEqual([]);

    // Everything genuinely attributed to Node still resolves, in all three
    // spellings the README and the guides use between them.
    expect(findOpenEndedNodeFloors("Requires Node \u2265 22.19.0 (CI tests 22/24).")).toEqual([
      "22.19.0",
    ]);
    expect(findOpenEndedNodeFloors("Node.js 22.19.0\u201322.x, or 24.4.1 or newer")).toEqual([
      "24.4.1",
    ]);
    expect(
      findOpenEndedNodeFloors("node-22.19%E2%80%9322.x%20or%20%E2%89%A524.4.1-brightgreen.svg"),
    ).toEqual(["24.4.1"]);
  });
  it("🔒 does not attribute a co-listed tool's floor to Node", () => {
    // Attribution was per LINE, so any prerequisite line naming Node handed the
    // function every version on it — including versions belonging to a tool
    // listed alongside. That is a false POSITIVE in the repository sweep: a
    // guide correctly pinning `Node 22 (pnpm >=10.34.4)` was read as claiming a
    // Node floor of 10.34.4, which the manifest range refuses, so honest prose
    // failed the lock. Worse, that line yields ONLY the foreign floor, so the
    // reported over-claim named a version the document never applied to Node.
    expect(findOpenEndedNodeFloors("Install Node 22 (pnpm >=10.34.4)")).toEqual([]);
    expect(findOpenEndedNodeFloors("Node.js 22.19.0 or newer, pnpm 10.0.0 or newer")).toEqual([
      "22.19.0",
    ]);
    expect(
      findOpenEndedNodeFloors("Requires Node >=22.19.0 <23 || >=24.4.1 and pnpm >=10.0.0"),
    ).toEqual(["24.4.1"]);

    // Attribution must still CARRY across a segment that names no tool of its
    // own, which is the shape of the canonical prose: the clause after the comma
    // is still about Node. Dropping subject inheritance would trade this false
    // positive for a false negative and silently stop policing the real claim.
    expect(findOpenEndedNodeFloors("Node.js 22.19.0\u201322.x, or 24.4.1 or newer")).toEqual([
      "24.4.1",
    ]);
  });
  it("\u{1f512} reads a bounded comparator as bounded, not as a floor", () => {
    // Documenting the manifest range verbatim must not read as an over-claim:
    // `>=22.19.0 <23` promises nothing about 23.x, so only the trailing arm is
    // an open-ended floor. Reporting the bounded one made accurate prose fail.
    expect(findOpenEndedNodeFloors("`engines.node` is `>=22.19.0 <23 || >=24.4.1`")).toEqual([
      "24.4.1",
    ]);
  });
});

// `renderNodeRequirement` is deliberately partial and throws on any clause shape
// it cannot express, because a silent wrong rendering is the failure mode this
// whole helper exists to remove. That promise was never asserted: both throw
// branches were reachable only through the happy-path manifest, so a refactor
// could have turned either into a wrong string and the suite would have stayed
// green. These pin the loud failure itself.
describe("renderNodeRequirement — the clauses it refuses to guess at", () => {
  it("🔒 refuses a bounded clause spanning more than one major line", () => {
    expect(() => renderNodeRequirement(">=22.19.0 <24")).toThrow(/spans more than one major/u);
  });

  it("🔒 refuses a clause shape it has no prose form for", () => {
    for (const range of ["^22.19.0", "22.x", ">22.19.0", "*"]) {
      expect(() => renderNodeRequirement(range), range).toThrow(/unsupported clause/u);
    }
  });
});

// `nodeFloorOverclaim` answers "does this doc promise a runtime the range
// refuses?". It only ever looked ABOVE the claimed floor, and built its own
// endpoint list from a regex that knew `>=` and `<` but not `>`, `<=` or `=`.
// Both gaps return `null` — the "no overclaim" answer — for a doc that is
// actually wrong, which is the silent-wrong-answer mode again.
describe("nodeFloorOverclaim — the overclaims it used to answer null for", () => {
  it("🔒 flags a floor the range refuses outright, not only versions above it", () => {
    // 23.0.0 is inside the CVE hole. A doc promising "23.0.0 or newer" is wrong
    // at its own floor; every endpoint ABOVE it (24.4.1) is supported.
    expect(nodeFloorOverclaim("23.0.0", ">=22.19.0 <23 || >=24.4.1")).toBe("23.0.0");
  });

  it("🔒 sees the gap opened by an inclusive upper bound", () => {
    // `<=22.20.0` refuses 22.20.1, but the old endpoint regex could not read a
    // `<=` comparator at all, so that whole clause contributed no endpoint.
    expect(nodeFloorOverclaim("22.19.0", ">=22.19.0 <=22.20.0 || >=24.4.1")).toBe("22.20.1");
  });

  it("🔒 still answers null when the floor is honest", () => {
    expect(nodeFloorOverclaim("24.4.1", ">=22.19.0 <23 || >=24.4.1")).toBeNull();
  });
});
