import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stripComments } from "./source-text.js";
import { trackedFiles, trackedPath } from "./tracked-files.js";

const SERVER_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** This file, relative to SERVER_ROOT — see the self-exclusion note below. */
const SELF = trackedPath(SERVER_ROOT, fileURLToPath(import.meta.url));

/**
 * Live code only: the rule below is explained in prose that must stay legal.
 *
 * Delegated rather than spelled here. The local copy anchored its block half but
 * not its line half, and the "any character but a colon" arm it used to spare
 * `https://` reads `file:///x` as a comment — the colon is spent on the scheme,
 * so the two slashes that open the "comment" are the second and third.
 */
const code = stripComments;

/** The banned shape: a hand-written skip-list standing in for "untracked". */
const usesArtefactDenylist = (source: string): boolean => code(source).includes('"node_modules"');

/**
 * The banned shape: a path built from nothing but string literals.
 *
 * The discriminator is the ARGUMENTS. `join(root, relative)` re-roots a git
 * answer onto this disk and is exactly right — `join` normalises `/` on every
 * platform, so reading is never the problem. A join whose arguments are all
 * literals builds a path out of nothing, which only ever happens in order to
 * COMPARE it, and comparison is where the spelling has to match git's.
 *
 * Requiring two or more literal segments also keeps `array.join("|")` out: a
 * separator is a single argument, a path is several.
 */
const handSpelledComparison = (source: string): boolean =>
  /(?:path\.)?join\(\s*"[^"]*"\s*(?:,\s*"[^"]*"\s*)+\)/u.test(code(source));

/**
 * The banned shape: `readdir` asked about a directory inside this repository.
 *
 * The denylist ban below catches a disk walk that HIDES artefacts behind a
 * skip-list. This catches the other half — a walk that never asked git at all.
 * A directory derived from `import.meta.url` is a directory git tracks, so
 * "what does it contain?" has two answers, differing by exactly the untracked
 * files a working tree accumulates. A contract test wants the repository's.
 *
 * Derivation is followed only through path builders, which preserves the
 * carve-out the sibling ban makes: a temp fixture is not derived from this
 * file's location, so scanning one stays legal.
 */
const scansATrackedDirectory = (source: string): boolean => {
  const text = code(source);
  const derived = new Set<string>();
  for (const [, name] of text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*fileURLToPath\(\s*import\.meta\.url\s*\)/gu,
  ))
    derived.add(name!);
  // Two passes, because a directory is usually reached one `dirname` at a time.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [, name, initialiser] of text.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:path\.)?(?:dirname|join|resolve)\([^;\n]*)/gu,
    )) {
      if ([...derived].some((seed) => new RegExp(String.raw`\b${seed}\b`, "u").test(initialiser!)))
        derived.add(name!);
    }
  }
  return [...text.matchAll(/\breaddir(?:Sync)?\s*\(\s*([A-Za-z_$][\w$]*)/gu)].some(([, argument]) =>
    derived.has(argument!),
  );
};

/**
 * A contract test asks what this repository publishes, so it has to ask git.
 *
 * Every repo-wide scan in this package once walked the disk and skipped a
 * hand-written set of build directories. That set is a denylist standing in for
 * "untracked", and it is wrong in both directions: it has to be extended for
 * each new artefact directory, and until it is, it reads whatever it has not
 * been told about. `.genie/` and `reports/` are gitignored and present in a
 * normal checkout, and `CLAUDE.md` asks every agent to keep a gitignored
 * `.claude/TASKS.md` — so a private note stating a Node version could fail the
 * public-documentation contract on one machine and pass on the next.
 *
 * The ban is deliberately on the denylist, not on `readdirSync`: a test that
 * scans a temp kit fixture is asking about a directory git has never heard of,
 * and is right to walk it.
 */
