/**
 * Tests for M3-03's `.genie/manifest.json` writer (client-side compiler)
 * (`packages/server/src/manifest/compiler.ts`).
 *
 * Covers every AC on DRO-259:
 *   - AC1 — the module exports `compileManifest(projectRoot)`.
 *   - AC2 — walks `components/**\/*.html` recursively; extracts group +
 *     viewport from the `@genie` marker (reusing M3-01's `validateMarker`);
 *     a file that fails marker validation is skipped, not thrown.
 *   - AC3 — joins each card with a sibling `meta.json` for `subtitle`/`tags`.
 *   - AC4 — output schema. **Reconciled** against the already-shipped
 *     `store/manifest.ts` reader (see the module doc in `compiler.ts` for the
 *     full rationale): root key is `components` (not the issue's literal
 *     `cards`), and `viewport` is the raw marker token STRING (not a
 *     `{width,height}` object) — both required so this compiler's output
 *     round-trips through the live `list_components` tool without throwing
 *     `ManifestParseError`. `version`, `name`, `generatedAt`, `groups`, and
 *     each card's `id`/`subtitle`/`tags` are additive fields the reader's
 *     `.passthrough()` schemas tolerate.
 *   - AC5 — hashes are `sha256-<base64>` SRI over the HTML file's bytes,
 *     the same `sriSha256` helper `list_files`/`.genie/sync.json` use.
 *   - AC6 — atomic write: `.genie/manifest.json.tmp` → rename over
 *     `.genie/manifest.json` (no raw `fsync` — see `compiler.ts`'s
 *     `writeManifestAtomic` doc comment for why AC6's literal wording is
 *     satisfied by same-filesystem `rename()` atomicity alone).
 *   - AC7 — compiles a 50-component kit in < 100 ms.
 *   - Group order: alphabetical unless a root `_groups.json` sibling pins it.
 *   - Card order: alphabetical by name within a group, ties by path.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sriSha256 } from "../store/kit-files.js";
import { selectComponents } from "../store/manifest.js";
import { compileManifest } from "./compiler.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

async function tempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genie-manifest-compiler-"));
}

interface ScaffoldOptions {
  viewport?: string;
  extraAttrs?: string;
  meta?: { subtitle?: string; tags?: string[] } | string; // string = raw override (malformed-JSON test)
  markerGroup?: string; // when set, differs from the directory's <group> segment
  noMarker?: boolean;
}

/**
 * Write `components/<group>/<name>/<name>.html` (+ optional sibling
 * `meta.json`) under `projectRoot`, with a valid `@genie` marker unless
 * `noMarker` is set. Mirrors the on-disk convention every other M3 module
 * (watcher, marker validator) assumes.
 */
async function scaffoldComponent(
  projectRoot: string,
  group: string,
  name: string,
  opts: ScaffoldOptions = {},
): Promise<string> {
  const dir = join(projectRoot, "components", group, name);
  await mkdir(dir, { recursive: true });

  const htmlPath = join(dir, `${name}.html`);
  const markerGroup = opts.markerGroup ?? group;
  const viewportAttr = opts.viewport ? ` viewport="${opts.viewport}"` : "";
  const extra = opts.extraAttrs ? ` ${opts.extraAttrs}` : "";
  const firstLine = opts.noMarker
    ? "<div>no marker here</div>"
    : `<!-- @genie group="${markerGroup}"${viewportAttr}${extra} -->`;
  const body = `${firstLine}\n<div class="card">${name}</div>\n`;
  await writeFile(htmlPath, body, "utf-8");

  if (opts.meta !== undefined) {
    const metaPath = join(dir, "meta.json");
    const metaBody = typeof opts.meta === "string" ? opts.meta : JSON.stringify(opts.meta);
    await writeFile(metaPath, metaBody, "utf-8");
  }

  return htmlPath;
}

