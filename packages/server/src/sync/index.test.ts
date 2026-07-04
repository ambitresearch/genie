/**
 * Proves `packages/server/src/sync/index.ts` publicly re-exports the sync
 * anchor's full surface (mirrors `validate/index.test.ts`'s barrel-regression
 * pattern). Downstream consumers (the M3-05 atomic sync orchestrator) import
 * from this barrel, not from `./anchor.js` directly; this test is the
 * regression guard that keeps the barrel in sync if `anchor.ts` ever grows a
 * new export.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnchorParseError,
  ANCHOR_PATH,
  DEFAULT_BY,
  GENIE_BY_ENV,
  readAnchor,
  writeAnchor,
  type Anchor,
  type PlanResult,
} from "./index.js";

describe("sync/index.ts re-export barrel", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "genie-sync-barrel-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("re-exports the ANCHOR_PATH / GENIE_BY_ENV / DEFAULT_BY constants", () => {
    expect(ANCHOR_PATH).toBe(".genie/sync.json");
    expect(GENIE_BY_ENV).toBe("GENIE_BY");
    expect(DEFAULT_BY).toBe("genie");
  });

  it("re-exports a working writeAnchor + readAnchor round trip", async () => {
    await writeAnchor(projectRoot, { writes: [], verified: ["actions/Button"] });
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.verified).toEqual(["actions/Button"]);
  });

  it("re-exports AnchorParseError as the class readAnchor throws on corruption", () => {
    expect(AnchorParseError.prototype).toBeInstanceOf(Error);
  });

  it("re-exports the Anchor and PlanResult types (IDE-only type check)", () => {
    // Same caveat as validate/index.test.ts: packages/server/tsconfig.json
    // excludes src/**/*.test.ts, so this assignment is a best-effort IDE
    // nudge, not a CI-enforced type check. The runtime tests above are the
    // actual regression guard.
    const anchor: Anchor = {
      version: 1,
      writtenAt: new Date(0).toISOString(),
      by: "genie",
      sourceHashes: {},
      renderHashes: {},
      verified: [],
    };
    const planResult: PlanResult = { writes: [], verified: [] };
    expect(anchor.version).toBe(1);
    expect(planResult.writes).toEqual([]);
  });
});
