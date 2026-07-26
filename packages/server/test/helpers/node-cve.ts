/**
 * Shared authority for "does a declared Node range still admit a runtime that is
 * vulnerable to CVE-2025-27210?".
 *
 * CVE-2025-27210 is a Windows-only `path.join` / `path.normalize` traversal via
 * reserved device names (`CON`, `PRN`, `AUX`); it is the incomplete-fix follow-up
 * to CVE-2025-23084. It was patched in **20.19.4, 22.17.1 and 24.4.1** — three
 * separate release lines, each with its own patch point.
 *
 * That per-line structure is the whole reason this helper exists. A range's LOWER
 * ENDPOINT says nothing about the lines above it: `>=22.19.0` reads as "patched"
 * but is satisfied by `24.2.0`, which is not. Nor is it enough to filter a list of
 * sampled releases — `=22.16.0 || >=22.19.0 <23 || >=24.4.1` misses every sample
 * while admitting an unpatched 22.16.0. The check is therefore an **interval**
 * one: the vulnerable space is modelled as half-open ranges, and the declared
 * range is swept at every release where either predicate can change value.
 *
 * Kept in one module on purpose: this PR exists because a single rule was restated
 * at eight call sites and drifted. A security predicate duplicated across two test
 * files would be the same defect, so both published manifests and the mcpb bundle
 * assert through this one function.
 */

/** The release lines that fixed CVE-2025-27210, for error messages. */
export const CVE_2025_27210_FIXED_IN = ["20.19.4", "22.17.1", "24.4.1"] as const;

/**
 * Concrete releases that are **vulnerable** to CVE-2025-27210, used to pin the
 * interval model below and to make failure messages name a real release.
 *
 * Deliberately straddles every patch point (`20.19.3`, `22.17.0`, `24.4.0`) so an
 * off-by-one in either the intervals or the evaluator is caught, and includes
 * the odd-numbered lines (21.x, 23.x) which reached end-of-life without ever
 * receiving the fix.
 *
 * This is a *sample*, not the decision procedure — see `isVulnerableVersion`.
 */
export const CVE_2025_27210_VULNERABLE = [
  "18.20.8",
  "20.0.0",
  "20.19.3",
  "21.7.3",
  "22.0.0",
  "22.17.0",
  "23.11.1",
  "24.0.0",
  "24.4.0",
] as const;

/**
 * Patched releases this workspace actually runs on. Asserting these DO satisfy the
 * range keeps the security check non-vacuous: `>=999.0.0` would exclude every
 * vulnerable release while making the packages uninstallable.
 *
 * `22.19.0` is the `.nvmrc` pin; `24.4.1` is the first patched 24.x, which the CI
 * matrix reaches via a bare `node: 24`.
 */
export const CVE_2025_27210_SUPPORTED = ["22.19.0", "22.22.3", "24.4.1", "24.99.0"] as const;

type Version = [number, number, number];

