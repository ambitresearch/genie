/**
 * The public prerequisites must describe the runtime the published packages
 * actually accept.
 *
 * `engines.node` is the supported-runtime contract, not an install lock. This
 * repository sets no `engine-strict`, so npm treats the field as advisory: it
 * warns `EBADENGINE` and installs anyway. Nothing therefore stops a reader from
 * running the published packages on a runtime they were never tested against —
 * the prerequisite line in the docs is the only thing that can.
 *
 * That matters more since CVE-2025-27210 narrowed both manifests to
 * `>=22.19.0 <23 || >=24.4.1`. The supported set stopped being a floor and
 * acquired a hole covering all of 23.x — an EOL line that reached end of life
 * without ever receiving the fix — and 24.0–24.4.0, the vulnerable prefix of a
 * still-supported line that was patched at 24.4.1. Every public prerequisite in
 * the tree went on
 * describing the old floor, telling a user on Node 23 that a documented command
 * was supported when it lands them on an unpatched runtime with only a warning
 * that never mentions the CVE. Hence a range, never a floor.
 *
 * These are derived checks on purpose. This PR exists because one rule restated
 * at eight call sites drifted, and the same drift then recurred in this PR's own
 * comments and body several times over. Re-typing the supported versions into a
 * fifth place would be that defect again, so nothing here hard-codes a version:
 * the expected prose is rendered FROM the manifest, and the honesty check sweeps
 * the manifest's own clause endpoints.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  findOpenEndedNodeFloors,
  nodeFloorOverclaim,
  renderNodeRequirement,
  statesNodeRequirement,
} from "./helpers/node-cve.js";
import { trackedFiles } from "./helpers/tracked-files.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Every file that states the Node prerequisite to a reader, discovered rather
 * than listed.
 *
 * The previous hand-written list omitted the root `CONTRIBUTING.md` — linked
 * from `README.md` and from `docs/developer/contributing.md` — which went on
 * promising `Node >= 22.19.0` while this lock reported green. A lock whose
 * coverage is retyped by hand fails exactly the way the eight kitId gates this
 * PR unifies failed, so the coverage is now derived: any markdown that states a
 * Node requirement at all is in scope automatically, including files that do not
 * exist yet. Discovery deliberately never asks what SHAPE the claim takes — see
 * `statesNodeRequirement`, which is why a bounded `Node >=23 <24` is checked
 * too.
 *
 * `.nvmrc` is out of scope by construction rather than by omission: the sweep
 * reads markdown, and a bare version pinned for local use states one convenient
 * version rather than a promise about the supported range. No workflow reads
 * it, and CI builds a `node: [22, 24]` matrix of bare majors.
 */
const CHANGELOG = /(^|\/)CHANGELOG\.md$/u;

/**
 * Changelogs are excluded because they are a record, not a promise. Their Node
 * mentions describe what a past release required — the 18-to-22 migration, and
 * the floors pnpm and Vitest imposed at the time. Editing them to match today's
 * range would falsify history to satisfy a lint.
 */
const isPrerequisiteDoc = (relative: string): boolean => !CHANGELOG.test(relative);

const repoFiles = async (matches: (relative: string) => boolean): Promise<string[]> =>
  trackedFiles(REPO_ROOT).filter(matches);

const markdownFiles = async (): Promise<string[]> =>
  await repoFiles((file) => file.endsWith(".md") && isPrerequisiteDoc(file));

/**
 * The sweep must read the repository, not the working COPY of it.
 *
 * The walk skipped a hand-written set of build directories, which is a denylist
 * standing in for the real question: does git track this file? `.genie/` and
 * `reports/` are ignored and present, and `.claude/TASKS.md` is the gitignored
 * scratchpad `CLAUDE.md` asks every agent to keep — so a private note stating a
 * Node version could fail this public-contract suite on one machine and pass on
 * the next. A denylist also has to be extended for every new artefact
 * directory, which is the drift this file already refuses elsewhere.
 */
describe("documentation sweep — hermetic against the working copy", () => {
  it("🔒 never reads a file git does not track", async () => {
    const scratch = path.join(REPO_ROOT, "reports");
    await mkdir(scratch, { recursive: true });
    const note = path.join(scratch, "node-requirement-scratch.md");
    await writeFile(note, "# scratch\n\nRequires Node >= 1.2.3 to run.\n", "utf-8");
    try {
      // Guards against passing because the fixture was never a candidate: the
      // sweep only claims markdown, so an untracked markdown file is exactly
      // the shape it would otherwise have read.
      expect(note.endsWith(".md")).toBe(true);
      expect(await markdownFiles()).not.toContain("reports/node-requirement-scratch.md");
    } finally {
      await rm(note, { force: true });
    }
  });
});

