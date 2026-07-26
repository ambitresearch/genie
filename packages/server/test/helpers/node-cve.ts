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
 * but is satisfied by `24.2.0`, which is not. Checking the floor alone certifies
 * a vulnerable range as safe — so the check has to be membership-based, evaluated
 * against concrete releases on both sides of every patch point.
 *
 * Kept in one module on purpose: this PR exists because a single rule was restated
 * at eight call sites and drifted. A security predicate duplicated across two test
 * files would be the same defect, so both published manifests and the mcpb bundle
 * assert through this one function.
 */

/** The release lines that fixed CVE-2025-27210, for error messages. */
export const CVE_2025_27210_FIXED_IN = ["20.19.4", "22.17.1", "24.4.1"] as const;

/**
 * Concrete releases that are **vulnerable** to CVE-2025-27210. A published range
 * must admit none of them.
 *
 * Deliberately straddles every patch point (`20.19.3`, `22.17.0`, `24.4.0`) so an
 * off-by-one in either the range or the evaluator below is caught, and includes
 * the odd-numbered lines (21.x, 23.x) which reached end-of-life without ever
 * receiving the fix.
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
 * Assert a declared Node range excludes every release vulnerable to
 * CVE-2025-27210 while still admitting the runtimes this workspace ships on.
 *
 * Throws a message naming the offending release so a failure points straight at
 * the release line that was missed, rather than at the floor.
 */
export function assertRangePatchesCve202527210(range: string, label: string): void {
  const admitted = CVE_2025_27210_VULNERABLE.filter((v) => satisfiesRange(v, range));
  if (admitted.length > 0) {
    throw new Error(
      `${label}: engine range ${JSON.stringify(range)} still admits Node ` +
        `${admitted.join(", ")}, which predate the CVE-2025-27210 fixes ` +
        `(${CVE_2025_27210_FIXED_IN.join(" / ")}). A lower endpoint alone is not ` +
        `enough — each release line has its own patch point.`,
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