function parseVersion(value: string): Version {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(value.trim());
  if (!m) throw new Error(`unparseable version: ${JSON.stringify(value)}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Minimal semver-range evaluator covering the grammar these manifests use:
 * space-separated comparators ANDed together, `||` between alternatives, e.g.
 * `>=22.19.0 <23 || >=24.4.1`. Partial versions widen downward (`<23` is
 * `<23.0.0`), which is the standard reading for a bound of that shape.
 *
 * Hand-rolled because `semver` is not a dependency of this workspace; pinned by
 * `node-cve.test.ts` so a bug here cannot silently weaken the locks that use it.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  return range
    .split("||")
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .some((clause) =>
      clause
        .split(/\s+/u)
        .filter((token) => token.length > 0)
        .every((token) => {
          const m = /^(>=|<=|>|<|=)?\s*v?(.+)$/u.exec(token);
          if (!m) throw new Error(`unparseable comparator: ${JSON.stringify(token)}`);
          const cmp = compare(v, parseVersion(m[2]));
          switch (m[1] ?? "=") {
            case ">=":
              return cmp >= 0;
            case ">":
              return cmp > 0;
            case "<=":
              return cmp <= 0;
            case "<":
              return cmp < 0;
            default:
              return cmp === 0;
          }
        }),
    );
}

/**
 * The vulnerable release space as half-open `[lo, hi)` intervals — the actual
 * decision procedure, replacing a filter over sampled points.
 *
 * Sampling can only ever prove "none of the releases I happened to list is
 * admitted"; it cannot prove "no vulnerable release is admitted". A range like
 * `=22.16.0 || >=22.19.0 <23 || >=24.4.1` slips through a sample check while
 * admitting an unpatched 22.16.0.
 *
 * The three intervals are contiguous runs of unpatched releases, so the gaps
 * between them are exactly the patched windows: `[20.19.4, 21.0.0)` and
 * `[22.17.1, 23.0.0)` and `[24.4.1, ∞)`.
 */
const VULNERABLE_INTERVALS: readonly { readonly lo: Version; readonly hi: Version | null }[] = [
  // Every line at or below 20.x, up to that line's own fix.
  { lo: [0, 0, 0], hi: [20, 19, 4] },
  // 21.x died unpatched and runs straight into 22.x's pre-fix window.
  { lo: [21, 0, 0], hi: [22, 17, 1] },
  // Likewise 23.x, running into 24.x's pre-fix window.
  { lo: [23, 0, 0], hi: [24, 4, 1] },
];

/** Whether a concrete release predates the fix on its own line. */
export function isVulnerableVersion(version: string): boolean {
  const v = parseVersion(version);
  return VULNERABLE_INTERVALS.some(
    ({ lo, hi }) => compare(v, lo) >= 0 && (hi === null || compare(v, hi) < 0),
  );
}

const format = (v: Version): string => v.join(".");

/**
 * Every release at which `satisfiesRange(_, range)` or `isVulnerableVersion` can
 * change value, plus the release immediately above each.
 *
 * Both predicates are step functions, and every step lands on a version literal
 * written in the range or on an interval endpoint above. Testing each breakpoint
 * and its immediate successor therefore visits at least one release from **every**
 * span on which both predicates are constant — which makes the check complete for
 * this comparator grammar, not merely representative.
 */
function criticalVersions(range: string): string[] {
  const breakpoints: Version[] = [[0, 0, 0]];
  for (const { lo, hi } of VULNERABLE_INTERVALS) {
    breakpoints.push(lo);
    if (hi !== null) breakpoints.push(hi);
  }
  for (const literal of range.matchAll(/\d+(?:\.\d+){0,2}/gu)) {
    breakpoints.push(parseVersion(literal[0]));
  }

  const seen = new Set<string>();
  for (const b of breakpoints) {
    seen.add(format(b));
    seen.add(format([b[0], b[1], b[2] + 1]));
  }
  return [...seen].sort((a, b) => compare(parseVersion(a), parseVersion(b)));
}

/**
 * Assert a declared Node range excludes every release vulnerable to
 * CVE-2025-27210 while still admitting the runtimes this workspace ships on.
 *
 * Throws a message naming the offending releases so a failure points straight at
 * the release line that was missed, rather than at the floor.
 */
export function assertRangePatchesCve202527210(range: string, label: string): void {
  // Sampled releases first so the message leads with a real, recognisable
  // release; the critical-point sweep is what makes the check complete.
  const admitted = [
    ...new Set(
      [...CVE_2025_27210_VULNERABLE, ...criticalVersions(range)].filter(
        (v) => isVulnerableVersion(v) && satisfiesRange(v, range),
      ),
    ),
  ];
  if (admitted.length > 0) {
    const shown = admitted.slice(0, 5).join(", ");
    throw new Error(
      `${label}: engine range ${JSON.stringify(range)} still admits Node ` +
        `${shown}${admitted.length > 5 ? ", …" : ""}, which predate the ` +
        `CVE-2025-27210 fixes (${CVE_2025_27210_FIXED_IN.join(" / ")}). Every ` +
        `release line has its own patch point, so no alternative in the range ` +
        `may reach below its line's fix.`,
    );
  }
  const missing = CVE_2025_27210_SUPPORTED.filter((v) => !satisfiesRange(v, range));
  if (missing.length > 0) {
    throw new Error(
      `${label}: engine range ${JSON.stringify(range)} excludes patched Node ` +
        `${missing.join(", ")}, which this workspace builds and tests on.`,
    );
  }
}