describe("repo scans — asked of git, not of the disk", () => {
  const scanned = trackedFiles(SERVER_ROOT)
    .filter((relative) => relative.endsWith(".ts"))
    .map((relative) => ({
      relative,
      source: readFileSync(path.join(SERVER_ROOT, relative), "utf-8"),
    }));

  it("🔒 no test approximates 'untracked' with a build-artefact denylist", () => {
    // Anti-vacuity: an empty scan would pass the ban without checking anything.
    expect(scanned.length).toBeGreaterThan(5);

    const offenders = scanned
      .filter(({ relative }) => relative !== SELF)
      .filter(({ relative }) => relative.endsWith(".test.ts") || relative.startsWith("test/"))
      .filter(({ source }) => usesArtefactDenylist(source))
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("🔒 the denylist detector fires on the banned shape and not on the replacement", () => {
    // Pays for the self-exclusion above. This file has to name the banned
    // literal to detect it, so it matches its own rule; skipping it silently
    // would also hide a detector that had stopped matching anything. Assert the
    // judgement directly instead, on both sides.
    expect(
      usesArtefactDenylist('const skip = new Set(["node_modules", "dist"]);'),
      "the detector no longer recognises a hand-written artefact denylist",
    ).toBe(true);

    expect(
      usesArtefactDenylist('// never read "node_modules"\nconst files = trackedFiles(root);'),
      "the detector fires on prose, so a scan could be banned for describing the rule",
    ).toBe(false);
  });

  it("🔒 no test asks the disk what a directory this repository tracks contains", () => {
    // The denylist ban above assumes a walk that at least tries to exclude
    // artefacts. A walk of the test's OWN directory does not even try: it
    // simply reports the working tree, so an untracked scratch file enrols
    // itself into whatever the test is auditing. That fails on the machine
    // holding the file and passes in CI, which is the least reproducible shape
    // a contract test can take.
    const offenders = scanned
      .filter(({ relative }) => relative !== SELF)
      .filter(({ relative }) => relative.endsWith(".test.ts") || relative.startsWith("test/"))
      .filter(({ source }) => scansATrackedDirectory(source))
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("🔒 the tracked-directory detector fires on the banned shape and not on the fixtures carve-out", () => {
    // Pays for the self-exclusion above, in both directions. The strings below
    // are the two shapes the rule turns on, so a detector that had stopped
    // recognising either fails here rather than emptying the scan in silence.
    expect(
      scansATrackedDirectory(
        "const here = dirname(fileURLToPath(import.meta.url));\nconst f = await readdir(here);",
      ),
      "the detector no longer recognises a scan of the file's own directory",
    ).toBe(true);

    expect(
      scansATrackedDirectory(
        'const root = await mkdtemp(join(tmpdir(), "kit-"));\nconst f = await readdir(root);',
      ),
      "the detector fires on a temp fixture, which git has never heard of",
    ).toBe(false);
  });

  it("🔒 the self-exclusion names a path git actually reports", () => {
    // The point of `trackedPath` is that the excluded constant matches a real
    // entry. Asserting that directly is stronger than checking the separator:
    // it fails for a hand-spelled path on Windows, and it also fails if the
    // file moves and the constant is left behind. Circularity is avoided by
    // comparing against git's list rather than against another `path` call.
    expect(trackedFiles(SERVER_ROOT)).toContain(SELF);
    expect(SELF).not.toContain("\\");
  });

  it("🔒 no consumer hand-spells a path it compares against git's answer", () => {
    // `git ls-files` always separates with `/`, on every platform. `path.join`
    // separates with `path.sep`, which is `\` on Windows. A constant built with
    // `join(...)` and compared against a `trackedFiles` entry therefore matches
    // on POSIX and silently stops matching on Windows — and every use of that
    // shape here is a self-exclusion, so the failure mode is not "the lock is
    // skipped" but "the lock reports ITSELF as an offender" and fails for a
    // reason that has nothing to do with the contract it guards.
    //
    // Neither vitest nor CI runs on Windows today, so no existing test can
    // observe the bug; a textual ban is the only thing that can. `trackedPath`
    // is the one correct spelling, and it derives the path from `import.meta`
    // rather than restating it, so it also cannot drift when a file moves.
    const consumers = scanned.filter(({ source }) => code(source).includes("trackedFiles("));
    expect(consumers.length, "no consumer found — the discovery has gone vacuous").toBeGreaterThan(
      3,
    );

    const offenders = consumers
      .filter(({ relative }) => relative !== SELF)
      .filter(({ source }) => handSpelledComparison(source))
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("🔒 the hand-spelled-path detector fires on the banned shape and not on the replacement", () => {
    // Pays for the self-exclusion above, in both directions.
    expect(
      handSpelledComparison('const SELF = path.join("src", "a.test.ts");'),
      "the detector no longer recognises a hand-spelled comparison path",
    ).toBe(true);

    expect(
      handSpelledComparison("const SELF = trackedPath(root, fileURLToPath(import.meta.url));"),
      "the detector fires on the replacement, so the correct spelling is banned too",
    ).toBe(false);

    expect(
      handSpelledComparison("const file = path.join(root, relative);"),
      "the detector fires on reading a file, which is a normalising join and is fine",
    ).toBe(false);

    expect(
      handSpelledComparison('const line = parts.join("|");'),
      "the detector fires on a one-argument array join, which is a separator not a path",
    ).toBe(false);
  });

  it("🔒 the replacement is load-bearing, not merely available", () => {
    // Guards the ban above against the trivial reading: deleting every repo
    // scan would also satisfy it. These are the scans that used to carry the
    // denylist, so the ban is only meaningful while they still run.
    const users = scanned
      .filter(({ source }) => code(source).includes("trackedFiles("))
      .map(({ relative }) => relative);

    expect(users.length).toBeGreaterThan(2);
  });
});
