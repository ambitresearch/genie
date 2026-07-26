import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { trackedFiles } from "./tracked-files.js";

const SERVER_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** Live code only: the rule below is explained in prose that must stay legal. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/(?:^|[^:])\/\/.*$/gmu, " ");

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
      .filter(({ relative }) => relative.endsWith(".test.ts") || relative.startsWith("test/"))
      .filter(({ source }) => code(source).includes('"node_modules"'))
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
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