describe("manifest/compiler", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await tempProjectRoot();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  // ─── AC1 — exports + basic shape ──────────────────────────────────────────

  it("AC1: exports compileManifest(projectRoot) returning a Manifest", async () => {
    await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
    const manifest = await compileManifest(projectRoot);
    expect(manifest.version).toBe(1);
    expect(typeof manifest.name).toBe("string");
    expect(typeof manifest.generatedAt).toBe("string");
    expect(Array.isArray(manifest.groups)).toBe(true);
    expect(Array.isArray(manifest.components)).toBe(true);
  });

  it("AC1: generatedAt is an ISO-8601 timestamp", async () => {
    const manifest = await compileManifest(projectRoot);
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // ─── AC4 — exact schema shape (reconciled — see compiler.ts module doc) ───

  describe("AC4: output schema", () => {
    it("uses root key `components` (NOT the issue's literal `cards`) — matches the shipped store/manifest.ts reader", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      const manifest = (await compileManifest(projectRoot)) as unknown as Record<string, unknown>;
      expect(manifest["components"]).toBeDefined();
      expect(manifest["cards"]).toBeUndefined();
    });

    it("each card's `viewport` is the raw marker token STRING, not a {width,height} object", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components[0]?.viewport).toBe("400x200");
    });

    it("preserves a non-numeric (named) viewport token verbatim", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "desktop" });
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components[0]?.viewport).toBe("desktop");
    });

    it("every card carries the six shipped-reader-required fields plus `id`", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      const manifest = await compileManifest(projectRoot);
      const card = manifest.components[0]!;
      expect(card).toMatchObject({
        id: "actions/Button",
        name: "Button",
        group: "actions",
        path: "components/actions/Button/Button.html",
        viewport: "400x200",
      });
      expect(card.hash).toMatch(/^sha256-/);
      expect(card.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("REGRESSION GUARD: round-trips through the shipped selectComponents reader without throwing", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", {
        viewport: "400x200",
        meta: { subtitle: "Primary action", tags: ["cta"] },
      });
      await scaffoldComponent(projectRoot, "forms", "TextField", { viewport: "desktop" });

      const manifest = await compileManifest(projectRoot);
      const raw = await readFile(join(projectRoot, ".genie", "manifest.json"), "utf-8");

      // The exact call `LocalFsKitStore`/`GitHostKitStore` make when serving
      // `list_components` (`store/manifest.ts`'s `selectComponents`) — if this
      // throws ManifestParseError, this compiler's output would break a live
      // P0 tool.
      const entries = selectComponents("test-kit", raw);
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name).sort()).toEqual(["Button", "TextField"]);
      // Sanity: the manifest we asserted on above and the one on disk agree.
      expect(manifest.components).toHaveLength(2);
    });
  });

  // ─── AC2 — recursive walk + marker-driven group/viewport extraction ──────

  describe("AC2: walk + marker extraction", () => {
    it("walks components/**/*.html recursively and extracts group + viewport from the marker", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      await scaffoldComponent(projectRoot, "forms-inputs", "TextField", { viewport: "375x812" });

      const manifest = await compileManifest(projectRoot);
      const byName = Object.fromEntries(manifest.components.map((c) => [c.name, c]));
      expect(byName["Button"]).toMatchObject({ group: "actions", viewport: "400x200" });
      expect(byName["TextField"]).toMatchObject({ group: "forms-inputs", viewport: "375x812" });
    });

    it("the marker's group=\"...\" attribute is authoritative over the directory path segment (the marker IS the registration, per M3-01)", async () => {
      // Pathological but must be well-defined: directory says "actions",
      // marker says "surfaces". D-B: the marker is the registration contract.
      await scaffoldComponent(projectRoot, "actions", "Button", { markerGroup: "surfaces" });
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components[0]?.group).toBe("surfaces");
    });

    it("a file whose first line fails the @genie marker check is skipped, not thrown (RFC §6.8: 'the watcher silently skips it; validate surfaces the omission')", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      await scaffoldComponent(projectRoot, "actions", "Broken", { noMarker: true });

      const manifest = await compileManifest(projectRoot);
      expect(manifest.components).toHaveLength(1);
      expect(manifest.components[0]?.name).toBe("Button");
    });

    it("returns an empty manifest (not an error) when components/ does not exist yet (fresh kit)", async () => {
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components).toEqual([]);
      expect(manifest.groups).toEqual([]);
    });

    it("returns an empty manifest when components/ exists but is empty", async () => {
      await mkdir(join(projectRoot, "components"), { recursive: true });
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components).toEqual([]);
      expect(manifest.groups).toEqual([]);
    });
  });

  // ─── AC3 — sibling meta.json join ────────────────────────────────────────

  describe("AC3: meta.json join", () => {
    it("joins subtitle + tags from a sibling meta.json when present", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", {
        viewport: "400x200",
        meta: { subtitle: "Primary action button", tags: ["cta", "primary"] },
      });
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components[0]).toMatchObject({
        subtitle: "Primary action button",
        tags: ["cta", "primary"],
      });
    });

    it("omits subtitle/tags entirely (not undefined-valued keys) when meta.json is absent", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      const manifest = await compileManifest(projectRoot);
      const card = manifest.components[0]!;
      expect("subtitle" in card).toBe(false);
      expect("tags" in card).toBe(false);
    });

    it("tolerates a malformed meta.json — degrades to no extra metadata rather than failing the compile", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", {
        viewport: "400x200",
        meta: "{ not valid json",
      });
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components).toHaveLength(1);
      expect("subtitle" in manifest.components[0]!).toBe(false);
    });

    it("tolerates a meta.json with the wrong shape (e.g. a JSON array) — degrades gracefully", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", {
        viewport: "400x200",
        meta: "[1,2,3]",
      });
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components).toHaveLength(1);
      expect("subtitle" in manifest.components[0]!).toBe(false);
    });
  });

  // ─── AC5 — hashing ────────────────────────────────────────────────────────

  describe("AC5: hashing", () => {
    it("hash is the sha256-<base64> SRI of the HTML file's exact bytes (matches list_files' format)", async () => {
      const htmlPath = await scaffoldComponent(projectRoot, "actions", "Button", {
        viewport: "400x200",
      });
      const bytes = await readFile(htmlPath);
      const manifest = await compileManifest(projectRoot);
      expect(manifest.components[0]?.hash).toBe(sriSha256(bytes));
    });

    it("hash is stable across repeated compiles of byte-identical content", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      const first = await compileManifest(projectRoot);
      const second = await compileManifest(projectRoot);
      expect(second.components[0]?.hash).toBe(first.components[0]?.hash);
    });

    it("hash changes when the file's content changes", async () => {
      const htmlPath = await scaffoldComponent(projectRoot, "actions", "Button", {
        viewport: "400x200",
      });
      const before = await compileManifest(projectRoot);
      await writeFile(
        htmlPath,
        '<!-- @genie group="actions" viewport="400x200" -->\n<div>changed</div>\n',
        "utf-8",
      );
      const after = await compileManifest(projectRoot);
      expect(after.components[0]?.hash).not.toBe(before.components[0]?.hash);
    });
  });

  // ─── AC6 — atomic write ───────────────────────────────────────────────────

  describe("AC6: atomic write", () => {
    it("persists to <projectRoot>/.genie/manifest.json", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      await compileManifest(projectRoot);
      const raw = await readFile(join(projectRoot, ".genie", "manifest.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
    });

    it("leaves no leftover .genie-tmp/ staging directory after a successful compile", async () => {
      // The actual staging location `writeManifestAtomic` uses (AC6) is
      // `${projectRoot}/.genie-tmp/manifest-*/`, NOT a `.genie/manifest.json.tmp`
      // sibling — asserting against the wrong path would pass trivially
      // whether or not cleanup actually worked. `readdir` on an absent/empty
      // dir both read as "nothing left behind".
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      await compileManifest(projectRoot);
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(join(projectRoot, ".genie-tmp")).catch(() => []);
      expect(entries).toEqual([]);
    });

    // The crash-mid-rename case (a failure between the tmp write and the
    // rename must leave the PRIOR manifest untouched) needs a real ESM-safe
    // fault injection into `node:fs/promises.rename` — `vi.spyOn` can't
    // redefine a named ESM export, and `vi.mock` is hoisted file-wide, so
    // that case lives in its own file (`compiler.atomic-write.test.ts`),
    // mirroring `tools/write_files.rollback.test.ts`'s established pattern
    // for the exact same constraint.

    it("calling compileManifest twice in a row succeeds (no leftover lock/tmp state blocks a second run)", async () => {
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "400x200" });
      await compileManifest(projectRoot);
      await expect(compileManifest(projectRoot)).resolves.toBeDefined();
    });
  });

  // ─── Group ordering: alphabetical, or pinned via _groups.json ───────────

  describe("group ordering", () => {
    it("orders groups alphabetically by default", async () => {
      await scaffoldComponent(projectRoot, "navigation", "Tabs", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "forms", "TextField", { viewport: "desktop" });

      const manifest = await compileManifest(projectRoot);
      expect(manifest.groups).toEqual(["actions", "forms", "navigation"]);
    });

    it("honours an explicit order from a root _groups.json sibling", async () => {
      await scaffoldComponent(projectRoot, "navigation", "Tabs", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "forms", "TextField", { viewport: "desktop" });
      await writeFile(
        join(projectRoot, "_groups.json"),
        JSON.stringify(["navigation", "actions", "forms"]),
        "utf-8",
      );

      const manifest = await compileManifest(projectRoot);
      expect(manifest.groups).toEqual(["navigation", "actions", "forms"]);
    });

    it("an incomplete _groups.json pin still includes every discovered group — pinned first, remainder alphabetical", async () => {
      await scaffoldComponent(projectRoot, "navigation", "Tabs", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "forms", "TextField", { viewport: "desktop" });
      await writeFile(join(projectRoot, "_groups.json"), JSON.stringify(["navigation"]), "utf-8");

      const manifest = await compileManifest(projectRoot);
      expect(manifest.groups).toEqual(["navigation", "actions", "forms"]);
    });

    it("tolerates a malformed _groups.json — falls back to alphabetical", async () => {
      await scaffoldComponent(projectRoot, "navigation", "Tabs", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "desktop" });
      await writeFile(join(projectRoot, "_groups.json"), "{ not an array", "utf-8");

      const manifest = await compileManifest(projectRoot);
      expect(manifest.groups).toEqual(["actions", "navigation"]);
    });
  });

  // ─── Card ordering: alphabetical by name, ties by path ──────────────────

  describe("card ordering", () => {
    it("sorts cards alphabetically by name within a group, ties by path", async () => {
      await scaffoldComponent(projectRoot, "actions", "Zeta", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "actions", "Alpha", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "actions", "Mid", { viewport: "desktop" });

      const manifest = await compileManifest(projectRoot);
      expect(manifest.components.map((c) => c.name)).toEqual(["Alpha", "Mid", "Zeta"]);
    });

    it("sorts by group first, then name — matching the shared compareComponents order used elsewhere", async () => {
      await scaffoldComponent(projectRoot, "navigation", "Tabs", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "actions", "Button", { viewport: "desktop" });

      const manifest = await compileManifest(projectRoot);
      expect(manifest.components.map((c) => `${c.group}/${c.name}`)).toEqual([
        "actions/Button",
        "navigation/Tabs",
      ]);
    });
  });

  // ─── AC7 — perf budget ────────────────────────────────────────────────────

  describe("AC7: performance", () => {
    it("compiles a 50-component kit (5 groups x 10) in < 100 ms", async () => {
      const groups = ["actions", "forms", "navigation", "feedback", "data"];
      for (const group of groups) {
        for (let i = 0; i < 10; i++) {
          const name = `Comp${group[0]!.toUpperCase()}${String(i).padStart(2, "0")}`;
          await scaffoldComponent(projectRoot, group, name, { viewport: "400x200" });
        }
      }

      const start = performance.now();
      const manifest = await compileManifest(projectRoot);
      const elapsedMs = performance.now() - start;

      expect(manifest.components).toHaveLength(50);
      expect(elapsedMs).toBeLessThan(100);
    });
  });

  // ─── Design Reference (AGENTS.md §3) ─────────────────────────────────────

  describe("Design Reference — 01-ui-kit-browser.svg", () => {
    // This module has no UI surface of its own to screenshot (it's a data
    // compiler; the grid/tree that RENDERS these groups is M4-03, not yet
    // built — same situation M3-01's marker.test.ts documents for the same
    // mock family). Validated structurally instead: the mock's left-sidebar
    // kit tree (docs/designs/design-6/01-ui-kit-browser.svg lines 44-61)
    // depicts a "PRIMITIVES · 6" section containing an alphabetically-first
    // "Button" row carrying the clay `@genie` marker glyph — i.e. cards must
    // (a) group under their marker's group, (b) sort alphabetically by name
    // within a group so "Button" leads its section, and (c) every carded
    // component implicitly passed the `@genie` marker check. This test pins
    // exactly that shape from this compiler's output.
    it("produces the PRIMITIVES-section shape the mock depicts: grouped, alphabetical, marker-verified", async () => {
      // Mirrors the mock's PRIMITIVES section membership (Button, Icon, Input,
      // Badge, Divider, Link) minus the ones this compiler doesn't need to
      // enumerate exhaustively — just enough to prove the ordering/grouping
      // contract the mock's tree relies on.
      await scaffoldComponent(projectRoot, "primitives", "Link", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "primitives", "Button", { viewport: "desktop" });
      await scaffoldComponent(projectRoot, "primitives", "Icon", { viewport: "desktop" });
      // A sibling group ("brand" in the mock) must not leak into PRIMITIVES.
      await scaffoldComponent(projectRoot, "brand", "BrandMark", { viewport: "desktop" });

      const manifest = await compileManifest(projectRoot);
      const primitives = manifest.components.filter((c) => c.group === "primitives");

      // (a) grouped correctly — brand's BrandMark is not among them.
      expect(primitives.map((c) => c.name)).not.toContain("BrandMark");
      // (b) alphabetical within the group — Button leads, matching the mock's
      // selected/first tree row.
      expect(primitives.map((c) => c.name)).toEqual(["Button", "Icon", "Link"]);
      // (c) every carded component is, by construction, marker-verified — a
      // card only exists in the output because compileManifest's marker
      // check (M3-01) passed for it.
      expect(manifest.groups).toContain("primitives");
      expect(manifest.groups).toContain("brand");
    });
  });
});
