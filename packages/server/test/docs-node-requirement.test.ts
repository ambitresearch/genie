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

import { readFile } from "node:fs/promises";
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
 * Every file that states the Node prerequisite to a reader.
 *
 * `.nvmrc` is deliberately absent: it is a local development baseline — no
 * workflow reads it, and CI builds a `node: [22, 24]` matrix of bare majors —
 * so it states one convenient version rather than the range users may install
 * with. Narrowing it would be a different change.
 */
const DOCS_STATING_THE_PREREQUISITE = [
  "README.md",
  "docs/user/installation.md",
  "docs/developer/contributing.md",
];

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

    for (const doc of DOCS_STATING_THE_PREREQUISITE) {
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
    for (const doc of DOCS_STATING_THE_PREREQUISITE) {
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