/**
 * The manifests whose `engines.node` those docs are promising — DERIVED, not listed.
 *
 * A hand-maintained list here recreates the exact drift this suite exists to catch:
 * a newly publishable package would be silently exempt from both the range-equality
 * check and the documentation contract, and nothing would say so. `packages/*` with
 * `private !== true` is the same derivation `kit-files.test.ts` already uses for the
 * published-runtime scan, so the two cannot disagree about what "published" means.
 */
const publishedManifests = (): string[] =>
  trackedFiles(REPO_ROOT)
    .filter((relative) => /^packages\/[^/]+\/package\.json$/u.test(relative))
    .filter((relative) => {
      const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8")) as {
        private?: boolean;
      };
      return manifest.private !== true;
    })
    .sort();

const PUBLISHED_MANIFESTS = publishedManifests();

const read = async (relative: string): Promise<string> =>
  await readFile(path.join(REPO_ROOT, relative), "utf8");

const enginesNode = async (relative: string): Promise<string> => {
  const manifest = JSON.parse(await read(relative)) as { engines?: { node?: string } };
  const range = manifest.engines?.node;
  if (typeof range !== "string") {
    throw new Error(`${relative} declares no engines.node`);
  }
  return range;
};

describe("published Node requirement", () => {
  // Anti-vacuity for the derivation above. Every assertion in this suite loops
  // over PUBLISHED_MANIFESTS, so a derivation that silently returned [] would
  // turn the whole file green while checking nothing. This pins the floor
  // (both packages the repo publishes today) without re-listing it as the
  // contract: a third published package raises the count and is then required
  // to satisfy every check, which is the entire point of deriving it.
  it("🔒 derives the published manifests rather than listing them", () => {
    expect(PUBLISHED_MANIFESTS).toEqual(
      expect.arrayContaining(["packages/server/package.json", "packages/viewer/package.json"]),
    );
    // `packages/e2e` is inside the scan but excluded by `private: true`; it is
    // the discriminator proving the filter runs at all rather than globbing.
    expect(PUBLISHED_MANIFESTS).not.toContain("packages/e2e/package.json");
  });

  it("🔒 is the same range in every published manifest", async () => {
    const ranges = await Promise.all(PUBLISHED_MANIFESTS.map(enginesNode));

    // Two manifests stating one requirement is already a restatement; pin them
    // together so the docs below have a single thing to be checked against.
    expect(new Set(ranges).size).toBe(1);
  });

  it("🔒 is stated by the public prerequisites in the form the manifest implies", async () => {
    const expected = renderNodeRequirement(await enginesNode(PUBLISHED_MANIFESTS[0]));

    // Discovery asks whether the doc states a Node requirement AT ALL, not
    // whether it states an open-ended floor. Deciding it with
    // `findOpenEndedNodeFloors` made a document's visibility depend on the shape
    // of its claim: `Requires Node 23.x` and a bounded `Node >=23 <24` yield no
    // floor, so a doc drifting to either wording silently left the checked set —
    // the wording most likely to be wrong was the wording that escaped the check.
    const stating: string[] = [];
    for (const doc of await markdownFiles()) {
      if (statesNodeRequirement(await read(doc))) stating.push(doc);
    }

    // Guards the sweep against passing because it found nothing to check. The
    // floor is the four public entry points a reader can arrive through; a new
    // one raises this naturally, and losing one fails here rather than silently.
    expect(stating).toEqual(
      expect.arrayContaining([
        "CONTRIBUTING.md",
        "README.md",
        "docs/developer/contributing.md",
        "docs/user/installation.md",
      ]),
    );

    for (const doc of stating) {
      expect(await read(doc), `${doc} must state the requirement as "${expected}"`).toContain(
        expected,
      );
    }
  });

  it("🔒 is never flattened back into an open-ended floor the manifest refuses", async () => {
    const range = await enginesNode(PUBLISHED_MANIFESTS[0]);

    // The general form of the failure this test exists for. The check above pins
    // the wording; this one catches a floor stated ANYWHERE in these files —
    // including inside the README's shields.io badge URL, where `≥` is
    // percent-encoded and no search for the prose form would ever see it.
    for (const doc of await markdownFiles()) {
      const text = await read(doc);
      const floors = findOpenEndedNodeFloors(text);

      for (const floor of floors) {
        const counterexample = nodeFloorOverclaim(floor, range);
        expect(
          counterexample,
          `${doc} promises "${floor} or newer", but ${String(counterexample)} is outside ` +
            `engines.node "${range}" — an unsupported runtime npm would only warn about.`,
        ).toBeNull();
      }
    }
  });

  it("🔒 detects an over-claiming floor rather than passing vacuously", async () => {
    const range = await enginesNode(PUBLISHED_MANIFESTS[0]);

    // Without this, the sweep above would still pass if `findOpenEndedNodeFloors`
    // silently stopped matching — the failure mode that let the badge drift in
    // the first place. Assert both halves detect the state this test was born in.
    expect(findOpenEndedNodeFloors("Requires Node ≥ 22.19.0")).toContain("22.19.0");
    expect(findOpenEndedNodeFloors("node-%E2%89%A522.19.0-brightgreen.svg")).toContain("22.19.0");
    expect(findOpenEndedNodeFloors("Node.js 22.19 or newer")).toContain("22.19.0");
    expect(nodeFloorOverclaim("22.19.0", range)).toBe("23.0.0");
  });
  it("\u{1f512} never restates how many claims or files the scan covers", async () => {
    // The scan below OWNS the inventory. Two docblocks nevertheless hard-coded
    // both halves of it — how many claims, and how many files they live in — as
    // literals, and the pair was already wrong when written, because the file
    // set had grown to include the root `CONTRIBUTING.md`. One copy has been
    // deleted; this catches the next one.
    //
    // The pattern deliberately has no exemption for this file: a lock allowed
    // to quote the shape it forbids is a lock that stops being able to read
    // itself, which is how the npm-enforcement lock came to certify the exact
    // drift it existed to stop.
    //
    // The fix for a hit is always deletion, never a fresh number: a restated
    // tally has no way to notice the scan moving under it, which is the whole
    // reason the scan is derived.
    // Only the claim-count arm. A bare "N files" also appears in fixture prose
    // ("seed two files onto the host"), so matching it reported a passing test
    // file as drift; the count of CLAIMS is the distinctive half, and the
    // sentence that carried the defect ("... claims across three files") cannot
    // survive its removal anyway.
    const tally =
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:prose\s+)?claims?\b/giu;
    // Discovered, not listed: a hand-written file list is the same defect one
    // level up, and would have to be edited by whoever adds the next copy.
    const scanned = trackedFiles(path.join(REPO_ROOT, "packages/server/test"))
      .filter((relative) => relative.endsWith(".ts"))
      .map((relative) => path.join(REPO_ROOT, "packages/server/test", relative));
    expect(scanned.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of scanned) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(tally))
        offenders.push(`${path.basename(file)}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("\u{1f512} is never described as something npm enforces", async () => {
    // An install is halted over that field only under `engine-strict`, which this
    // repository does not set: npm warns `EBADENGINE` and installs anyway. A
    // comment claiming npm blocks the install is not a harmless simplification
    // \u2014 it states this file's whole reason backwards. If the field stopped a
    // user reaching an unsupported runtime, the prose would not have to.
    const npmrc = await read(".npmrc").catch(() => "");
    if (/^\s*engine-strict\s*=\s*true/mu.test(npmrc)) return;

    // Order-free by construction. The first version of this lock required
    // refusal -> install -> field, which is the order the sites already found
    // happened to use. One doc put the field first and named no install at all,
    // so the lock read that file and reported clean while the exact drift it
    // exists to stop sat inside it. A pattern derived from the instances you
    // already found only ever confirms that search. So: any refusal verb
    // co-occurring with the field inside one sentence, in either direction.
    //
    // The field is matched by its full name (or backticked) rather than as a
    // bare word, because "engines" is also ordinary English for a JavaScript
    // runtime -- `docs/developer/architecture.md` discusses `preventDefault()`
    // on "older engines", which is a true sentence about browsers and not a
    // claim about any manifest.
    const FIELD = "(?:`engines(?:\\.node)?`|engines\\.node)";
    const REFUSAL = "(?:refus\\w*|block\\w*|prevent\\w*|reject\\w*|bar(?:s|red)?|stop\\w*)";
    const enforcement = new RegExp(
      `(?:${FIELD}[^.]{0,160}?\\b${REFUSAL}\\b|\\b${REFUSAL}\\b[^.]{0,160}?${FIELD})`,
      "giu",
    );

    const offenders: string[] = [];
    for (const file of await repoFiles((f) => f.endsWith(".md") || f.endsWith(".ts"))) {
      // Collapse docblock leaders so a claim wrapped across several comment
      // lines is read as the single sentence it is.
      const prose = (await read(file)).replace(/\n\s*\*?\s*/gu, " ");
      for (const [sentence] of prose.matchAll(enforcement)) {
        offenders.push(`${file}: ${sentence.trim()}`);
      }
    }

    expect(
      offenders,
      "engines.node is advisory here \u2014 npm warns EBADENGINE and installs anyway",
    ).toEqual([]);
  });
});
