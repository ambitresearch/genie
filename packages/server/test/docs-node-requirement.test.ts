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
 * acquired a hole covering all of 23.x and 24.0–24.4.0, both EOL lines that
 * never received the fix. Four prose claims across three files went on
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

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  findOpenEndedNodeFloors,
  nodeFloorOverclaim,
  renderNodeRequirement,
} from "./helpers/node-cve.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Every file that states the Node prerequisite to a reader, discovered rather
 * than listed.
 *
 * The previous hand-written list omitted the root `CONTRIBUTING.md` — linked
 * from `README.md` and from `docs/developer/contributing.md` — which went on
 * promising `Node >= 22.19.0` while this lock reported green. A lock whose
 * coverage is retyped by hand fails exactly the way the eight kitId gates this
 * PR unifies failed, so the coverage is now derived: any markdown that states
 * an open-ended Node floor is in scope automatically, including files that do
 * not exist yet.
 *
 * `.nvmrc` is out of scope by construction rather than by omission: it holds a
 * bare version with no floor spelling, so it states one convenient local
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

const markdownFiles = async (): Promise<string[]> => {
  const skip = new Set(["node_modules", "dist", ".git", "coverage", ".turbo"]);
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(REPO_ROOT, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(child);
      } else if (entry.name.endsWith(".md") && isPrerequisiteDoc(child)) {
        found.push(child);
      }
    }
  };
  await walk("");
  return found.sort();
};

/** The manifests whose `engines.node` those docs are promising. */
const PUBLISHED_MANIFESTS = ["packages/server/package.json", "packages/viewer/package.json"];

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
  it("🔒 is the same range in every published manifest", async () => {
    const ranges = await Promise.all(PUBLISHED_MANIFESTS.map(enginesNode));

    // Two manifests stating one requirement is already a restatement; pin them
    // together so the docs below have a single thing to be checked against.
    expect(new Set(ranges).size).toBe(1);
  });

  it("🔒 is stated by the public prerequisites in the form the manifest implies", async () => {
    const expected = renderNodeRequirement(await enginesNode(PUBLISHED_MANIFESTS[0]));

    const stating: string[] = [];
    for (const doc of await markdownFiles()) {
      if (findOpenEndedNodeFloors(await read(doc)).length > 0) stating.push(doc);
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
});
