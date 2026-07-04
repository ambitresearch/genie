/**
 * Tests for M3-06's `.genie/sync.json` verification anchor
 * (`packages/server/src/sync/anchor.ts`).
 *
 * Covers every AC on DRO-262:
 *   - AC1 — the module exports `writeAnchor(projectRoot, planResult)` and
 *     `readAnchor(projectRoot)`.
 *   - AC2 — schema matches the genie anchor shape (D-C); `Anchor` type export.
 *   - AC3 — `sourceHashes` covers every `.tsx`/`.jsx` source file touched.
 *   - AC4 — `renderHashes` covers every `.html` preview file touched.
 *   - AC5 — `verified` lists `<group>/<Name>` IDs.
 *   - AC6 — `by` is always `"genie"`, overridable via `GENIE_BY`.
 *   - AC7 — atomic write: temp file + rename.
 *   - AC8 — `readAnchor` returns `null` (not throw) when the file is missing.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sriSha256 } from "../store/kit-files.js";
import { AnchorParseError, readAnchor, writeAnchor, type Anchor, type PlanResult } from "./anchor.js";

async function tempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-sync-anchor-"));
}

describe("sync/anchor", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await tempProjectRoot();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    delete process.env["GENIE_BY"];
  });

  // ─── AC1/AC2 — write + round-trip read ────────────────────────────────────

  it("AC1/AC2: writes an anchor and reads back the exact same shape", async () => {
    const planResult: PlanResult = {
      writes: [
        { path: "components/actions/Button/Button.tsx", content: "export const Button = () => null;" },
        { path: "components/actions/Button/Button.html", content: '<!-- @genie group="actions" -->' },
      ],
      verified: ["actions/Button"],
    };

    await writeAnchor(projectRoot, planResult);
    const anchor = await readAnchor(projectRoot);

    expect(anchor).not.toBeNull();
    expect(anchor?.version).toBe(1);
    expect(anchor?.by).toBe("genie");
    expect(anchor?.sourceHashes).toEqual({
      "components/actions/Button/Button.tsx": sriSha256("export const Button = () => null;"),
    });
    expect(anchor?.renderHashes).toEqual({
      "components/actions/Button/Button.html": sriSha256('<!-- @genie group="actions" -->'),
    });
    expect(anchor?.verified).toEqual(["actions/Button"]);
    expect(anchor?.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("AC1: writeAnchor persists to <projectRoot>/.genie/sync.json (D-C path)", async () => {
    await writeAnchor(projectRoot, { writes: [], verified: [] });
    const raw = await readFile(join(projectRoot, ".genie", "sync.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.by).toBe("genie");
  });

  // ─── AC8 — missing file returns null, never throws ────────────────────────

  it("AC8: readAnchor returns null when .genie/sync.json does not exist", async () => {
    const anchor = await readAnchor(projectRoot);
    expect(anchor).toBeNull();
  });

  it("AC8: readAnchor returns null when the whole .genie dir does not exist", async () => {
    const freshRoot = join(projectRoot, "never-created");
    const anchor = await readAnchor(freshRoot);
    expect(anchor).toBeNull();
  });

  // ─── AC3 — sourceHashes covers every .tsx/.jsx touched ────────────────────

  it("AC3: sourceHashes includes every .tsx and .jsx write, keyed by path", async () => {
    const planResult: PlanResult = {
      writes: [
        { path: "components/actions/Button/Button.tsx", content: "tsx-content" },
        { path: "components/actions/Icon/Icon.jsx", content: "jsx-content" },
        { path: "components/actions/Button/Button.html", content: "html-content" },
        { path: "components/actions/Button/meta.json", content: "{}" },
      ],
      verified: [],
    };

    await writeAnchor(projectRoot, planResult);
    const anchor = await readAnchor(projectRoot);

    expect(anchor?.sourceHashes).toEqual({
      "components/actions/Button/Button.tsx": sriSha256("tsx-content"),
      "components/actions/Icon/Icon.jsx": sriSha256("jsx-content"),
    });
  });

  it("AC3: sourceHashes is an empty object when no source files were touched", async () => {
    await writeAnchor(projectRoot, {
      writes: [{ path: "components/actions/Button/Button.html", content: "x" }],
      verified: [],
    });
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.sourceHashes).toEqual({});
  });

  it("AC3: sourceHashes also covers .vue single-file components (Vue is a first-class shipped framework, M2-08)", async () => {
    const planResult: PlanResult = {
      writes: [
        { path: "components/actions/Button/Button.vue", content: "vue-sfc-content" },
        { path: "components/actions/Button/Button.html", content: "html-content" },
      ],
      verified: [],
    };

    await writeAnchor(projectRoot, planResult);
    const anchor = await readAnchor(projectRoot);

    expect(anchor?.sourceHashes).toEqual({
      "components/actions/Button/Button.vue": sriSha256("vue-sfc-content"),
    });
  });

  // ─── AC4 — renderHashes covers every .html touched ────────────────────────

  it("AC4: renderHashes includes every .html write, keyed by path", async () => {
    const planResult: PlanResult = {
      writes: [
        { path: "components/actions/Button/Button.html", content: "button-html" },
        { path: "components/surfaces/Card/Card.html", content: "card-html" },
        { path: "components/actions/Button/Button.tsx", content: "tsx" },
      ],
      verified: [],
    };

    await writeAnchor(projectRoot, planResult);
    const anchor = await readAnchor(projectRoot);

    expect(anchor?.renderHashes).toEqual({
      "components/actions/Button/Button.html": sriSha256("button-html"),
      "components/surfaces/Card/Card.html": sriSha256("card-html"),
    });
  });

  it("AC4: renderHashes is an empty object when no .html files were touched", async () => {
    await writeAnchor(projectRoot, {
      writes: [{ path: "components/actions/Button/Button.tsx", content: "x" }],
      verified: [],
    });
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.renderHashes).toEqual({});
  });

  // ─── AC5 — verified lists <group>/<Name> IDs ───────────────────────────────

  it("AC5: verified carries through every <group>/<Name> id passed in", async () => {
    const planResult: PlanResult = {
      writes: [],
      verified: ["actions/Button", "surfaces/Card", "forms-inputs/TextField"],
    };
    await writeAnchor(projectRoot, planResult);
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.verified).toEqual(["actions/Button", "surfaces/Card", "forms-inputs/TextField"]);
  });

  it("AC5: verified is an empty array when nothing passed validation this sync", async () => {
    await writeAnchor(projectRoot, { writes: [], verified: [] });
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.verified).toEqual([]);
  });

  // ─── AC6 — by is "genie", overridable via GENIE_BY ────────────────────────

  it('AC6: by defaults to "genie" when GENIE_BY is unset', async () => {
    delete process.env["GENIE_BY"];
    await writeAnchor(projectRoot, { writes: [], verified: [] });
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.by).toBe("genie");
  });

  it("AC6: by respects the GENIE_BY env override (for forks)", async () => {
    process.env["GENIE_BY"] = "genie/acme-fork";
    await writeAnchor(projectRoot, { writes: [], verified: [] });
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.by).toBe("genie/acme-fork");
  });

  it("AC6: an explicit env argument overrides process.env", async () => {
    process.env["GENIE_BY"] = "genie/from-process-env";
    await writeAnchor(
      projectRoot,
      { writes: [], verified: [] },
      { GENIE_BY: "genie/from-explicit-env" },
    );
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.by).toBe("genie/from-explicit-env");
  });

  // ─── AC7 — atomic write: temp file + rename ────────────────────────────────

  it("AC7: leaves no temp artifact behind in .genie/ after a successful write", async () => {
    await writeAnchor(projectRoot, { writes: [], verified: [] });
    const entries = await readdir(join(projectRoot, ".genie"));
    expect(entries).toEqual(["sync.json"]);
  });

  it("AC7: overwrites a pre-existing anchor atomically (no stale fields linger)", async () => {
    await writeAnchor(projectRoot, { writes: [], verified: ["actions/Button"] });
    await writeAnchor(projectRoot, { writes: [], verified: ["surfaces/Card"] });
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.verified).toEqual(["surfaces/Card"]);
    const entries = await readdir(join(projectRoot, ".genie"));
    expect(entries).toEqual(["sync.json"]);
  });

  it("AC7: creates the .genie directory if it does not already exist", async () => {
    // beforeEach's tempProjectRoot only creates the root, not .genie/ itself.
    await expect(readdir(join(projectRoot, ".genie"))).rejects.toThrow();
    await writeAnchor(projectRoot, { writes: [], verified: [] });
    const entries = await readdir(join(projectRoot, ".genie"));
    expect(entries).toContain("sync.json");
  });

  it("AC7: stages under the shared .genie-tmp/ scratch dir (already excluded from kit listings) and cleans it up", async () => {
    await writeAnchor(projectRoot, { writes: [], verified: [] });
    // The staging subdirectory created for this call must not survive the
    // commit — only the (empty, reusable) .genie-tmp root itself may remain.
    const tmpEntries = await readdir(join(projectRoot, ".genie-tmp"));
    expect(tmpEntries).toEqual([]);
  });

  it("hashes Buffer content identically to the equivalent utf-8 string", async () => {
    const text = "export const Button = () => null;";
    await writeAnchor(projectRoot, {
      writes: [{ path: "components/actions/Button/Button.tsx", content: Buffer.from(text, "utf-8") }],
      verified: [],
    });
    const anchor = await readAnchor(projectRoot);
    expect(anchor?.sourceHashes["components/actions/Button/Button.tsx"]).toBe(sriSha256(text));
  });

  // ─── Corrupt-file handling: throw, not null (reserved for missing-file) ───

  it("throws AnchorParseError (not null) when sync.json contains invalid JSON", async () => {
    await mkdir(join(projectRoot, ".genie"), { recursive: true });
    await writeFile(join(projectRoot, ".genie", "sync.json"), "{ not valid json", "utf-8");
    await expect(readAnchor(projectRoot)).rejects.toThrow(AnchorParseError);
  });

  it("throws AnchorParseError (not null) when sync.json is valid JSON but the wrong shape", async () => {
    await mkdir(join(projectRoot, ".genie"), { recursive: true });
    await writeFile(
      join(projectRoot, ".genie", "sync.json"),
      JSON.stringify({ version: 1, hello: "world" }),
      "utf-8",
    );
    await expect(readAnchor(projectRoot)).rejects.toThrow(AnchorParseError);
  });

  it("throws AnchorParseError when version is not the literal 1", async () => {
    await mkdir(join(projectRoot, ".genie"), { recursive: true });
    await writeFile(
      join(projectRoot, ".genie", "sync.json"),
      JSON.stringify({
        version: 2,
        writtenAt: new Date(0).toISOString(),
        by: "genie",
        sourceHashes: {},
        renderHashes: {},
        verified: [],
      }),
      "utf-8",
    );
    await expect(readAnchor(projectRoot)).rejects.toThrow(AnchorParseError);
  });

  // ─── Type sanity (AC2) ──────────────────────────────────────────────────────

  it("AC2: the written+read Anchor has exactly the D-C field set", async () => {
    await writeAnchor(projectRoot, { writes: [], verified: [] });
    const anchor = (await readAnchor(projectRoot)) as Anchor;
    expect(Object.keys(anchor).sort()).toEqual(
      ["version", "writtenAt", "by", "sourceHashes", "renderHashes", "verified"].sort(),
    );
  });
});
