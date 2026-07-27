import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { commentTexts } from "./source-text.js";
import { trackedFiles } from "./tracked-files.js";

import {
  assertRangePatchesCve202527210,
  findOpenEndedNodeFloors,
  CVE_2025_27210_SUPPORTED,
  CVE_2025_27210_VULNERABLE,
  isVulnerableVersion,
  nodeFloorOverclaim,
  renderNodeRequirement,
  satisfiesRange,
  statesNodeRequirement,
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
    // Attribution used to be per LINE, so any prerequisite line naming Node handed
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

/**
 * The documentation sweep discovers which docs it has to check by asking each
 * one whether it states a Node requirement at all. Deciding that with
 * `findOpenEndedNodeFloors` made discovery depend on the shape of the claim: a
 * doc that states its requirement as `Requires Node 23.x`, or as a bounded
 * `Node >=23 <24`, produced no floor, dropped out of the discovered set, and was
 * therefore never compared against the manifest. The drift the sweep exists to
 * catch was exactly the drift that made a document invisible to it.
 */
describe("statesNodeRequirement — discovery independent of the claim's shape", () => {
  it("🔒 discovers a requirement whose shape yields no open-ended floor", () => {
    for (const prose of [
      "Requires Node 23.x",
      "Node >=23 <24 is required",
      "Requires Node.js 23.5.0",
      "- Node.js 20.1.0–20.x",
    ]) {
      expect(findOpenEndedNodeFloors(prose), `${prose} must yield no floor`).toEqual([]);
      expect(statesNodeRequirement(prose), `${prose} must still be discovered`).toBe(true);
    }
  });

  it("🔒 still discovers every shape the floor-based predicate did", () => {
    for (const prose of [
      "Requires Node.js 22.19.0–22.x, or 24.4.1 or newer",
      "Node.js 22.19.0 or newer is required",
      "node-22.19%E2%80%9322.x%20or%20%E2%89%A524.4.1",
    ]) {
      expect(statesNodeRequirement(prose), `${prose} must be discovered`).toBe(true);
    }
  });

  it("🔒 does not read an incidental Node mention as a requirement", () => {
    for (const prose of [
      "Run `node docs/designs/design-6/contrast-check.mjs` from the repo root.",
      "a Node test that recomputes sha256 over the notice at line 256",
      "| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |",
      "builds a `node: [22, 24]` matrix of bare majors",
    ]) {
      expect(statesNodeRequirement(prose), `${prose} is not a requirement`).toBe(false);
    }
  });

  it("🔒 does not attribute a co-listed tool's requirement to Node", () => {
    expect(statesNodeRequirement("Install Node 22 (pnpm >=10.34.4 is required)")).toBe(false);
  });

  // A bare major is the most ordinary way to write a floor, and it was the one
  // shape discovery could not see: the `required` branch insisted on a dot, so
  // "Node 23 is required" was never compared with the manifest. The wording most
  // likely to be wrong stayed invisible — the same failure this predicate
  // replaced `findOpenEndedNodeFloors` to fix, one shape further down.
  it("🔒 discovers a requirement written as a bare major", () => {
    for (const prose of [
      "Node 23 is required",
      "Requires Node 24",
      "Node.js 23 or newer is required",
      "genie requires Node 22",
    ]) {
      expect(statesNodeRequirement(prose), `${prose} must be discovered`).toBe(true);
    }
  });

  // The dot in the old `required` branch was load-bearing by ACCIDENT: it was
  // the only reason a co-listed tool's "is required" did not promote Node's
  // bare major. Admitting bare majors therefore has to re-earn that exclusion
  // deliberately, by attributing the requirement verb to the Node CLAUSE rather
  // than anywhere on the line.
  it("🔒 a bare major needs the requirement verb in its OWN clause", () => {
    for (const prose of [
      "Install Node 22 (pnpm >=10.34.4 is required)",
      "Install Node 22 (a lockfile is required)",
      "builds a `node: [22, 24]` matrix (a matrix is required)",
      // A major is one or two digits. Admitting "a digit" would let an offset,
      // a line number or a hash width stand in for a version the moment the
      // clause happened to say "required".
      "Node is required to run the sha256 check at line 256",
    ]) {
      expect(statesNodeRequirement(prose), `${prose} is not a Node requirement`).toBe(false);
    }
  });
});

/**
 * A parenthetical is an ASIDE, and the subject only changes for its duration.
 *
 * Clause splitting treats `(` and `)` as boundaries, which is right — the aside
 * is its own clause and a floor inside it belongs to whatever the aside names.
 * But the subject was carried straight through the closing paren, so the aside
 * decided the subject of everything after it. `Node.js (LTS) 22.19.0 or newer`
 * therefore stated nothing: `LTS` names no tool and is not a continuation word,
 * so it reset the subject, and the version clause that followed it had an empty
 * prefix and could not set the subject back.
 *
 * That silently removed an ordinary prerequisite spelling from a sweep that runs
 * over every markdown file in the repository — the failure mode this predicate
 * was written to end, in a new disguise.
 *
 * The rule cuts both ways, so both directions are pinned here: the subject in
 * force before an aside survives it, and a subject introduced INSIDE an aside
 * does not outlive it.
 */
describe("eachNodeClause — a parenthetical does not change the subject after it", () => {
  it("🔒 reads a floor stated across a parenthetical qualifier", () => {
    for (const prose of [
      "Node.js (LTS) 22.19.0 or newer",
      "Node.js (LTS): 22.19.0 or newer",
      "Node.js (see the release schedule) 22.19.0 or newer",
    ]) {
      expect(statesNodeRequirement(prose), `${prose} must be discovered`).toBe(true);
      expect(findOpenEndedNodeFloors(prose), `${prose} states a floor`).toEqual(["22.19.0"]);
    }
  });

  it("🔒 a subject named only inside the aside does not outlive it", () => {
    // The floor after the aside belongs to pnpm, the line's subject, not to the
    // Node mentioned parenthetically. Without restoring the subject on the
    // closing paren the aside would hand pnpm's floor to Node.
    const prose = "pnpm 10.34.4 (Node 22 is required), or 10.35.0 or newer";
    expect(findOpenEndedNodeFloors(prose), `${prose} states no Node floor`).toEqual([]);
  });

  it("🔒 still refuses a foreign floor stated inside the aside", () => {
    // The pre-existing exclusions this must not trade away: the aside names
    // pnpm, so neither its floor nor its requirement verb is Node's.
    expect(statesNodeRequirement("Install Node 22 (pnpm >=10.34.4 is required)")).toBe(false);
    expect(findOpenEndedNodeFloors("Install Node 22 (pnpm >=10.34.4)")).toEqual([]);
  });
});

describe("statesNodeRequirement — soft-wrapped claims", () => {
  // Markdown hard-wraps prose. `docs/user/installation.md` already wraps its
  // prerequisite across two physical lines; the subject and the version only
  // share a line by luck, and one inserted word would separate them. Reading
  // PHYSICAL lines makes the detector silently blind to that doc — and the old
  // floor sweep is blind to it too, so nothing else would notice.
  it("🔒 discovers a requirement whose subject and version are on different lines", () => {
    for (const doc of [
      "Requires Node\n22.19.0 or newer",
      "This project requires Node\n>=22.19.0 to build",
      "- Node.js\n  22.19.0 or newer is required",
      "genie requires a recent Node\nruntime: 22.19.0 or newer.",
    ]) {
      expect(statesNodeRequirement(doc), doc).toBe(true);
    }
  });

  it("🔒 reads a wrapped floor as a floor, so the over-claim sweep still sees it", () => {
    expect(findOpenEndedNodeFloors("Requires Node\n>=22.19.0")).toEqual(["22.19.0"]);
  });

  // The join must not run across BLOCK boundaries. Consecutive table rows and
  // consecutive list items are separate claims, and welding them together
  // would attribute one row's version to another row's subject — exactly the
  // cross-subject leak the per-clause attribution exists to prevent.
  it("🔒 does not weld one block's subject onto the next block's version", () => {
    for (const doc of [
      "| `actions/setup-node` | pinned |\n| `actions/checkout` | 4.4.0 |",
      "- Uses actions/setup-node\n- Bundler 4.4.0 is required",
      "# Node\n\n256 columns wide",
    ]) {
      expect(statesNodeRequirement(doc), doc).toBe(false);
    }
  });

  // Lazy continuation has TWO sides, and only one was being checked. A line is
  // joined onto its predecessor when the predecessor left a paragraph OPEN —
  // asking only "does the CURRENT line open a block?" makes every closed leaf
  // block absorb the line that follows it, with no blank line required. A
  // heading, a table row and a closing fence all close; the test above passes
  // only because its fixtures happen to put a blank line or a second block
  // marker after the boundary.
  it("🔒 does not continue a paragraph out of a closed block", () => {
    // Each pair is the same claim split across a block boundary and then welded
    // by hand. The split form must NOT read as a requirement; the welded form
    // MUST — a fixture that is false either way would pass against a helper that
    // recognises nothing at all, so both directions are asserted.
    const pairs: Array<{ split: string; welded: string }> = [
      // A heading is a leaf block: the prose under it is a NEW paragraph, and
      // welding them attributes the heading's subject to the prose's version.
      {
        split: "# Node 23\nThis migration is required.",
        welded: "# Node 23 This migration is required.",
      },
      {
        split: "## Node\nVersion 23 of the bundler is required.",
        welded: "## Node Version 23 of the bundler is required.",
      },
      // A table row closes too, so the paragraph after a table is not part of
      // the last row.
      {
        split: "| Node | pinned |\nVersion 23 is required for the bundler.",
        welded: "| Node | pinned | Version 23 is required for the bundler.",
      },
    ];

    expect(pairs.filter(({ split }) => statesNodeRequirement(split))).toEqual([]);
    expect(pairs.filter(({ welded }) => !statesNodeRequirement(welded))).toEqual([]);
  });

  // `CLOSES_PARAGRAPH` lists fence delimiters alongside headings and table rows,
  // and that limb is correct but has NO fixture here on purpose. Welding can only
  // fabricate a claim when the line absorbed INTO carries the subject, and a bare
  // ``` carries none — so every fence document this module can see reads the same
  // whether the weld happens or not. The one arrangement that would expose it, a
  // closing fence bearing an info string, is not a closing fence under CommonMark
  // at all, so a fixture built on it would lock in a deviation rather than a rule.

  it("🔒 still joins a genuinely open paragraph", () => {
    // The counterweight: closing a paragraph at every block boundary must not
    // stop the wrapped-prose case this helper exists for.
    for (const doc of [
      "Requires Node\n22.19.0 or newer",
      "# Prerequisites\n\nRequires Node\n22.19.0 or newer",
      "| Node | pinned |\n\nThis project requires Node\n>=22.19.0 to build",
    ]) {
      expect(statesNodeRequirement(doc), doc).toBe(true);
    }
  });
});

/**
 * Two fixes in this review widened a behaviour and left their own prose behind.
 * `statesNodeRequirement` replaced shape-based discovery, and `logicalLines`
 * replaced physical-line attribution — yet the docblocks wrapping both went on
 * describing the superseded contract, so a reader re-deriving the rule from the
 * comment would rebuild the narrower version the fix had just removed.
 *
 * That is the same failure as the eight kitId gates this PR unifies: a contract
 * restated in several places, corrected in one. The answer used elsewhere in
 * this review is to ask the TREE rather than a hand-listed pair of sites, so
 * these scan every comment under `packages/server/test/` for the two abandoned
 * vocabularies. A comment that NEGATES the old wording, or that marks itself as
 * a historical record with `used to`, is a record rather than a claim.
 */
describe("node-cve prose — the contract its comments teach", () => {
  const testRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  /** Every comment under the test tree, `*`/`//` markers and wrapping removed. */
  const comments = (): { rel: string; text: string }[] => {
    const files = trackedFiles(testRoot)
      .filter((relative) => relative.endsWith(".ts"))
      .map((relative) => path.join(testRoot, relative));

    const found: { rel: string; text: string }[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      // Read through the shared helper. Extracting with an unanchored
      // `/\*[\s\S]*?\*\/` treated the glob in `server-store-injection.test.ts`'s
      // `writes: ["**\/*"]` as a comment opener and handed 1814 characters of
      // live test code to `asserted()` below, as prose this package "teaches".
      for (const text of commentTexts(source)) {
        found.push({ rel: path.relative(testRoot, file), text });
      }
    }
    return found;
  };

  /** A negation immediately before the phrase makes the sentence a correction. */
  const asserted = (text: string, phrase: RegExp): boolean => {
    if (/\bused to\b/iu.test(text)) return false;
    // A `g` regex carries `lastIndex` across calls, so the scanner is rebuilt
    // here and every predicate below stays stateless. Written the other way
    // this file passed one lock vacuously while the drift it names was live.
    for (const hit of text.matchAll(new RegExp(phrase.source, "giu"))) {
      const before = text.slice(Math.max(0, (hit.index ?? 0) - 40), hit.index ?? 0);
      if (!/\b(?:not|no|never|rather than|instead of|no longer)\b/iu.test(before)) return true;
    }
    return false;
  };

  it("🔒 no comment still attributes a Node floor to a physical line", () => {
    const GRANULARITY = /\b(?:on the same line|per line|the whole line|each line)\b/iu;
    const SWEEP = /\b(?:node|clause|floor|requirement|attribution)\b/iu;

    const considered: string[] = [];
    const stale: string[] = [];
    for (const { rel, text } of comments()) {
      if (!SWEEP.test(text)) continue;
      // `logical line` is the corrected vocabulary, so it must not read as the
      // abandoned one.
      const probe = text.replace(/logical lines?/giu, "logical-unit");
      if (!GRANULARITY.test(probe)) continue;
      considered.push(rel);
      if (asserted(probe, GRANULARITY)) stale.push(rel);
    }

    // Guards against passing because the vocabulary vanished from the tree
    // altogether, which would make the assertion below true of nothing.
    expect(considered.length).toBeGreaterThan(0);
    expect(stale).toEqual([]);
  });

  it("🔒 no comment still scopes documentation discovery to an open-ended floor", () => {
    const SHAPE = /\bopen-ended\b/iu;
    const SCOPE = /\b(?:is|are) in scope\b|\bcoverage is\b/iu;

    const considered: string[] = [];
    const stale: string[] = [];
    for (const { rel, text } of comments()) {
      if (!SHAPE.test(text)) continue;
      considered.push(rel);
      if (SCOPE.test(text) && asserted(text, SHAPE)) stale.push(rel);
    }

    expect(considered.length).toBeGreaterThan(0);
    expect(stale).toEqual([]);
  });
});

describe("node-cve — a badge's percent-encoding is case-insensitive", () => {
  /**
   * RFC 3986 §6.2.2.1: the hexadecimal digits in a percent-encoded triplet are
   * case-INSENSITIVE, and `%E2%89%A5` and `%e2%89%a5` are the same character.
   * The README's floor is stated twice — once in prose and once inside a
   * shields.io badge URL — and the badge spelling is the one no reader proofs,
   * because it renders as `≥` either way.
   *
   * Which makes the encoding a silent escape hatch rather than an edge case.
   * Every generator picks a case: `encodeURIComponent` emits upper, shields.io's
   * own docs mix them, and a hand-typed URL is whatever the hand typed. So the
   * lowercase spelling is not hypothetical — it is one paste away, and it takes
   * the badge out of the sweep's sight without changing a single rendered pixel.
   * The failure is therefore invisible in review AND invisible on the page,
   * which is the exact shape of miss these locks exist to prevent.
   */
  it("🔒 reads a lowercase percent-encoded floor as a floor", () => {
    expect(findOpenEndedNodeFloors("Node %e2%89%a5 22.19.0")).toEqual(["22.19.0"]);
    expect(findOpenEndedNodeFloors("Node %E2%89%A5 22.19.0")).toEqual(["22.19.0"]);
  });

  it("🔒 discovers a requirement stated in either case", () => {
    // Both spellings of both encodings the comparator knows: `≥` and `>=`.
    expect(statesNodeRequirement("Node %e2%89%a5 22.19.0")).toBe(true);
    expect(statesNodeRequirement("Node %3e%3d 22.19.0")).toBe(true);
    expect(statesNodeRequirement("Node %3E%3D 22.19.0")).toBe(true);
  });

  /**
   * A SEPARATE finding, surfaced while writing the case tests above and kept
   * because it lives in the same two functions: the space between comparator
   * and version is percent-encoded too in a badge URL, and `%20` is not `\s`.
   *
   * It is not a case bug — the uppercase spelling failed identically before
   * this change — so it is recorded on its own rather than folded into the
   * case argument. What makes it worth fixing here is that the two functions
   * disagreed about it in the direction their own docblock names as the
   * hazard: `statesNodeRequirement` DISCOVERS the document, and
   * `findOpenEndedNodeFloors` then reads no floor from it, so the badge is
   * swept as though it claimed nothing. Both halves are asserted below so a
   * future edit cannot re-open the gap on one side only.
   */
  it("🔒 reads a badge's percent-encoded space as a space, on both sides", () => {
    // The canonical shields.io rendering, which is where this shape comes from.
    const badge = "node-%E2%89%A5%2022.19.0-brightgreen";
    expect(statesNodeRequirement(badge)).toBe(true);
    expect(findOpenEndedNodeFloors(badge)).toEqual(["22.19.0"]);
    // …and it composes with the case-insensitivity this describe is about.
    expect(statesNodeRequirement("Node %e2%89%a5%2022.19.0")).toBe(true);
    expect(findOpenEndedNodeFloors("Node %e2%89%a5%2022.19.0")).toEqual(["22.19.0"]);
    // Containment: `%20` is read as the separator it encodes, not as a digit
    // source. A bounded clause stays bounded — in either spelling of the bound
    // — so this cannot invent a floor the document never promised.
    expect(findOpenEndedNodeFloors("Node %E2%89%A5%2022.19.0%20<23")).toEqual([]);
    expect(findOpenEndedNodeFloors("Node %E2%89%A5%2022.19.0%20%3C23")).toEqual([]);
    expect(findOpenEndedNodeFloors("Node >=22.19.0 <23")).toEqual([]);
  });

  /**
   * The `>=` half of the very split the test above locks for `≥`.
   *
   * `statesNodeRequirement` has read `%3E%3D` since it was written — the test
   * two above this one asserts it in both cases — but `findOpenEndedNodeFloors`
   * never learned the spelling. So `Node-%3E%3D22.19.0` is DISCOVERED as a
   * requirement and then yields no floor, and the over-claim sweep passes over a
   * document that re-promises the whole of 23.x: exactly the hole
   * `engines.node` carries CVE-2025-27210 to exclude. `nodeFloorOverclaim` is
   * asserted below on the extracted floor so this is a claim about the SWEEP,
   * not about a regex — without the floor there is nothing for it to judge.
   *
   * `encodeURIComponent(">=")` is `%3E%3D`, so this is not a hand-typed
   * curiosity; it is what every generator emits for the most ordinary spelling
   * of a floor. And that is what made it invisible: the encoded form of the
   * RARER glyph (`≥`) was covered while the encoded form of the COMMON one was
   * not, so the gap sat behind a line that already looked encoding-aware.
   */
  it("🔒 reads a percent-encoded `>=` floor as a floor, on both sides", () => {
    // Both halves, in both cases, per the convention the `%20` test sets: a
    // future edit must not be able to re-open the gap on one side only.
    for (const text of ["Node %3E%3D 22.19.0", "Node %3e%3d 22.19.0"]) {
      expect(statesNodeRequirement(text)).toBe(true);
      expect(findOpenEndedNodeFloors(text)).toEqual(["22.19.0"]);
    }

    // The canonical shields.io rendering — no space, and the encoded space.
    expect(findOpenEndedNodeFloors("node-%3E%3D22.19.0-brightgreen")).toEqual(["22.19.0"]);
    expect(findOpenEndedNodeFloors("node-%3E%3D%2022.19.0-brightgreen")).toEqual(["22.19.0"]);

    // The consequence, end to end: once the floor is visible the sweep refuses
    // it. This is the assertion that would still fail if someone "fixed" the
    // extractor by teaching it a spelling it then reported as harmless.
    expect(nodeFloorOverclaim("22.19.0", ">=22.19.0 <23 || >=24.4.1")).toBe("23.0.0");

    // Containment: widening the comparator must not invent a floor from a
    // clause that carries an upper bound, in either spelling of the bound.
    expect(findOpenEndedNodeFloors("Node %3E%3D22.19.0 <23")).toEqual([]);
    expect(findOpenEndedNodeFloors("Node %3E%3D22.19.0%20%3C23")).toEqual([]);
    // …and `%3C%3D` (`<=`) is not mistaken for the floor comparator it rhymes
    // with: it differs in one hex digit, and only the bound half may claim it.
    expect(findOpenEndedNodeFloors("Node %3E%3D22.19.0%20%3C%3D22.20.0")).toEqual([]);
  });

  it("🔒 reads `or newer` as an extension however it is capitalised", () => {
    // Sentence case is the ordinary spelling at the start of a line or in a
    // heading, so this is the prose half of the same miss. `statesNodeRequirement`
    // already reads it — its `SPANNED` pattern carries `i` — which is what makes
    // the floor sweep's silence here a genuine INCONSISTENCY rather than a
    // uniform policy: the same document is discovered, then swept as if it
    // claimed nothing.
    expect(statesNodeRequirement("Node 22.19.0 Or Newer")).toBe(true);
    expect(findOpenEndedNodeFloors("Node 22.19.0 Or Newer")).toEqual(["22.19.0"]);
    expect(findOpenEndedNodeFloors("Node 22.19.0 or newer")).toEqual(["22.19.0"]);
  });

  it("🔒 case-folding widens the encoding only, never the attribution", () => {
    // The containment half: `i` must not turn a co-listed tool's floor into
    // Node's, nor read an upper-bounded clause as open-ended. Both rules are
    // enforced elsewhere in this file; re-asserted against the newly admitted
    // spelling because a flag change is exactly the kind of edit that widens
    // more than its author intended.
    expect(findOpenEndedNodeFloors("pnpm %e2%89%a5 10.34.4")).toEqual([]);
    expect(findOpenEndedNodeFloors("Node %e2%89%a5 22.19.0 <23")).toEqual([]);
  });
});
